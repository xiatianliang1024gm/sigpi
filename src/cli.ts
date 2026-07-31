#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
	type ChatCommandDefinition,
	createChatCommandDefinitions,
	executeChatCommand,
	formatDocumentedChatCommands,
} from "./chat-commands.js";
import {
	type ChatReplState,
	formatStatusBarForEvent,
	runtimeToChatReplState,
} from "./chat-repl.js";
import type { AppConfig } from "./config.js";
import {
	getDefaultProjectConfigPath,
	getDefaultUserConfigPath,
	initializeUserConfig,
	loadAppConfig,
	readDefaultProjectTrust,
} from "./config.js";
import { TurnInterruptController } from "./interrupt.js";
import { resolveDatedLogFilePath } from "./logger.js";
import { configureHttpProxy } from "./model/http-dispatcher.js";
import {
	type ProjectTrustResult,
	resolveProjectTrust,
	type TrustDecision,
} from "./project-trust.js";
import { createAgentRuntime, createRuntimeSessionStore } from "./runtime.js";
import { formatSessionDetails } from "./session/format.js";
import type { SessionStore } from "./session/store.js";
import { detectShellRuntime } from "./shell.js";
import type { ToolRegistry } from "./tools/registry.js";
import {
	type AssistantMessageView,
	ChatRenderer,
	type ReplView,
	type ToolLineHandle,
} from "./tui/chat-renderer.js";
import type { JsonValue, TurnProgressEvent } from "./types.js";

/**
 * Resolve the effective config and the project-trust decision for the
 * current working directory.
 *
 * The global config (which carries `defaultProjectTrust`) is always read
 * first. If the project is trusted — because there are no gated resources,
 * a per-run flag, a saved decision, or an interactive prompt — the project
 * `.sigpi/config.toml` override is merged on top. See ADR 0022.
 */
async function resolveConfigAndTrust(opts: {
	ui: boolean;
	approve?: boolean;
	noApprove?: boolean;
	prompt?: (dir: string) => Promise<TrustDecision | null>;
}): Promise<{ config: AppConfig; trust: ProjectTrustResult }> {
	const cwd = process.cwd();
	const homeDir = process.env.HOME ?? homedir();
	// Read the global default trust preference without validating the full
	// config: the only config source may be the still-gated project config,
	// which would otherwise fail model validation before trust is resolved.
	const defaultTrust = readDefaultProjectTrust(homeDir);
	const trust = await resolveProjectTrust({
		cwd,
		homeDir,
		defaultTrust,
		approve: opts.approve,
		noApprove: opts.noApprove,
		prompt: opts.ui ? opts.prompt : undefined,
	});
	const config = loadAppConfig({ readProjectConfig: trust.allows, homeDir });
	return { config, trust };
}

/**
 * Interactive project-trust prompt. Asks the user to trust the project's
 * local resources (skills + config override). Written to stderr so the
 * agent's stdout stream stays clean. Returns the chosen decision, or `null`
 * to decline.
 */
async function promptForTrust(dir: string): Promise<TrustDecision | null> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (
			await rl.question(
				`Trust project resources in ${dir}? [a]lways / [n]ever / [s]kip: `,
			)
		)
			.trim()
			.toLowerCase();
		if (answer === "a" || answer === "always") return "always";
		if (answer === "n" || answer === "never") return "never";
		return null;
	} finally {
		rl.close();
	}
}

function printTrustSkipWarning(cwd: string): void {
	console.error(
		`[trust] Skipping project-local resources (skills and .sigpi/config.toml) for ${cwd}: project not trusted. ` +
			'Use --approve to load them for this run, or set defaultProjectTrust = "always" in ~/.sigpi/config.toml.',
	);
}

function readPackageVersion(): string {
	const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
	return pkg.version ?? "(unknown)";
}

function printUsage(): void {
	console.log("Usage:");
	console.log(
		"  pnpm dev [chat] [--session <id>] [--continue] [--new] [--title <title>]",
	);
	console.log("  pnpm dev init [--force]");
	console.log("  pnpm dev config validate");
	console.log(
		'  pnpm dev ask [--session <id>] [--new] [--title <title>] [--approve | --no-approve] "your question"',
	);
	console.log("  pnpm dev session new [--title <title>]");
	console.log("  pnpm dev session list");
	console.log("  pnpm dev session show <id>");
	console.log("");
	console.log(`User config: ${getDefaultUserConfigPath()}`);
	console.log(`Project config: ${getDefaultProjectConfigPath()}`);
	console.log("");
	console.log(
		"`chat` is the default command: `sigpi` with no subcommand starts a chat. Use `--continue` to resume the most recent session for this project, or `--session <id>` to resume a specific one. Use `ask` for one-off prompts.",
	);
	console.log(`In chat: use ${formatDocumentedChatCommands()}.`);
}

async function runChatWithArgs(args: string[]): Promise<void> {
	const parsed = parseSessionArgs(args);
	const { config, trust } = await resolveConfigAndTrust({
		ui: true,
		approve: parsed.approve,
		noApprove: parsed.noApprove,
		prompt: promptForTrust,
	});
	// Make the model `fetch` proxy-aware (only installs when a proxy is
	// configured via [models.<id>] proxy or HTTP(S)_PROXY env). Returns a
	// status snapshot and prints a one-line notice to stderr.
	const proxyStatus = configureHttpProxy(
		config.model.proxy,
		config.model.timeoutMs,
	);
	const progressReporter = (event: TurnProgressEvent) => {
		activeStatusBarProgressListener?.(event);
	};
	const cleanupStore = createRuntimeSessionStore({
		cwd: process.cwd(),
		config,
	});
	const prunedSessionCount = await cleanupStore.pruneEmptySessions();

	// `--continue` attaches the most recent session for the current working
	// directory; if none exists, a fresh session is created.
	let resolvedSessionId = parsed.sessionId;
	if (parsed.continueSession) {
		const recent = await findMostRecentSession(cleanupStore);
		resolvedSessionId = recent?.sessionId;
	}

	const shouldCreateSession = !resolvedSessionId;
	const runtime = await createAgentRuntime({
		config,
		progressReporter,
		sessionId: resolvedSessionId,
		createSession: shouldCreateSession,
		sessionTitle: parsed.sessionTitle,
		includeProjectRoots: trust.allows,
	});
	runtime.logger.info(
		"http_proxy_status",
		proxyStatus as unknown as Record<string, JsonValue | undefined>,
	);
	if (trust.skipped) {
		printTrustSkipWarning(process.cwd());
	}
	const state = runtimeToChatReplState(runtime);

	printSkillBootstrap(
		runtime.loadedSkills.length,
		runtime.skillWarnings.map((warning) => warning.message),
	);

	console.log(`Logs: ${resolveDatedLogFilePath(config.logging.filePath)}`);
	console.log(
		`Shell: ${state.shellRuntime.shell} on ${state.shellRuntime.platform}`,
	);
	if (prunedSessionCount > 0) {
		console.log(`Pruned ${prunedSessionCount} empty session(s).`);
	}
	if (runtime.session) {
		console.log(`Session: ${runtime.session.sessionId}`);
	}
	for (const warning of state.runtime.sessionWarnings) {
		console.log(`[session-warning] ${warning}`);
	}

	const finalState = await runChatReplLoop(
		{
			state,
			store: runtime.store,
			progressReporter,
			tools: runtime.tools,
		},
		{
			commands: createChatCommandDefinitions({
				backgroundTaskManager: runtime.backgroundTasks,
				loadedSkills: runtime.loadedSkills,
			}),
		},
	);

	// Print a copy-pasteable hint so the user can resume this session later.
	const exitedSessionId =
		finalState.runtime.session?.sessionId ?? runtime.session?.sessionId;
	if (exitedSessionId) {
		console.log("");
		console.log(
			`To continue this session, run: sigpi --session ${exitedSessionId}`,
		);
	}
}

export interface RunChatReplLoopOptions {
	state: ChatReplState;
	store: SessionStore;
	progressReporter?: (event: TurnProgressEvent) => void;
	tools?: ToolRegistry;
}

export interface RunChatReplLoopDependencies {
	commands: readonly ChatCommandDefinition[];
}

let activeStatusBarProgressListener:
	| ((event: TurnProgressEvent) => void)
	| null = null;

/**
 * Apply one turn-progress event to the persistent REPL view. Returns the
 * current in-flight assistant-message view so the caller can thread it across
 * events within a turn, and a map of in-flight tool-line handles keyed by
 * tool-call id so the caller can resolve them on finish/fail.
 *
 * Each model response (one per agent step) gets its OWN assistant component,
 * created lazily on the first content/reasoning delta and finalized at the
 * step boundary (`model_request_finished` / `assistant_message` / terminal
 * events). This keeps every step's answer in a component appended in
 * chronological order — so the final conclusion lands AFTER the step's tool
 * results — and, crucially, never leaves a finalized component receiving a
 * later step's deltas. `AssistantMessageComponent.finalize()` locks the
 * component so further `appendContent`/`appendReasoning` calls are silently
 * dropped; an earlier design created a single component at turn start and
 * finalized it after the first step, so every later step's text (including
 * the final answer) was dropped and never rendered.
 */
export function applyTurnProgress(
	view: ReplView,
	event: TurnProgressEvent,
	currentAssistant: AssistantMessageView | null,
	toolLines: Map<string, ToolLineHandle>,
): AssistantMessageView | null {
	if (event.type === "model_delta") {
		const assistant = currentAssistant ?? view.beginAssistantMessage();
		if (event.reasoningDelta) {
			assistant.appendReasoning(event.reasoningDelta);
		}
		if (event.contentDelta) {
			assistant.appendContent(event.contentDelta);
		}
		return assistant;
	}

	if (event.type === "tool_execution_started" && event.toolName) {
		const id = event.toolCallId;
		if (id) {
			const handle = view.beginToolLine(
				id,
				event.message ?? event.toolName,
				event.toolName,
			);
			toolLines.set(id, handle);
		}
		return currentAssistant;
	}

	if (event.type === "tool_execution_finished" && event.toolName) {
		const id = event.toolCallId || "";
		const handle = toolLines.get(id);
		if (handle) {
			toolLines.delete(id);
			if (event.toolOk === true) {
				handle.finish();
			} else {
				handle.finish();
				const errorMsg = event.toolResult ?? event.message ?? "failed";
				view.appendSystem(errorMsg, "error");
			}
		}
		return currentAssistant;
	}

	if (
		event.type === "model_request_finished" ||
		event.type === "assistant_message" ||
		event.type === "turn_interrupted" ||
		event.type === "turn_failed" ||
		event.type === "turn_max_steps_reached"
	) {
		currentAssistant?.finalize();
		// Finalize any remaining in-flight tool lines on terminal events.
		for (const handle of toolLines.values()) {
			handle.fail("interrupted");
		}
		toolLines.clear();
		return null;
	}

	return currentAssistant;
}

export async function runChatReplLoop(
	options: RunChatReplLoopOptions,
	dependencies: RunChatReplLoopDependencies,
): Promise<ChatReplState> {
	let state = options.state;
	const commands = dependencies.commands;
	const statusBar = await formatStatusBarForEvent(state, null);
	const view = new ChatRenderer({
		statusBarModel: statusBar,
		commands,
	});
	view.start();
	state.view = view;

	const readInput = (): Promise<string | null> => view.readInput();
	const writeLine = (line: string) => view.writeLine(line);
	const writeError = (line: string) => view.writeError(line);

	const queuedLines: string[] = [];
	let latestProgressEvent: TurnProgressEvent | null = null;
	let currentAssistant: AssistantMessageView | null = null;
	let toolLines: Map<string, ToolLineHandle> = new Map();

	const refreshStatusBar = async (
		event: TurnProgressEvent | null = latestProgressEvent,
	): Promise<void> => {
		view.setStatusBarModel(await formatStatusBarForEvent(state, event));
	};

	const viewProgressListener = (event: TurnProgressEvent) => {
		latestProgressEvent = event;
		void refreshStatusBar(event);
		currentAssistant = applyTurnProgress(
			view,
			event,
			currentAssistant,
			toolLines,
		);
	};
	activeStatusBarProgressListener = viewProgressListener;

	while (true) {
		const queuedLine = queuedLines.shift();
		const line = queuedLine ?? (await readInput());
		if (line === null) {
			break;
		}

		const trimmedLine = line.trim();
		if (!trimmedLine) {
			continue;
		}
		view.addUserMessage(line);

		const commandResult = await executeChatCommand(line, commands, {
			getState: () => state,
			setState: (updatedState) => {
				state = updatedState;
				latestProgressEvent = null;
			},
			store: options.store,
			progressReporter: viewProgressListener,
			writeLine,
		});

		if (commandResult.kind === "unknown-command") {
			writeLine(`Unknown command: ${commandResult.rawName}`);
			continue;
		}

		if (commandResult.kind === "handled" && commandResult.action === "exit") {
			break;
		}

		const turnInput =
			commandResult.kind === "handled" && commandResult.action === "run-turn"
				? commandResult.input
				: commandResult.kind === "not-a-command"
					? line
					: null;

		if (turnInput == null) {
			continue;
		}

		const interruptController = new TurnInterruptController();
		latestProgressEvent = null;
		toolLines = new Map();
		currentAssistant = null;
		view.beginTurn(() => {
			const interrupt = interruptController.requestInterrupt();
			if (!interrupt.accepted || interrupt.alreadyRequested) {
				return;
			}
			const message =
				interrupt.stage === "model"
					? "Cancelling current model request"
					: "Interrupt requested; waiting for current tool to finish";
			if (options.progressReporter) {
				const event = {
					type: "interrupt_requested",
					message,
					interruptStage: interrupt.stage ?? undefined,
					interruptSource: "user_escape",
				} satisfies TurnProgressEvent;
				latestProgressEvent = event;
				void refreshStatusBar(event);
				options.progressReporter(event);
				return;
			}
			writeLine(`[agent] ${message}`);
		});

		const turn = await state.runtime.turn.runTurn(
			turnInput,
			state.runtime.logger,
			interruptController,
		);
		view.endTurn();
		currentAssistant = null;
		toolLines.clear();
		queuedLines.push(...view.takeQueuedLines());

		latestProgressEvent = null;
		if (!turn.ok) {
			writeError(turn.errorMessage);
			continue;
		}

		if (turn.completionStatus === "interrupted") {
		}
	}

	view.stop();
	return state;
}

async function runSessionCommand(args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	const parsed = parseSessionArgs(rest);
	const { config, trust } = await resolveConfigAndTrust({
		ui: false,
		approve: parsed.approve,
		noApprove: parsed.noApprove,
	});
	const runtime = await createAgentRuntime({
		config,
		includeProjectRoots: trust.allows,
	});
	if (trust.skipped) {
		printTrustSkipWarning(process.cwd());
	}
	const { store } = runtime;
	printSkillBootstrap(
		runtime.loadedSkills.length,
		runtime.skillWarnings.map((warning) => warning.message),
	);

	if (subcommand === "new") {
		const parsed = parseSessionArgs(rest);
		const created = await store.createSession({
			cwd: process.cwd(),
			systemPromptFingerprint: runtime.systemPromptFingerprint,
			title: parsed.sessionTitle,
			loadedSkillNames: runtime.loadedSkills.map((skill) => skill.name),
			skillsFingerprint: runtime.skillsFingerprint,
		});
		console.log(created.sessionId);
		return;
	}

	if (subcommand === "list") {
		const sessions = await store.listSessions();
		console.log(JSON.stringify(sessions, null, 2));
		return;
	}

	if (subcommand === "show") {
		const sessionId = rest[0]?.trim();

		if (!sessionId) {
			throw new Error(
				"Missing session id. Example: pnpm dev session show <id>",
			);
		}

		const session = await store.getSession(sessionId);
		console.log(JSON.stringify(formatSessionDetails(session), null, 2));
		return;
	}

	throw new Error(`Unknown session command: ${subcommand ?? "(missing)"}`);
}

function printSkillBootstrap(skillCount: number, warnings: string[]): void {
	console.log(
		`[skills] loaded ${skillCount} skill(s), ${warnings.length} warning(s)`,
	);
	for (const warning of warnings) {
		console.log(`[skills-warning] ${warning}`);
	}
}

function parseSessionArgs(args: string[]): {
	sessionId?: string;
	createSession: boolean;
	continueSession: boolean;
	sessionTitle?: string;
	approve: boolean;
	noApprove: boolean;
	rest: string[];
} {
	const rest: string[] = [];
	let sessionId: string | undefined;
	let createSession = false;
	let continueSession = false;
	let sessionTitle: string | undefined;
	let approve = false;
	let noApprove = false;

	for (let index = 0; index < args.length; index += 1) {
		const value = args[index];

		if (value === "--session") {
			sessionId = args[index + 1];
			index += 1;
			continue;
		}

		if (value === "--new") {
			createSession = true;
			continue;
		}

		if (value === "--continue") {
			continueSession = true;
			continue;
		}

		if (value === "--approve" || value === "-a") {
			approve = true;
			continue;
		}

		if (value === "--no-approve" || value === "-na") {
			noApprove = true;
			continue;
		}

		if (value === "--title") {
			sessionTitle = args[index + 1];
			index += 1;
			continue;
		}

		if (value) {
			rest.push(value);
		}
	}

	if (sessionId && createSession) {
		throw new Error("Use either --session or --new, not both.");
	}

	if (approve && noApprove) {
		throw new Error("--approve and --no-approve cannot be combined.");
	}

	return {
		sessionId,
		createSession,
		continueSession,
		sessionTitle,
		approve,
		noApprove,
		rest,
	};
}

/**
 * Returns the most recently updated session for the current working directory,
 * or `null` if there are no sessions yet. The store is already scoped to the
 * cwd (sessions are partitioned per project directory), so the index is the
 * right source of truth and is sorted newest-first.
 */
async function findMostRecentSession(
	store: SessionStore,
): Promise<{ sessionId: string } | null> {
	const sessions = await store.listSessions();
	return sessions[0] ? { sessionId: sessions[0].sessionId } : null;
}

async function runInitCommand(args: string[]): Promise<void> {
	const overwrite = args.includes("--force");
	const unknownArgs = args.filter((arg) => arg !== "--force");

	if (unknownArgs.length > 0) {
		throw new Error(`Unknown init option: ${unknownArgs[0]}`);
	}

	const result = await initializeUserConfig({ overwrite });

	if (!result.created) {
		console.log(`Config already exists: ${result.configPath}`);
		console.log("Use `pnpm dev init --force` to overwrite it.");
		return;
	}

	console.log(`Created config: ${result.configPath}`);
	console.log(
		"Edit the [model] and [models.*] sections before running chat or ask.",
	);
}

async function runConfigCommand(args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	const parsed = parseSessionArgs(rest);

	if (subcommand !== "validate" || parsed.rest.length > 0) {
		throw new Error(
			`Unknown config command: ${[subcommand ?? "(missing)", ...rest].join(" ")}`,
		);
	}

	const { config, trust } = await resolveConfigAndTrust({
		ui: false,
		approve: parsed.approve,
		noApprove: parsed.noApprove,
	});
	const shellRuntime = detectShellRuntime(config.shell);
	console.log(
		JSON.stringify(
			{
				ok: true,
				modelId: config.modelId,
				model: {
					baseURL: config.model.baseURL,
					apiKey: redactSecret(config.model.apiKey),
					name: config.model.name,
					apiFormat: config.model.apiFormat,
					timeoutMs: config.model.timeoutMs,
					maxRetries: config.model.maxRetries,
				},
				models: Object.fromEntries(
					Object.entries(config.models).map(([id, model]) => [
						id,
						{
							baseURL: model.baseURL,
							apiKey: redactSecret(model.apiKey),
							name: model.name,
							apiFormat: model.apiFormat,
							timeoutMs: model.timeoutMs,
							maxRetries: model.maxRetries,
						},
					]),
				),
				agent: config.agent,
				logging: {
					...config.logging,
					datedFilePath: resolveDatedLogFilePath(config.logging.filePath),
				},
				storage: config.storage,
				shell: shellRuntime,
				tools: config.tools,
				trust: config.trust,
				projectTrust: {
					allowsProjectResources: trust.allows,
					reason: trust.reason,
				},
			},
			null,
			2,
		),
	);
}

function redactSecret(value: string): string {
	if (value.length <= 4) {
		return "****";
	}
	return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);

	// No command defaults to interactive chat (same as the `chat` subcommand).
	if (!command) {
		await runChatWithArgs(rest);
		return;
	}

	if (command === "help" || command === "--help") {
		printUsage();
		return;
	}

	if (command === "--version" || command === "-v") {
		console.log(readPackageVersion());
		return;
	}

	// `chat` is the default subcommand: `sigpi` with no subcommand (or a
	// top-level flag like --continue / --session) starts an interactive chat.
	if (
		command === "chat" ||
		command.startsWith("--") ||
		command === "init" ||
		command === "config" ||
		command === "session"
	) {
		if (command === "init") {
			await runInitCommand(rest);
			return;
		}
		if (command === "config") {
			await runConfigCommand(rest);
			return;
		}
		if (command === "session") {
			await runSessionCommand(rest);
			return;
		}
		// `chat` or a bare top-level flag: default to chat.
		await runChatWithArgs(command === "chat" ? rest : [command, ...rest]);
		return;
	}

	throw new Error(`Unknown command: ${command}`);
}

// Only run the CLI when this module is the process entry point. Importing it
// from tests (e.g. to reuse `runChatReplLoop`) must not start the REPL loop,
// which would keep the event loop alive and hang the test runner.
const invokedAsEntryPoint =
	process.argv[1] !== undefined &&
	realpathSync(process.argv[1]) ===
		realpathSync(fileURLToPath(import.meta.url));

if (invokedAsEntryPoint) {
	main().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Error: ${message}`);
		if (process.env.TINYPI_DEBUG_STACK === "1" && error instanceof Error) {
			console.error(error.stack);
		}
		process.exitCode = 1;
	});
}

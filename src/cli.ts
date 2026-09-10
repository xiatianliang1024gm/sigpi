#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
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
	getCurrentWorkingDirectory,
	runtimeToChatReplState,
} from "./chat-repl.js";
import type { AppConfig } from "./config.js";
import {
	getDefaultUserConfigPath,
	initializeUserConfig,
	loadAppConfig,
} from "./config.js";
import {
	onBranchChange,
	startBranchWatcher,
	stopBranchWatcher,
} from "./git.js";
import { resolveDatedLogFilePath } from "./logger.js";
import { configureHttpProxy } from "./model/http-dispatcher.js";
import { createAgentRuntime, createRuntimeSessionStore } from "./runtime.js";
import { runServeCommand } from "./server/serve.js";
import { SessionController } from "./session/controller.js";
import {
	accumulateTurnStats,
	applyTurnProgress,
	createReplRunStats,
	formatReplRunSummary,
	isTurnTerminalEvent,
	type ReplRunStats,
} from "./session/events.js";
import type { SessionStore } from "./session/store.js";
import { detectShellRuntime } from "./shell.js";
import type { ToolRegistry } from "./tools/registry.js";
import {
	type AssistantMessageView,
	ChatRenderer,
	type ToolLineHandle,
} from "./tui/chat-renderer.js";
import { getStatusEventLabel, type LastTurnStats } from "./tui/status-bar.js";
import { replaySessionIntoView } from "./tui/transcript-replay.js";
import type { JsonValue, TurnProgressEvent } from "./types.js";

/**
 * Resolve the effective config for the current working directory. The global
 * `~/.sigpi/config.toml` is merged with the project `.sigpi/config.toml`
 * override (if present); project skills are always loaded.
 */
function resolveConfig(): AppConfig {
	const homeDir = process.env.HOME ?? homedir();
	return loadAppConfig({ homeDir });
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
	console.log("  pnpm dev session new [--title <title>]");
	console.log("  pnpm dev session list");
	console.log(
		"  pnpm dev serve [--host <host>] [--port <port>] [--idle-ttl <ms>] [--max-sessions <n>]",
	);
	console.log("");
	console.log(`User config: ${getDefaultUserConfigPath()}`);
	console.log("");
	console.log(
		"`chat` is the default command: `sigpi` with no subcommand starts a chat. Use `--continue` to resume the most recent session for this project, or `--session <id>` to resume a specific one.",
	);
	console.log(`In chat: use ${formatDocumentedChatCommands()}.`);
}

async function runChatWithArgs(args: string[]): Promise<void> {
	const parsed = parseSessionArgs(args);
	const config = resolveConfig();
	// Make the model `fetch` proxy-aware (only installs when a proxy is
	// configured via [models.<id>] proxy or HTTP(S)_PROXY env). Returns a
	// status snapshot and prints a one-line notice to stderr.
	const proxyStatus = configureHttpProxy(
		config.model.proxy,
		config.model.timeoutMs,
	);
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
		sessionId: resolvedSessionId,
		createSession: shouldCreateSession,
		sessionTitle: parsed.sessionTitle,
	});
	runtime.logger.info(
		"http_proxy_status",
		proxyStatus as unknown as Record<string, JsonValue | undefined>,
	);
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
			tools: runtime.tools,
		},
		{
			commands: createChatCommandDefinitions({
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

interface RunChatReplLoopOptions {
	state: ChatReplState;
	store: SessionStore;
	tools?: ToolRegistry;
}

interface RunChatReplLoopDependencies {
	commands: readonly ChatCommandDefinition[];
}

/**
 * While the REPL is running, periodically rebuild the status bar from the
 * current state even when nothing else is happening. This keeps
 * externally-driven changes (e.g. `git checkout` in another terminal) from
 * freezing the bar at the last turn's values until the user next talks.
 * The git branch lookup inside the rebuild is TTL-cached, so this costs at
 * most one short-lived `git` spawn per interval.
 */
const STATUS_BAR_REFRESH_INTERVAL_MS = 5_000;

/**
 * Live turn-clock tick. While a turn is in flight the status bar refreshes
 * once per second so the elapsed timer visibly advances (e.g. `thinking · 4s`).
 * 1s is the right cadence: model deltas and tool events already refresh far
 * more often during streaming, so this only covers quiet gaps (long-running
 * tools, slow providers); a 500ms tick would double the render churn for no
 * visible difference, and 2s+ reads as a frozen clock.
 */
const TURN_STATUS_REFRESH_INTERVAL_MS = 1_000;

export type { ReplRunStats };
// Re-exported for back-compat: these UI-neutral helpers now live in
// `session/events.ts`, shared by the TUI and any headless frontend. Existing
// importers (and tests) keep resolving them from `cli.js`.
export {
	accumulateTurnStats,
	applyTurnProgress,
	createReplRunStats,
	formatReplRunSummary,
};

async function runChatReplLoop(
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
	// When the loop attaches an existing session (via `--session <id>` or
	// `--continue`), replay its message stream into the terminal so the
	// conversation history is visible in place. A fresh session has no
	// entries, so this is a no-op there.
	replaySessionIntoView(state.view, state.runtime.session, state.runtime.tools);

	const readInput = (): Promise<string | null> => view.readInput();
	const writeLine = (line: string) => view.writeLine(line);
	const writeError = (line: string) => view.writeError(line);

	const queuedLines: string[] = [];
	let latestProgressEvent: TurnProgressEvent | null = null;
	let currentAssistant: AssistantMessageView | null = null;
	let toolLines: Map<string, ToolLineHandle> = new Map();
	// Epoch ms of the in-flight turn (user submit → terminal event). While
	// set, the status bar renders a live elapsed clock; `null` when idle.
	let turnStartedAt: number | null = null;
	// Final stats of the most recently finished turn, shown on the bar until
	// the next turn starts.
	let lastTurnStats: LastTurnStats | null = null;
	// Cumulative usage across every turn in this run, printed on exit.
	const runStats = createReplRunStats();

	const refreshStatusBar = async (
		event: TurnProgressEvent | null = latestProgressEvent,
	): Promise<void> => {
		view.setStatusBarModel(
			await formatStatusBarForEvent(state, event, {
				turnStartedAt,
				lastTurnStats,
			}),
		);
	};

	const viewProgressListener = (event: TurnProgressEvent) => {
		latestProgressEvent = event;
		if (isTurnTerminalEvent(event)) {
			// The turn is over: freeze the clock and keep the final
			// elapsed/token totals on the bar until the next turn.
			turnStartedAt = null;
			lastTurnStats = {
				label: getStatusEventLabel(event) ?? "done",
				elapsedMs: event.elapsedMs,
				// Cumulative provider-reported usage across the turn's model
				// requests (every tool step re-sends the context, so this
				// billing figure runs well above the bar's left segment).
				tokens: event.usage,
			};
			accumulateTurnStats(runStats, event);
		}
		void refreshStatusBar(event);
		currentAssistant = applyTurnProgress(
			view,
			event,
			currentAssistant,
			toolLines,
		);
	};
	// The SessionController owns the turn lifecycle + interrupt wiring; the TUI
	// only subscribes to its unified progress stream (and re-points it on a
	// runtime swap). A web frontend would hold the same controller and consume
	// the identical event stream.
	const controller = new SessionController(state.runtime);
	const unsubscribeProgress = controller.onProgress(viewProgressListener);

	// Idle refresh: keep the bar honest between turns (see the constant's
	// doc comment). Cleared on the loop's single exit path below.
	const statusBarRefreshTimer = setInterval(() => {
		void refreshStatusBar();
	}, STATUS_BAR_REFRESH_INTERVAL_MS);

	// Live turn clock: tick once per second while a turn is in flight (see
	// the constant's doc comment). No-op when idle; cleared on exit below.
	const turnStatusTimer = setInterval(() => {
		if (turnStartedAt !== null) {
			void refreshStatusBar();
		}
	}, TURN_STATUS_REFRESH_INTERVAL_MS);

	// Background git branch sampler: feeds the status bar's branch segment
	// through a cached variable instead of spawning git on every refresh (see
	// git.ts). Cleared on the loop's single exit path below.
	startBranchWatcher(getCurrentWorkingDirectory(state));
	// Repaint the bar as soon as the branch is known (or changes): the first
	// sample lands shortly after start, well before the 5s idle refresh would
	// pick it up, and the HEAD watch makes subsequent switches near-instant.
	const unsubscribeBranchChange = onBranchChange(() => {
		void refreshStatusBar();
	});

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
				// The live ChatRenderer is owned by this loop. Commands that
				// replace the state (e.g. /new, /resume) build it via
				// `runtimeToChatReplState`, which starts with `view: null`;
				// pinning the live view here keeps `/resume` and `/model`
				// reusing this TUI instead of spawning a second
				// ProcessTerminal on process.stdin (whose stop() pauses
				// stdin and freezes the REPL).
				state = { ...updatedState, view };
				// A new runtime (e.g. /new, /resume) is driven by the same
				// controller: `setRuntime` re-binds its internal runner
				// subscription, so the view's single `onProgress` keeps working
				// without re-wiring.
				controller.setRuntime(updatedState.runtime);
				latestProgressEvent = null;
				// The state changed (e.g. /model, /new, /resume): the previous
				// turn's clock/stats no longer apply to the new context.
				turnStartedAt = null;
				lastTurnStats = null;
				// The state changed (e.g. /model, /new, /resume): rebuild the
				// status bar immediately from the fresh state instead of
				// letting it show the previous session/model until the next
				// turn-progress event.
				void refreshStatusBar();
			},
			store: options.store,
			writeLine,
		});

		if (commandResult.kind === "unknown-command") {
			writeLine(`Unknown command: ${commandResult.rawName}`);
			continue;
		}

		if (commandResult.kind === "handled" && commandResult.action === "exit") {
			break;
		}

		if (commandResult.kind === "handled") {
			// Commands that mutate the conversation (e.g. /compact) change
			// the context window immediately; refresh the bar now instead of
			// letting it show the stale size until the 5s idle timer fires.
			void refreshStatusBar();
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

		latestProgressEvent = null;
		toolLines = new Map();
		currentAssistant = null;
		// Start the turn clock at user submit and drop the previous turn's
		// stats: the bar now shows the live elapsed timer instead.
		turnStartedAt = Date.now();
		lastTurnStats = null;
		// Esc/Ctrl+C during a turn asks the controller to interrupt it; the
		// synthetic `interrupt_requested` event flows through the same stream.
		view.beginTurn(() => {
			controller.requestInterrupt();
		});

		const turn = await controller.submit(turnInput);
		view.endTurn();
		currentAssistant = null;
		toolLines.clear();
		queuedLines.push(...view.takeQueuedLines());

		latestProgressEvent = null;
		// Defensive: the terminal event normally stops the clock, but if the
		// runner ever returns without one (an error before its own try block),
		// stop the clock here rather than leave a stuck ticking timer.
		turnStartedAt = null;
		if (!turn.ok) {
			writeError(turn.errorMessage);
		}
	}

	view.stop();
	clearInterval(statusBarRefreshTimer);
	clearInterval(turnStatusTimer);
	unsubscribeProgress();
	unsubscribeBranchChange();
	stopBranchWatcher();
	// The terminal is restored, so a plain stdout line is safe here. Print
	// the run's cumulative agent time and billed tokens (no-op on an empty
	// session with no turns).
	const runSummary = formatReplRunSummary(runStats);
	if (runSummary) {
		console.log(runSummary);
	}
	return state;
}

async function runSessionCommand(args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	const config = resolveConfig();
	const runtime = await createAgentRuntime({ config });
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
	rest: string[];
} {
	const rest: string[] = [];
	let sessionId: string | undefined;
	let createSession = false;
	let continueSession = false;
	let sessionTitle: string | undefined;

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

	return {
		sessionId,
		createSession,
		continueSession,
		sessionTitle,
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
	console.log("Edit the [model] and [models.*] sections before running chat.");
}

async function runConfigCommand(args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	const parsed = parseSessionArgs(rest);

	if (subcommand !== "validate" || parsed.rest.length > 0) {
		throw new Error(
			`Unknown config command: ${[subcommand ?? "(missing)", ...rest].join(" ")}`,
		);
	}

	const config = resolveConfig();
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
		command === "session" ||
		command === "serve"
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
		if (command === "serve") {
			await runServeCommand(rest);
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

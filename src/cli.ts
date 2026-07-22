#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import { fileURLToPath } from "node:url";
import type { TurnResult } from "./agent/turn.js";
import {
	type ChatCommandDefinition,
	type ChatCommandMetadata,
	createChatCommandDefinitions,
	executeChatCommand,
	formatDocumentedChatCommands,
} from "./chat-commands.js";
import { readChatInput } from "./chat-input.js";
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
	formatPlanProgressSummary,
	formatUpdatePlanBody,
	getCurrentPlan,
	parsePlanArgs,
	renderPlanFull,
	setCurrentPlan,
} from "./plan-tracker.js";
import {
	type ProjectTrustResult,
	resolveProjectTrust,
	type TrustDecision,
} from "./project-trust.js";
import { createAgentRuntime, createRuntimeSessionStore } from "./runtime.js";
import { formatSessionDetails } from "./session/format.js";
import { InMemorySessionStore } from "./session/in-memory-store.js";
import type { SessionStore } from "./session/store.js";
import { detectShellRuntime } from "./shell.js";
import type { ToolRegistry } from "./tools/registry.js";
import {
	type AssistantMessageView,
	ChatRenderer,
	type ReplView,
} from "./tui/chat-renderer.js";
import {
	formatFileEditResultData,
	formatFileEditSummaries,
} from "./tui/file-edit-renderer.js";
import type {
	ExecutedToolCall,
	JsonValue,
	ProcessOutputMode,
	RuntimeLogger,
	TurnProgressEvent,
} from "./types.js";

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

async function runAsk(args: string[]): Promise<void> {
	const parsed = parseSessionArgs(args);
	const prompt = parsed.rest.join(" ").trim();

	if (!prompt) {
		throw new Error('Missing prompt. Example: pnpm dev ask "What time is it?"');
	}

	const { config, trust } = await resolveConfigAndTrust({
		ui: false,
		approve: parsed.approve,
		noApprove: parsed.noApprove,
	});
	// Make the model `fetch` proxy-aware (only installs when a proxy is
	// configured via [models.<id>] proxy or HTTP(S)_PROXY env). Returns a
	// status snapshot and prints a one-line notice to stderr.
	const proxyStatus = configureHttpProxy(
		config.model.proxy,
		config.model.timeoutMs,
	);
	const progressReporter = createCliProgressReporter(
		config.agent.processOutput,
	);
	// One-shot prompts persist a session by default (aligns with Claude Code /
	// Codex / Pi). `--no-session` opts out via an in-memory store.
	const store: SessionStore | undefined = parsed.noSession
		? new InMemorySessionStore()
		: undefined;
	const runtime = await createAgentRuntime({
		config,
		progressReporter,
		sessionId: parsed.sessionId,
		createSession:
			parsed.createSession || (!parsed.sessionId && !parsed.noSession),
		sessionTitle: parsed.sessionTitle,
		store,
		includeProjectRoots: trust.allows,
	});
	runtime.logger.info(
		"http_proxy_status",
		proxyStatus as unknown as Record<string, JsonValue | undefined>,
	);
	if (trust.skipped) {
		printTrustSkipWarning(process.cwd());
	}
	printSkillBootstrap(
		runtime.loadedSkills.length,
		runtime.skillWarnings.map((warning) => warning.message),
	);
	const result = await runtime.turn.runTurn(prompt, runtime.logger);

	if (!result.ok) {
		console.error(result.errorMessage);
		process.exitCode = 1;
		return;
	}

	if (runtime.sessionRuntime) {
		const askSessionId = runtime.sessionRuntime.getCurrentSession().sessionId;
		console.log(`[session] ${askSessionId}`);
		console.log(
			`To continue this session, run: sigpi --session ${askSessionId}`,
		);
	}
	console.log("");
	printResult(
		result.outputText ?? "",
		result.toolExecutions,
		config.agent.processOutput !== "compact",
	);
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
	const progressReporter = createCliProgressReporter(
		config.agent.processOutput,
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

	console.log("Interactive chat started.");

	const finalState = await runChatReplLoop(
		{
			state,
			store: runtime.store,
			progressReporter,
			processOutputMode: config.agent.processOutput,
			input,
			output,
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

function printResult(
	outputText: string,
	toolExecutions: ExecutedToolCall[],
	toolResultsAlreadyStreamed = false,
	writeLine: (line: string) => void = (line) => console.log(line),
): void {
	if (!toolResultsAlreadyStreamed) {
		for (const line of formatFileEditSummaries(toolExecutions)) {
			writeLine(line);
		}
	}

	writeLine(outputText);
}

export interface RunChatReplLoopOptions {
	state: ChatReplState;
	store: SessionStore;
	progressReporter?: (event: TurnProgressEvent) => void;
	processOutputMode?: ProcessOutputMode;
	input?: ReadStream;
	output?: WriteStream;
	prompt?: string;
	tools?: ToolRegistry;
}

export interface RunChatReplLoopDependencies {
	readChatInput?: typeof readChatInput;
	executeTurn?: (
		state: ChatReplState,
		input: string,
		logger: RuntimeLogger,
		interruptController?: TurnInterruptController,
	) => Promise<TurnResult>;
	commands?: readonly ChatCommandDefinition[];
	writeLine?: (line: string) => void;
	writeError?: (line: string) => void;
	tools?: ToolRegistry;
}

const compactState: CompactProgressRenderState = {
	hasPrintedTurn: false,
	groupActive: false,
};
let activeStatusBarProgressListener:
	| ((event: TurnProgressEvent) => void)
	| null = null;
const ANSI_RESET = "\x1B[0m";
const ANSI_BOLD = "\x1B[1m";
const ANSI_DIM = "\x1B[2m";
const ANSI_RED = "\x1B[31m";
const ANSI_GREEN = "\x1B[32m";
const ANSI_YELLOW = "\x1B[33m";
const ANSI_BLUE = "\x1B[34m";
const ANSI_MAGENTA = "\x1B[35m";
const ANSI_CYAN = "\x1B[36m";
const DEFAULT_RULE_WIDTH = 80;

interface ClearProgressRenderState {
	hasPrintedToolInTurn: boolean;
	modelRequestCountInTurn: number;
}

interface CompactProgressRenderState {
	hasPrintedTurn: boolean;
	groupActive: boolean;
}

/**
 * Apply one turn-progress event to the persistent REPL view. Returns the
 * current in-flight assistant-message view so the caller can thread it across
 * events within a turn.
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

	if (event.type === "tool_execution_finished" && event.toolName) {
		const body = event.toolResult ?? event.message ?? "";
		view.addToolResult(body, event.toolName, event.toolResultData);
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
		return null;
	}

	return currentAssistant;
}

export async function runChatReplLoop(
	options: RunChatReplLoopOptions,
	dependencies: RunChatReplLoopDependencies = {},
): Promise<ChatReplState> {
	let state = options.state;
	const replInput = options.input ?? input;
	const replOutput = options.output ?? output;
	const useTui = replInput.isTTY && replOutput.isTTY;

	const executeTurn =
		dependencies.executeTurn ??
		((s, inp, logger, interruptController) =>
			s.runtime.turn.runTurn(inp, logger, interruptController));
	const commands =
		dependencies.commands ??
		createChatCommandDefinitions({
			loadedSkills: options.state.runtime.loadedSkills,
		});

	// Output surface: one persistent Pi-tui `TUI` (TTY, ADR 0025 A1) or a console
	// fallback (non-TTY / one-shot). The progress reporter renders to the view
	// instead of `console.log` while the `TUI` is alive, avoiding viewport desync.
	let view: ReplView;
	if (useTui) {
		const renderer = new ChatRenderer({
			input: replInput,
			output: replOutput,
			prompt: options.prompt,
			commands,
		});
		renderer.start();
		view = renderer;
	} else {
		view = new ConsoleReplView({
			input: replInput,
			output: replOutput,
			prompt: options.prompt,
			commands,
			readChatInput: dependencies.readChatInput,
			writeLine: dependencies.writeLine,
			writeError: dependencies.writeError,
		});
	}

	const readInput = (prompt?: string): Promise<string | null> =>
		view.readInput(prompt ?? options.prompt ?? "> ");
	const writeLine = (line: string) => view.writeLine(line);
	const writeError = (line: string) => view.writeError(line);

	const queuedLines: string[] = [];
	let latestProgressEvent: TurnProgressEvent | null = null;
	const processOutputMode = options.processOutputMode ?? "detailed";
	let turnNumber = 0;
	let currentAssistant: AssistantMessageView | null = null;

	const refreshStatusBar = async (
		event: TurnProgressEvent | null = latestProgressEvent,
	): Promise<void> => {
		view.setStatus(await formatStatusBarForEvent(state, event));
	};

	// Drives the persistent-TUI view from turn progress events. Set as the bridge
	// the console progress reporter forwards to, so the reporter's own
	// `console.log` is skipped while the `TUI` owns rendering (ADR 0025).
	const viewProgressListener = (event: TurnProgressEvent) => {
		latestProgressEvent = event;
		void refreshStatusBar(event);
		currentAssistant = applyTurnProgress(view, event, currentAssistant);
	};
	activeStatusBarProgressListener = useTui ? viewProgressListener : null;

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
			progressReporter: useTui
				? viewProgressListener
				: options.progressReporter,
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

		const turn = await executeTurn(
			state,
			turnInput,
			state.runtime.logger,
			interruptController,
		);
		view.endTurn();
		currentAssistant = null;
		queuedLines.push(...view.takeQueuedLines());

		if (!turn.ok) {
			latestProgressEvent = null;
			writeError(turn.errorMessage);
			continue;
		}

		latestProgressEvent = null;
		if (turn.completionStatus === "interrupted") {
			continue;
		}

		if (useTui) {
			// The assistant message component already renders the streamed answer;
			// emit file-edit summaries as components instead of reprinting it.
			for (const summaryLine of formatFileEditSummaries(turn.toolExecutions)) {
				view.addToolResult(summaryLine);
			}
		} else {
			// Preserve the pre-A1 stdout transcript shape: a blank separator
			// before each turn's output.
			writeLine("");
			if (processOutputMode === "compact") {
				writeLine("");
			}
			printResult(
				turn.outputText ?? "",
				turn.toolExecutions,
				Boolean(options.progressReporter) && processOutputMode !== "compact",
				writeLine,
			);
			if (options.progressReporter && processOutputMode !== "compact") {
				turnNumber += 1;
				writeLine(renderTurnDivider(turnNumber));
			}
		}
	}

	view.stop();
	return state;
}

/**
 * Console fallback output surface for the REPL (non-TTY / one-shot modes).
 * Mirrors the old pre-A1 behavior: `readChatInput` (readline when not a TTY)
 * and `console.log`/`console.error` for all output. The streaming assistant
 * deltas are dropped here (spec-0020: non-TTY modes drop `model_delta`); the
 * final answer is printed once via `printResult`.
 */
class ConsoleReplView implements ReplView {
	private readonly input: ReadStream;
	private readonly output: WriteStream;
	private readonly prompt: string;
	private readonly commands: readonly ChatCommandMetadata[];
	private readonly readChatInputOverride?: typeof readChatInput;
	private readonly writeLineImpl: (line: string) => void;
	private readonly writeErrorImpl: (line: string) => void;

	constructor(opts: {
		input?: ReadStream;
		output?: WriteStream;
		prompt?: string;
		commands?: readonly ChatCommandMetadata[];
		readChatInput?: typeof readChatInput;
		writeLine?: (line: string) => void;
		writeError?: (line: string) => void;
	}) {
		this.input = opts.input ?? input;
		this.output = opts.output ?? output;
		this.prompt = opts.prompt ?? "> ";
		this.commands = opts.commands ?? [];
		this.readChatInputOverride = opts.readChatInput;
		this.writeLineImpl = opts.writeLine ?? console.log;
		this.writeErrorImpl = opts.writeError ?? console.error;
	}

	start(): void {}
	stop(): void {}

	readInput(prompt = this.prompt): Promise<string | null> {
		const reader = this.readChatInputOverride ?? readChatInput;
		return reader({
			prompt,
			input: this.input,
			output: this.output,
			commands: this.commands,
		});
	}

	takeQueuedLines(): string[] {
		return [];
	}

	addUserMessage(): void {}
	beginAssistantMessage(): AssistantMessageView {
		return { appendReasoning() {}, appendContent() {}, finalize() {} };
	}
	beginTurn(): void {}
	endTurn(): void {}
	addToolResult(
		rendered: string,
		_toolName?: string,
		_toolResultData?: JsonValue,
	): void {
		this.writeLineImpl(rendered);
	}
	appendSystem(text: string, tone: "error" | "info" = "info"): void {
		if (tone === "error") {
			this.writeErrorImpl(text);
		} else {
			this.writeLineImpl(text);
		}
	}
	setStatus(): void {}
	writeLine(line: string): void {
		this.writeLineImpl(line);
	}
	writeError(line: string): void {
		this.writeErrorImpl(line);
	}
}
export function createCliProgressReporter(
	mode: ProcessOutputMode = "detailed",
): (event: TurnProgressEvent) => void {
	if (mode === "compact") {
		compactState.hasPrintedTurn = false;
		compactState.groupActive = false;
	}
	const clearState: ClearProgressRenderState = {
		hasPrintedToolInTurn: false,
		modelRequestCountInTurn: 0,
	};

	return (event) => {
		// `update_plan` updates shared plan state regardless of render surface.
		if (
			event.type === "tool_execution_started" &&
			event.toolName === "update_plan"
		) {
			setCurrentPlan(parsePlanArgs(event.toolArguments));
		}
		// When a persistent-TUI view is driving rendering (ADR 0025 A1), forward
		// to it and skip the console output — `console.log` while the `TUI` is
		// alive desyncs Pi-tui's viewport.
		if (activeStatusBarProgressListener) {
			activeStatusBarProgressListener(event);
			return;
		}
		if (mode === "compact") {
			renderCompactProgressEvent(event, compactState);
			return;
		}

		renderClearProgressEvent(event, clearState);
	};
}

// Quiet-mode rendering — Claude Code-style glyph vocabulary.
const QUIET_GLYPH_CALL = "\u23FA\uFE0E";
const QUIET_GLYPH_RESULT = "\u23BF\uFE0E";
const QUIET_GLYPH_DONE = "\u2714\uFE0E";
const QUIET_GLYPH_USER = ">";

function quietColorEnabled(): boolean {
	if (process.env.NO_COLOR) return false;
	if (process.env.CLICOLOR === "0") return false;
	return Boolean(process.stdout.isTTY);
}
const QUIET_COLOR_ON = quietColorEnabled();

function qColor(code: string, value: string): string {
	return QUIET_COLOR_ON ? `${code}${value}${ANSI_RESET}` : value;
}
const qBlue = (v: string) => qColor(ANSI_BLUE, v);
const qCyan = (v: string) => qColor(ANSI_CYAN, v);
const qGreen = (v: string) => qColor(ANSI_GREEN, v);
const qRed = (v: string) => qColor(ANSI_RED, v);
const qYellow = (v: string) => qColor(ANSI_YELLOW, v);
const qDim = (v: string) => qColor(ANSI_DIM, v);

function quietCapitalize(value: string): string {
	return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

function quietStripInlineCode(value: string): string {
	return value.replace(/`/g, "");
}

function quietTruncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`;
}

function formatQuietElapsed(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) {
		return `${ms < 10000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)}s`;
	}
	const minutes = Math.floor(ms / 60000);
	const seconds = Math.round((ms % 60000) / 1000);
	return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

function renderCompactProgressEvent(
	event: TurnProgressEvent,
	state: CompactProgressRenderState,
): void {
	const suffix =
		event.elapsedMs !== undefined
			? ` (${formatQuietElapsed(event.elapsedMs)})`
			: "";
	// A non-tool event ends an open parallel-tool-call group.
	if (
		event.type !== "tool_execution_started" &&
		event.type !== "tool_execution_finished"
	) {
		state.groupActive = false;
	}

	switch (event.type) {
		case "turn_started": {
			if (state.hasPrintedTurn) {
				console.log("");
			}
			state.hasPrintedTurn = true;
			if (event.userInput) {
				printPrefixedBlock(qBlue(`${QUIET_GLYPH_USER} `), event.userInput);
			}
			const plan = getCurrentPlan();
			if (plan?.items.every((item) => item.status === "completed")) {
				setCurrentPlan(null);
			} else if (plan) {
				console.log(
					qBlue(`${QUIET_GLYPH_CALL} Plan: ${formatPlanProgressSummary(plan)}`),
				);
			}
			return;
		}
		case "step_started":
			return;
		case "interrupt_requested":
			console.log(
				qYellow(
					`${QUIET_GLYPH_CALL} ${
						event.interruptStage === "model"
							? "Cancelling current model request"
							: "Interrupt requested; waiting for current tool to finish"
					}`,
				),
			);
			return;
		case "model_request_started":
			return;
		case "model_request_finished":
			return;
		case "assistant_message": {
			const trimmed = event.assistantText?.trim();
			if (trimmed && !isAssistantTextNoise(trimmed)) {
				console.log(
					`${qBlue(QUIET_GLYPH_CALL)} Assistant: ${quietStripInlineCode(trimmed)}`,
				);
			}
			return;
		}
		case "context_checkpoint":
			console.log(
				qBlue(
					`${QUIET_GLYPH_CALL} Checkpoint${event.message ? `: ${event.message}` : ""}`,
				),
			);
			return;
		case "tool_calls_received":
			if ((event.toolCallCount ?? 0) > 1) {
				state.groupActive = true;
			}
			return;
		case "tool_execution_started": {
			const label = quietCapitalize(
				quietStripInlineCode(event.message ?? `tool ${event.toolName}`),
			);
			const indent = state.groupActive ? "  " : "";
			console.log(`${indent}${qCyan(`${QUIET_GLYPH_CALL} ${label}`)}`);
			return;
		}
		case "tool_execution_finished": {
			const ok = event.toolOk === true;
			if (event.toolName === "update_plan") {
				const body = formatUpdatePlanBody(getCurrentPlan(), ok);
				const indent = state.groupActive ? "    " : "  ";
				console.log(
					`${indent}${
						ok ? qDim(QUIET_GLYPH_RESULT) : qRed(QUIET_GLYPH_RESULT)
					} ${ok ? qDim(body) : qRed(body)}${suffix}`,
				);
				return;
			}
			// On success, no extra output. On failure, show error summary.
			if (ok) return;

			const max =
				typeof process.stdout.columns === "number" &&
				process.stdout.columns > 20
					? process.stdout.columns - 4
					: 200;
			const raw = event.toolResult ?? "";
			const body = quietTruncate(raw.length > 0 ? raw : "error", max);
			const indent = state.groupActive ? "    " : "  ";
			console.log(
				`${indent}${qRed(QUIET_GLYPH_RESULT)} ${qRed(body)}${suffix}`,
			);
			return;
		}
		case "turn_finished":
			console.log(qGreen(`${QUIET_GLYPH_DONE} Done${suffix}`));
			return;
		case "turn_interrupted":
			console.log(
				qYellow(
					`${QUIET_GLYPH_CALL} Interrupted${
						event.interruptStage ? ` during ${event.interruptStage}` : ""
					}${suffix}`,
				),
			);
			return;
		case "turn_max_steps_reached":
			console.log(qYellow(`${QUIET_GLYPH_CALL} Stopped at max steps${suffix}`));
			return;
		case "turn_failed":
			console.log(qRed(`${QUIET_GLYPH_CALL} Failed`));
			return;
	}
}

function renderClearProgressEvent(
	event: TurnProgressEvent,
	state: ClearProgressRenderState,
): void {
	const suffix = event.elapsedMs !== undefined ? ` (${event.elapsedMs}ms)` : "";
	switch (event.type) {
		case "turn_started":
			state.hasPrintedToolInTurn = false;
			state.modelRequestCountInTurn = 0;
			if (event.userInput) {
				printPrefixedBlock("> ", event.userInput);
			}
			{
				const plan = getCurrentPlan();
				if (plan?.items.every((item) => item.status === "completed")) {
					setCurrentPlan(null);
				} else if (plan) {
					console.log(`${blue("•")} ${bold("Plan")}`);
					printIndentedBlock(renderPlanFull(plan));
				}
			}
			return;
		case "step_started":
			return;
		case "interrupt_requested":
			console.log(
				event.interruptStage === "model"
					? `${yellow("•")} ${yellow("Cancelling current model request")}`
					: `${yellow("•")} ${yellow("Interrupt requested; waiting for current tool to finish")}`,
			);
			return;
		case "model_request_started":
			state.modelRequestCountInTurn += 1;
			if (state.modelRequestCountInTurn > 1) {
				console.log(renderModelRunDivider(state.modelRequestCountInTurn));
			}
			return;
		case "model_request_finished":
			return;
		case "assistant_message": {
			const trimmed = event.assistantText?.trim();
			if (trimmed && !isAssistantTextNoise(trimmed)) {
				printPrefixedBlock(`${magenta("•")} ${bold("Assistant:")} `, trimmed);
			}
			return;
		}
		case "context_checkpoint":
			console.log(
				`${blue("•")} ${bold("Checkpoint")}${event.message ? `: ${event.message}` : ""}`,
			);
			if (event.detail) {
				printIndentedBlock(event.detail);
			}
			return;
		case "tool_calls_received":
			return;
		case "tool_execution_started":
			if (state.hasPrintedToolInTurn) {
				console.log("");
			}
			state.hasPrintedToolInTurn = true;
			console.log(
				`${green("•")} ${bold("Ran")} ${cyan(event.message ?? `tool ${event.toolName}`)}`,
			);
			if (event.detail) {
				printIndentedBlock(event.detail);
			}
			return;
		case "tool_execution_finished":
			if (!event.toolOk) {
				console.log(
					`${red("•")} ${red(`Failed ${event.toolName ?? "tool"}${suffix}`)}`,
				);
			}
			if (event.toolResult) {
				printIndentedBlock(
					truncateToolResult(
						summarizeToolResultForDisplay(
							event.toolName,
							event.toolResult,
							event.toolOk,
							event.toolResultData,
						),
					),
				);
			}
			return;
		case "turn_finished":
			console.log(`${green("•")} ${green(`Done${suffix}`)}`);
			return;
		case "turn_interrupted":
			console.log(
				`${yellow("•")} ${yellow(`Interrupted${event.interruptStage ? ` during ${event.interruptStage}` : ""}${suffix}`)}`,
			);
			return;
		case "turn_max_steps_reached":
			console.log(`${yellow("•")} ${yellow(`Stopped at max steps${suffix}`)}`);
			return;
		case "turn_failed":
			console.log(`${red("•")} ${red("Failed")}`);
			return;
	}
}

function printPrefixedBlock(firstLinePrefix: string, value: string): void {
	const lines = value.split("\n");
	for (const [index, line] of lines.entries()) {
		console.log(`${index === 0 ? firstLinePrefix : "  "}${line}`);
	}
}

const ASSISTANT_TEXT_NOISE_PATTERNS: RegExp[] = [
	/^\]<\][\w-]+\[>$/, // minimax-style end-of-thinking markers, e.g. "]<]minimax[>"
	/^<\/?[a-z_]+>$/i, // bare XML-ish tags like "<system>", "</think>"
];

function isAssistantTextNoise(text: string): boolean {
	return ASSISTANT_TEXT_NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

function printIndentedBlock(value: string): void {
	for (const line of value.split("\n")) {
		console.log(`  ${line}`);
	}
}

function summarizeToolResultForDisplay(
	toolName: string | undefined,
	value: string,
	ok: boolean | undefined,
	data?: TurnProgressEvent["toolResultData"],
): string {
	if (ok && isFileEditTool(toolName)) {
		const editLines = formatFileEditResultData(data);
		if (editLines.length > 0) {
			return editLines.join("\n");
		}
	}

	if (toolName === "update_plan") {
		// Plan content is already rendered in tool_execution_started's detail;
		// avoid duplicating it here.
		return "";
	}

	if (toolName === "bash") {
		return value || (ok ? "ok" : "Command failed.");
	}

	// read, grep, glob, and everything else: show the pure result directly
	return value || (ok ? "" : "error");
}

function isFileEditTool(toolName: string | undefined): boolean {
	return toolName === "write" || toolName === "edit";
}

function truncateToolResult(value: string): string {
	const maxChars = 2000;
	const maxLines = 80;
	const lines = value.split("\n");
	const lineTruncated =
		lines.length > maxLines
			? `${lines.slice(0, maxLines).join("\n")}\n... [tool result truncated]`
			: value;

	if (lineTruncated.length <= maxChars) {
		return lineTruncated;
	}

	return `${lineTruncated.slice(0, maxChars - 32)}\n... [tool result truncated]`;
}

function renderTurnDivider(turnNumber: number): string {
	return dim(renderLabeledRule(`turn ${turnNumber}`, "━"));
}

function renderModelRunDivider(runNumber: number): string {
	return dim(renderLabeledRule(`model run ${runNumber}`, "┄"));
}

function renderLabeledRule(label: string, fill: string): string {
	const width = getRuleWidth();
	const text = ` ${label} `;
	if (text.length >= width) {
		return text.slice(0, width);
	}

	const leftWidth = Math.max(2, Math.floor((width - text.length) / 2));
	const rightWidth = Math.max(0, width - text.length - leftWidth);
	return `${fill.repeat(leftWidth)}${text}${fill.repeat(rightWidth)}`;
}

function getRuleWidth(): number {
	const columns = process.stdout.columns;
	return Number.isInteger(columns) && columns > 0
		? Math.max(40, columns)
		: DEFAULT_RULE_WIDTH;
}

function color(value: string, code: string): string {
	return `${code}${value}${ANSI_RESET}`;
}

function bold(value: string): string {
	return color(value, ANSI_BOLD);
}

function dim(value: string): string {
	return color(value, ANSI_DIM);
}

function red(value: string): string {
	return color(value, ANSI_RED);
}

function green(value: string): string {
	return color(value, ANSI_GREEN);
}

function yellow(value: string): string {
	return color(value, ANSI_YELLOW);
}

function blue(value: string): string {
	return color(value, ANSI_BLUE);
}

function magenta(value: string): string {
	return color(value, ANSI_MAGENTA);
}

function cyan(value: string): string {
	return color(value, ANSI_CYAN);
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
	noSession: boolean;
	continueSession: boolean;
	sessionTitle?: string;
	approve: boolean;
	noApprove: boolean;
	rest: string[];
} {
	const rest: string[] = [];
	let sessionId: string | undefined;
	let createSession = false;
	let noSession = false;
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

		if (value === "--no-session") {
			noSession = true;
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

	if (noSession && (sessionId || createSession)) {
		throw new Error("--no-session cannot be combined with --session or --new.");
	}

	if (continueSession && (sessionId || createSession || noSession)) {
		throw new Error(
			"--continue cannot be combined with --session, --new, or --no-session.",
		);
	}

	if (approve && noApprove) {
		throw new Error("--approve and --no-approve cannot be combined.");
	}

	return {
		sessionId,
		createSession,
		noSession,
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
		command === "ask" ||
		command === "init" ||
		command === "config" ||
		command === "session"
	) {
		if (command === "ask") {
			await runAsk(rest);
			return;
		}
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

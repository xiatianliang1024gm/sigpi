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
import { TurnInterruptController } from "./interrupt.js";
import { resolveDatedLogFilePath } from "./logger.js";
import { configureHttpProxy } from "./model/http-dispatcher.js";
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
import {
	formatCompactNumber,
	formatElapsed,
	getStatusEventLabel,
	type LastTurnStats,
} from "./tui/status-bar.js";
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
	console.log("  pnpm dev session show <id>");
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

interface RunChatReplLoopOptions {
	state: ChatReplState;
	store: SessionStore;
	progressReporter?: (event: TurnProgressEvent) => void;
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

/** The turn events that end a turn and carry final elapsed/token stats. */
function isTurnTerminalEvent(event: TurnProgressEvent): boolean {
	return (
		event.type === "turn_finished" ||
		event.type === "turn_interrupted" ||
		event.type === "turn_failed" ||
		event.type === "turn_max_steps_reached"
	);
}

/**
 * Cumulative agent usage across one REPL run (sigpi start → exit). Every
 * terminal turn event folds its elapsed/token totals in; when the loop exits
 * the totals are printed as a single summary line. Token fields mirror the
 * per-turn log fields, so `inputTokens + outputTokens` is the billed figure.
 */
interface ReplRunStats {
	/** Number of turns that reached a terminal event in this run. */
	turnCount: number;
	/** Sum of each turn's user-submit → terminal-event elapsed time, in ms. */
	elapsedMs: number;
	/** Provider-reported usage summed across every turn's model requests. */
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
}

export function createReplRunStats(): ReplRunStats {
	return {
		turnCount: 0,
		elapsedMs: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
	};
}

/**
 * Fold a terminal turn event's stats into the run accumulator. Non-terminal
 * events, and turns that never emit a terminal event, are not counted.
 */
export function accumulateTurnStats(
	stats: ReplRunStats,
	event: TurnProgressEvent,
): ReplRunStats {
	stats.turnCount += 1;
	stats.elapsedMs += event.elapsedMs ?? 0;
	const tokens = event.turnTokens;
	if (tokens) {
		stats.inputTokens += tokens.input;
		stats.outputTokens += tokens.output;
		stats.cacheReadTokens += tokens.cacheRead;
		stats.cacheWriteTokens += tokens.cacheWrite;
		stats.totalTokens += tokens.totalTokens;
	}
	return stats;
}

/**
 * One-line summary printed when the REPL exits: total turns, wall-clock agent
 * time, and billed tokens (cumulative `input + output` across every turn).
 * Returns `null` when no turn ran, so an empty session prints nothing.
 */
export function formatReplRunSummary(stats: ReplRunStats): string | null {
	if (stats.turnCount === 0) {
		return null;
	}
	const turns = `${stats.turnCount} ${stats.turnCount === 1 ? "turn" : "turns"}`;
	let line = `Session: ${turns} · ${formatElapsed(stats.elapsedMs)}`;
	const billed = stats.inputTokens + stats.outputTokens;
	if (billed > 0) {
		line = `${line} · ${formatCompactNumber(billed)} billed`;
	}
	return line;
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

	if (event.type === "interrupt_requested") {
		// The status bar alone ("cancelling") is easy to miss; surface the
		// interruption as a transcript line so the user sees the Esc/Ctrl+C
		// was acknowledged.
		view.appendSystem(event.message ?? "Interrupt requested.", "info");
		return currentAssistant;
	}

	if (event.type === "context_compacted") {
		view.appendSystem(formatCompactionMessage(event), "info");
		return currentAssistant;
	}

	if (event.type === "tool_execution_started" && event.toolName) {
		const id = event.toolCallId;
		if (id) {
			const handle = view.beginToolLine(id, event.message ?? event.toolName);
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
		if (event.type === "turn_interrupted") {
			view.appendSystem("Turn interrupted.", "info");
		}
		return null;
	}

	return currentAssistant;
}

/**
 * Render a compaction notice that highlights the context-window size change
 * (the number users actually care about) instead of a verbose recap. Falls
 * back to the event's own message when no token snapshot is available.
 */
function formatCompactionMessage(event: TurnProgressEvent): string {
	const { tokensBefore, tokensAfter } = event;
	if (
		typeof tokensBefore === "number" &&
		typeof tokensAfter === "number" &&
		(tokensBefore > 0 || tokensAfter > 0)
	) {
		return `Context compacted: context window ${formatCompactNumber(tokensBefore)} → ${formatCompactNumber(tokensAfter)} tokens.`;
	}
	return event.message ?? "Context compacted.";
}

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
	replaySessionIntoView(state.view, state.runtime.session);

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
				elapsedMs: event.elapsedMs ?? 0,
				// Cumulative provider-reported usage across the turn's model
				// requests (every tool step re-sends the context, so this
				// billing figure runs well above the bar's left segment).
				tokens: event.turnTokens ?? null,
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
	activeStatusBarProgressListener = viewProgressListener;

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

		const interruptController = new TurnInterruptController();
		latestProgressEvent = null;
		toolLines = new Map();
		currentAssistant = null;
		// Start the turn clock at user submit and drop the previous turn's
		// stats: the bar now shows the live elapsed timer instead.
		turnStartedAt = Date.now();
		lastTurnStats = null;
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

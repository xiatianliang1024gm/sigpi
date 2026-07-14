#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import type { ReadStream, WriteStream } from "node:tty";
import type { TurnResult } from "./agent/turn.js";
import {
	type ChatCommandDefinition,
	createChatCommandDefinitions,
	executeChatCommand,
	formatDocumentedChatCommands,
} from "./chat-commands.js";
import {
	type RunningTurnInputListenerHandle,
	readChatInput,
	startRunningTurnInputListener,
} from "./chat-input.js";
import {
	type ChatReplState,
	formatStatusBar,
	formatStatusBarForEvent,
	runtimeToChatReplState,
} from "./chat-repl.js";
import {
	getDefaultProjectConfigPath,
	getDefaultUserConfigPath,
	initializeUserConfig,
	loadAppConfig,
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
import { createAgentRuntime, createRuntimeSessionStore } from "./runtime.js";
import { formatSessionDetails } from "./session/format.js";
import { InMemorySessionStore } from "./session/in-memory-store.js";
import type { SessionStore } from "./session/store.js";
import { detectShellRuntime } from "./shell.js";
import type { ToolRegistry } from "./tools/registry.js";
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

function readPackageVersion(): string {
	const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
	return pkg.version ?? "(unknown)";
}

function printUsage(): void {
	console.log("Usage:");
	console.log("  pnpm dev init [--force]");
	console.log("  pnpm dev config validate");
	console.log("  pnpm dev chat [--session <id>] [--new] [--title <title>]");
	console.log(
		'  pnpm dev ask [--session <id>] [--new] [--title <title>] "your question"',
	);
	console.log("  pnpm dev session new [--title <title>]");
	console.log("  pnpm dev session list");
	console.log("  pnpm dev session show <id>");
	console.log("");
	console.log(`User config: ${getDefaultUserConfigPath()}`);
	console.log(`Project config: ${getDefaultProjectConfigPath()}`);
	console.log("");
	console.log(
		"`chat` creates and attaches a session by default. Use `ask` for one-off prompts.",
	);
	console.log(`In chat: use ${formatDocumentedChatCommands()}.`);
}

async function runAsk(args: string[]): Promise<void> {
	const parsed = parseSessionArgs(args);
	const prompt = parsed.rest.join(" ").trim();

	if (!prompt) {
		throw new Error('Missing prompt. Example: pnpm dev ask "What time is it?"');
	}

	const config = loadAppConfig();
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
	});
	runtime.logger.info(
		"http_proxy_status",
		proxyStatus as unknown as Record<string, JsonValue | undefined>,
	);
	printSkillBootstrap(
		runtime.loadedSkills.length,
		runtime.skillWarnings.map((warning) => warning.message),
	);
	const result = await runtime.turn.runTurn(prompt, runtime.logger);

	if (!result.ok) {
		console.error(result.errorMessage);
		return;
	}

	if (runtime.sessionRuntime) {
		console.log(
			`[session] ${runtime.sessionRuntime.getCurrentSession().sessionId}`,
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
	const config = loadAppConfig();
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
	const shouldCreateSession = !parsed.sessionId;
	const runtime = await createAgentRuntime({
		config,
		progressReporter,
		sessionId: parsed.sessionId,
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

	console.log(
		`Interactive chat started. Press Enter to send. Press Esc while a turn is running to stop the current operation. Bracketed multiline paste is buffered until you press Enter. Use ${formatDocumentedChatCommands()}.`,
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

	await runChatReplLoop(
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

let activeRunningInput: RunningTurnInputListenerHandle | null = null;
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

async function withActiveRunningInput<T>(
	handle: RunningTurnInputListenerHandle | null,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = activeRunningInput;
	activeRunningInput = handle;
	try {
		return await operation();
	} finally {
		activeRunningInput = previous;
	}
}

function writeWithActiveRunningInput(operation: () => void): void {
	if (activeRunningInput) {
		activeRunningInput.withSuspendedRendering(operation);
		return;
	}

	operation();
}

export async function runChatReplLoop(
	options: RunChatReplLoopOptions,
	dependencies: RunChatReplLoopDependencies = {},
): Promise<ChatReplState> {
	let state = options.state;
	const readInput = dependencies.readChatInput ?? readChatInput;
	const executeTurn =
		dependencies.executeTurn ??
		((state, input, logger, interruptController) =>
			state.runtime.turn.runTurn(input, logger, interruptController));
	const writeLine =
		dependencies.writeLine ??
		((line: string) => writeWithActiveRunningInput(() => console.log(line)));
	const writeError =
		dependencies.writeError ??
		((line: string) => writeWithActiveRunningInput(() => console.error(line)));
	const commands =
		dependencies.commands ??
		createChatCommandDefinitions({
			loadedSkills: options.state.runtime.loadedSkills,
		});
	const queuedLines: string[] = [];
	let latestProgressEvent: TurnProgressEvent | null = null;
	const processOutputMode = options.processOutputMode ?? "detailed";
	let turnNumber = 0;

	const refreshStatusBar = (
		handle: RunningTurnInputListenerHandle | null,
		event: TurnProgressEvent | null = latestProgressEvent,
	): void => {
		handle?.setStatusBarText(formatStatusBarForEvent(state, event));
	};

	while (true) {
		const queuedLine = queuedLines.shift();
		const line =
			queuedLine ??
			(await readInput({
				prompt: options.prompt ?? "> ",
				input: options.input,
				output: options.output,
				commands,
				statusBarText: formatStatusBar(state),
			}));
		if (line === null) {
			break;
		}

		const trimmedLine = line.trim();
		if (!trimmedLine) {
			continue;
		}

		const commandResult = await executeChatCommand(line, commands, {
			getState: () => state,
			setState: (updatedState) => {
				state = updatedState;
				latestProgressEvent = null;
			},
			store: options.store,
			progressReporter: options.progressReporter,
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
		const runningInput = startRunningTurnInputListener({
			prompt: options.prompt ?? "> ",
			input: options.input,
			output: options.output,
			statusBarText: formatStatusBar(state),
			onEscape: () => {
				const interrupt = interruptController.requestInterrupt();
				if (!interrupt.accepted || interrupt.alreadyRequested) {
					return;
				}
				if (options.progressReporter) {
					const event = {
						type: "interrupt_requested",
						message:
							interrupt.stage === "model"
								? "Cancelling current model request"
								: "Interrupt requested; waiting for current tool to finish",
						interruptStage: interrupt.stage ?? undefined,
						interruptSource: "user_escape",
					} satisfies TurnProgressEvent;
					latestProgressEvent = event;
					refreshStatusBar(runningInput, event);
					options.progressReporter(event);
					return;
				}

				writeLine(
					interrupt.stage === "model"
						? "[agent] cancelling current model request"
						: "[agent] interrupt requested; waiting for current tool to finish",
				);
			},
			onSubmit: (text) => {
				queuedLines.push(text);
			},
		});
		const statusBarProgressListener = (event: TurnProgressEvent) => {
			latestProgressEvent = event;
			refreshStatusBar(runningInput, event);
		};
		activeStatusBarProgressListener = options.progressReporter
			? statusBarProgressListener
			: null;
		const turn = await withActiveRunningInput(runningInput, () =>
			executeTurn(state, turnInput, state.runtime.logger, interruptController),
		).finally(() => {
			activeStatusBarProgressListener = null;
			runningInput?.stop();
		});
		writeLine("");

		if (!turn.ok) {
			latestProgressEvent = null;
			writeError(turn.errorMessage);
			continue;
		}

		latestProgressEvent = null;
		if (turn.completionStatus === "interrupted") {
			continue;
		}

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

	return state;
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
		activeStatusBarProgressListener?.(event);
		if (
			event.type === "tool_execution_started" &&
			event.toolName === "update_plan"
		) {
			setCurrentPlan(parsePlanArgs(event.toolArguments));
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

function quietResultSummary(result: string, ok: boolean): string {
	let inlineError = "";
	let firstContent = "";
	for (const raw of result.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		if (line.startsWith("TOOL:")) continue;
		if (line.startsWith("STATUS:")) continue;
		if (line.startsWith("RESULT:")) continue;
		if (line.startsWith("DETAILS:")) continue;
		if (line.startsWith("ERROR:")) {
			inlineError = line.slice("ERROR:".length).trim();
			continue;
		}
		if (!firstContent) firstContent = line;
	}
	return ok ? firstContent : inlineError || firstContent;
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

	writeWithActiveRunningInput(() => {
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
				if (event.userInput && !activeRunningInput) {
					printPrefixedBlock(qBlue(`${QUIET_GLYPH_USER} `), event.userInput);
				}
				const plan = getCurrentPlan();
				if (plan?.items.every((item) => item.status === "completed")) {
					setCurrentPlan(null);
				} else if (plan) {
					console.log(
						qBlue(
							`${QUIET_GLYPH_CALL} Plan: ${formatPlanProgressSummary(plan)}`,
						),
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
				const max =
					typeof process.stdout.columns === "number" &&
					process.stdout.columns > 20
						? process.stdout.columns - 4
						: 200;
				const raw = quietResultSummary(event.toolResult ?? "", ok);
				const body = quietTruncate(
					raw.length > 0 ? raw : ok ? "done" : "error",
					max,
				);
				const indent = state.groupActive ? "    " : "  ";
				console.log(
					`${indent}${
						ok ? qDim(QUIET_GLYPH_RESULT) : qRed(QUIET_GLYPH_RESULT)
					} ${ok ? qDim(body) : qRed(body)}${suffix}`,
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
				console.log(
					qYellow(`${QUIET_GLYPH_CALL} Stopped at max steps${suffix}`),
				);
				return;
			case "turn_failed":
				console.log(qRed(`${QUIET_GLYPH_CALL} Failed`));
				return;
		}
	});
}

function renderClearProgressEvent(
	event: TurnProgressEvent,
	state: ClearProgressRenderState,
): void {
	const suffix = event.elapsedMs !== undefined ? ` (${event.elapsedMs}ms)` : "";

	writeWithActiveRunningInput(() => {
		switch (event.type) {
			case "turn_started":
				state.hasPrintedToolInTurn = false;
				state.modelRequestCountInTurn = 0;
				if (event.userInput && !activeRunningInput) {
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
							summarizeClearToolResult(
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
				console.log(
					`${yellow("•")} ${yellow(`Stopped at max steps${suffix}`)}`,
				);
				return;
			case "turn_failed":
				console.log(`${red("•")} ${red("Failed")}`);
				return;
		}
	});
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

function summarizeClearToolResult(
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

	if (toolName === "bash") {
		return summarizeRunShellResult(value, ok);
	}

	if (toolName === "update_plan") {
		// Plan content is already rendered in tool_execution_started's detail;
		// avoid duplicating it here.
		return "";
	}

	return stripToolResultEnvelope(value);
}

function isFileEditTool(toolName: string | undefined): boolean {
	return toolName === "write" || toolName === "edit";
}

function stripToolResultEnvelope(value: string): string {
	const lines = value.split("\n");
	const resultIndex = lines.indexOf("RESULT:");
	const detailsIndex = lines.indexOf("DETAILS:");
	const errorLine = lines.find((line) => line.startsWith("ERROR:"));

	if (resultIndex >= 0) {
		return (
			lines
				.slice(resultIndex + 1)
				.join("\n")
				.trim() || "(empty result)"
		);
	}

	if (detailsIndex >= 0) {
		const detail = lines
			.slice(detailsIndex + 1)
			.join("\n")
			.trim();
		return [errorLine, detail].filter(Boolean).join("\n");
	}

	return value;
}

function summarizeRunShellResult(
	value: string,
	ok: boolean | undefined,
): string {
	const stdout = extractRawBlock(value, "STDOUT");
	const stderr = extractRawBlock(value, "STDERR");
	const errorLine = value.split("\n").find((line) => line.startsWith("ERROR:"));
	const sections: string[] = [];

	if (ok === false && errorLine) {
		sections.push(errorLine);
	}
	if (stdout && stdout !== "(empty)") {
		sections.push(stdout);
	}
	if (stderr && stderr !== "(empty)") {
		sections.push(`STDERR:\n${stderr}`);
	}

	return (
		sections.join("\n").trim() || (ok === false ? "Command failed." : "ok")
	);
}

function extractRawBlock(
	value: string,
	label: "STDOUT" | "STDERR",
): string | null {
	const lines = value.split("\n");
	const labelIndex = lines.findIndex(
		(line) => line === `${label}:` || line.startsWith(`${label} (`),
	);

	if (labelIndex < 0) {
		const emptyLine = lines.find((line) => line === `${label}: (empty)`);
		return emptyLine ? "(empty)" : null;
	}

	if (lines[labelIndex]?.endsWith("(empty)")) {
		return "(empty)";
	}

	const contentStartIndex =
		lines[labelIndex + 1] === "=== CONTENT START ==="
			? labelIndex + 2
			: labelIndex + 1;
	let contentEndIndex = lines.findIndex(
		(line, index) =>
			index > contentStartIndex && line.startsWith("=== CONTENT END ==="),
	);
	if (contentEndIndex < 0) {
		contentEndIndex = lines.length;
	}

	return lines.slice(contentStartIndex, contentEndIndex).join("\n").trim();
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
	const config = loadAppConfig();
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
	noSession: boolean;
	sessionTitle?: string;
	rest: string[];
} {
	const rest: string[] = [];
	let sessionId: string | undefined;
	let createSession = false;
	let noSession = false;
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

		if (value === "--no-session") {
			noSession = true;
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

	return {
		sessionId,
		createSession,
		noSession,
		sessionTitle,
		rest,
	};
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

	if (subcommand !== "validate" || rest.length > 0) {
		throw new Error(
			`Unknown config command: ${[subcommand ?? "(missing)", ...rest].join(" ")}`,
		);
	}

	const config = loadAppConfig();
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

	if (!command || command === "help" || command === "--help") {
		printUsage();
		return;
	}

	if (command === "--version" || command === "-v") {
		console.log(readPackageVersion());
		return;
	}

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

	if (command === "chat") {
		await runChatWithArgs(rest);
		return;
	}

	if (command === "session") {
		await runSessionCommand(rest);
		return;
	}

	throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Error: ${message}`);
	if (process.env.TINYPI_DEBUG_STACK === "1" && error instanceof Error) {
		console.error(error.stack);
	}
	process.exitCode = 1;
});

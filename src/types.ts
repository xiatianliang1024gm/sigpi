import type { ZodType } from "zod";

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export type Message =
	| SystemMessage
	| UserMessage
	| AssistantMessage
	| ToolMessage;

export interface SystemMessage {
	role: "system";
	content: string;
	/**
	 * Stable identifier. Optional at the type level because system messages
	 * are synthesized by `buildMessages` and never persisted; in-memory they
	 * never need an id. When a system message is passed to the entry stream
	 * (it shouldn't be), the persistence layer rejects it via the zod
	 * schema.
	 */
	id?: string;
}

export interface UserMessage {
	role: "user";
	content: string;
	/**
	 * Stable identifier. Optional at the type level for ergonomics — tests
	 * and inline literals don't have to mint a UUID. The session-store zod
	 * schema requires `id` on any user message that reaches the persisted
	 * entry stream. `createUserMessage` always sets one.
	 */
	id?: string;
}

export interface AssistantMessage {
	role: "assistant";
	content: string | null;
	toolCalls?: ToolCall[];
	/**
	 * Chain-of-thought text the model emitted alongside `content`. Captured
	 * from the provider's `reasoning_content` / `reasoning_summary` field,
	 * or extracted from `<reasoning>` / `<think>` / `<mm:think>` tags embedded
	 * in `content` when the provider does not expose a dedicated field.
	 * Persisted on the assistant message entry so resumed sessions keep the
	 * model's reasoning, and surfaced to the summarizer during compaction so
	 * the next phase can continue without losing the model's line of thought.
	 */
	reasoning?: string;
	id?: string;
}

export interface ToolMessage {
	role: "tool";
	name: string;
	toolCallId: string;
	content: string;
	id?: string;
}

export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	rawArguments: string;
	argumentParseError?: string;
}

export interface ToolSchema {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface SystemPromptSection {
	id: string;
	label: string;
	content: string;
}

interface BashToolContext {
	/** Directory where overflow output / background logs are written. */
	outputDir: string;
	/** Captured rc alias/function definitions written to this file (sourced as a preamble). */
	rcDefinitionsFile?: string;
	/** Optional background-task manager for `run_in_background` commands. */
	tasks?: import("./tools/background.js").BackgroundTaskManager;
}

export interface ToolExecutionContext {
	cwd: string;
	shell?: ShellRuntime;
	logger?: RuntimeLogger;
	runId?: string;
	sessionId?: string | null;
	turnId?: string;
	abortSignal?: AbortSignal;
	/** Present only for the `bash` tool: shared working dir + output roots. */
	bash?: BashToolContext;
}

/**
 * Parsed skill frontmatter, following the Agent Skills specification
 * (https://agentskills.io/specification). sigpi loads skills as instruction
 * documents the agent reads and follows; it does not execute them. Unknown
 * frontmatter fields are ignored.
 */
export interface SkillFrontmatter {
	name: string;
	description: string;
	license?: string;
	compatibility?: string;
	metadata?: Record<string, string>;
	allowedTools?: string;
}

export interface LoadedSkill {
	name: string;
	description: string;
	/** Absolute path to the skill directory (the SKILL.md parent). */
	dir: string;
	/** Config root the skill was discovered under (e.g. the `.sigpi` dir). */
	configRoot: string;
	manifestPath: string;
	/** Instruction body (frontmatter stripped). */
	body: string;
	license?: string;
	compatibility?: string;
	metadata: Record<string, string>;
	allowedTools?: string;
	/** Full parsed frontmatter, including fields sigpi does not specialize. */
	rawFrontmatter: Record<string, unknown>;
}

export interface SkillWarning {
	skillName: string | null;
	message: string;
}

export type ShellKind = "zsh" | "bash" | "sh" | "pwsh" | "powershell" | "cmd";

export interface ShellRuntime {
	platform: NodeJS.Platform;
	shell: ShellKind;
	executable: string;
	argsPrefix: string[];
	displayName: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeLogger {
	debug(event: string, fields?: Record<string, JsonValue | undefined>): void;
	info(event: string, fields?: Record<string, JsonValue | undefined>): void;
	warn(event: string, fields?: Record<string, JsonValue | undefined>): void;
	error(event: string, fields?: Record<string, JsonValue | undefined>): void;
}

/**
 * One turn-progress event per phase of an agent turn. Each key is the event
 * name the runner emits (and listeners subscribe to); the payload carries only
 * the fields that phase can meaningfully report. `type`/`turnId`-style
 * boilerplate is deliberately absent — the event name is the type, and the
 * turn id is carried once on `turn_started`.
 */
export interface TurnProgressEventMap {
	turn_started: { turnId: string; userInput: string };
	step_started: { step: number };
	interrupt_requested: { message: string; stage?: InterruptStage };
	model_request_started: { step: number };
	model_request_finished: { step: number };
	model_delta: {
		step: number;
		/** Incremental reasoning text emitted mid-stream. */
		reasoningDelta?: string;
		/** Incremental assistant content text emitted mid-stream. */
		contentDelta?: string;
		/** Incremental tool-call argument fragment emitted mid-stream. */
		toolCallDelta?: ModelDelta["toolCallDelta"];
	};
	assistant_message: { step: number; text: string };
	/** A degenerate empty model response was retried once. */
	context_checkpoint: { step: number };
	/**
	 * Token snapshot of the context window around a compaction, so the UI can
	 * surface the window-size change.
	 */
	context_compacted: {
		step: number;
		tokensBefore: number;
		tokensAfter: number;
		/** Which trigger fired for the compaction (see {@link ContextUpdateResult.trigger}). */
		trigger: Exclude<ContextUpdateResult["trigger"], null>;
	};
	tool_calls_received: { step: number; count: number };
	tool_execution_started: {
		step: number;
		toolName: string;
		toolCallId: string;
		arguments?: Record<string, unknown>;
		/** Human-readable progress label for the tool call. */
		message: string;
	};
	tool_execution_finished: {
		step: number;
		toolName: string;
		toolCallId: string;
		ok: boolean;
		elapsedMs: number;
		/** Rendered tool result (truncated), for the error line when it failed. */
		result?: string;
		/** Structured result payload, when the tool returned one. */
		data?: JsonValue;
	};
	/**
	 * Terminal turn events carry the provider-reported usage accumulated
	 * across every model request in the turn (main steps plus in-turn
	 * checkpoint summaries), or `null` when no request reported usage.
	 */
	turn_finished: { step: number; elapsedMs: number; usage: ModelUsage | null };
	turn_interrupted: {
		step: number;
		elapsedMs: number;
		stage: InterruptStage;
		usage: ModelUsage | null;
	};
	turn_failed: {
		step: number;
		elapsedMs: number;
		failureType: string;
		/** Raw error message, for the log. */
		message: string;
		usage: ModelUsage | null;
	};
	turn_max_steps_reached: {
		step: number;
		elapsedMs: number;
		usage: ModelUsage | null;
	};
}

/** Names of every turn-progress event, for subscribing to the whole stream. */
export const TURN_PROGRESS_EVENTS = [
	"turn_started",
	"step_started",
	"interrupt_requested",
	"model_request_started",
	"model_request_finished",
	"model_delta",
	"assistant_message",
	"context_checkpoint",
	"context_compacted",
	"tool_calls_received",
	"tool_execution_started",
	"tool_execution_finished",
	"turn_finished",
	"turn_interrupted",
	"turn_failed",
	"turn_max_steps_reached",
] as const satisfies readonly (keyof TurnProgressEventMap)[];

/** Runtime payload of one emitted progress event (event name + payload). */
export type TurnProgressPayload = {
	[K in keyof TurnProgressEventMap]: TurnProgressEventMap[K] & {
		estimatedContextTokens?: number;
	};
}[keyof TurnProgressEventMap];

/**
 * A progress event as delivered to `AgentRunner.onProgress` listeners: the
 * event name tagged back onto the payload. `estimatedContextTokens` is the
 * live in-flight request-token estimate the runner attaches at emit time; it
 * is absent on synthetic events (e.g. a REPL-emitted `interrupt_requested`).
 */
export type TurnProgressEvent = {
	[K in keyof TurnProgressEventMap]: { type: K } & TurnProgressEventMap[K] & {
			estimatedContextTokens?: number;
		};
}[keyof TurnProgressEventMap];

/**
 * The terminal subset of progress events: the four ways a turn can end, each
 * carrying the turn's final elapsed time and accumulated token usage.
 */
export type TurnTerminalEvent = Extract<
	TurnProgressEvent,
	{
		type:
			| "turn_finished"
			| "turn_interrupted"
			| "turn_failed"
			| "turn_max_steps_reached";
	}
>;

export interface ToolExecutionResult {
	ok: boolean;
	data?: JsonValue;
	error?: string;
	details?: JsonValue;
}

export interface ToolDefinition<
	TArgs = unknown,
	TResult extends JsonValue = JsonValue,
> {
	name: string;
	description: string;
	inputSchema: ZodType<TArgs>;
	parameters: Record<string, unknown>;
	execute: (
		args: TArgs,
		context: ToolExecutionContext,
	) => Promise<TResult> | TResult;
	/**
	 * Optional progress description for a tool call. When absent the registry
	 * falls back to `tool <name>`. Keeps per-tool progress text at the seam
	 * instead of a central name-switch.
	 */
	describeProgress?: (args: Record<string, unknown>) => {
		summary: string;
		detail?: string;
	};
}

export interface ModelRequest {
	messages: Message[];
	tools: ToolSchema[];
	temperature?: number;
	maxTokens?: number;
	context?: ModelRequestContext;
	abortSignal?: AbortSignal;
}

/**
 * Token usage returned by the model provider for a single request.
 *
 * `totalTokens` is the canonical context-token count reported by the provider
 * for this request (input + output + cache reads + cache writes). It is what
 * we use for token-based compact triggers.
 *
 * Cache fields may be reported by some providers (e.g. Anthropic, OpenAI with
 * prompt caching) and may be absent on others. They are surfaced here so that
 * downstream telemetry can compute cache hit ratios.
 */
export interface ModelUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export interface ModelResponse {
	assistantText: string | null;
	/**
	 * Chain-of-thought text accumulated across the stream (or read from a
	 * non-streaming response). See {@link AssistantMessage.reasoning} for
	 * the provenance. The agent loop persists this on the assistant message
	 * entry and includes it in the compaction transcript so the summarizer
	 * sees the model's reasoning, not just its final answer.
	 */
	reasoning?: string | null;
	toolCalls: ToolCall[];
	finishReason: string | null;
	/**
	 * Token usage for this request. Optional because not every provider /
	 * response shape includes it. When present, `totalTokens` is used by the
	 * context manager as the ground-truth context size for compact triggers.
	 */
	usage?: ModelUsage;
	rawResponse?: unknown;
}

/**
 * A single streaming delta emitted by a model provider mid-request. The
 * transport surfaces these through {@link WireFormatAdapter.onDelta} so the
 * agent loop can render partial reasoning/content without waiting for the full
 * response to finalize.
 *
 * Exactly one of `reasoningDelta` / `contentDelta` / `toolCallDelta` is
 * expected to be present per delta, but adapters may emit a delta with multiple
 * fields populated when a single wire frame carries more than one kind of
 * change.
 */
export interface ModelDelta {
	/** Incremental reasoning text (e.g. OpenAI `reasoning_content`). */
	reasoningDelta?: string;
	/** Incremental assistant content text. */
	contentDelta?: string;
	/** Incremental tool-call argument text for an in-progress tool call. */
	toolCallDelta?: {
		/** Index of the tool call within the current response. */
		index: number;
		/** Stable tool-call id, if the provider has assigned one yet. */
		id?: string;
		/** Tool name, if known at this point in the stream. */
		name?: string;
		/** Incremental JSON argument fragment. */
		argumentsDelta?: string;
	};
	/** Provider-reported finish reason, if this delta terminates the stream. */
	finishReason?: string | null;
}

interface ModelRequestContext {
	runId?: string;
	sessionId?: string | null;
	turnId?: string;
	step?: number;
	purpose?: "turn" | "summary";
}

// The ModelProvider seam is defined and constructed in the model module
// (src/model/provider.ts); re-exported here so shared-type consumers keep a
// single import site.
export type { ModelProvider } from "./model/provider.js";

/**
 * The model-bound context budget that drives compaction. Capacity is a
 * physical property of the selected model, so the whole budget object lives
 * at the model level rather than the agent level.
 */
export interface ContextBudget {
	/**
	 * The model's full context window in tokens (the physical ceiling).
	 * The hard trim limit is `hardContextLimit - reserveTokens`.
	 */
	hardContextLimit: number;
	/**
	 * Tokens reserved for the model's response. Subtracted from
	 * `hardContextLimit` to compute the soft trigger threshold.
	 */
	reserveTokens: number;
	/**
	 * Token budget of recent messages to keep un-summarized. The cut-point
	 * algorithm walks backwards from the newest message, accumulating tokens
	 * until this budget is filled, then cuts at the nearest valid boundary.
	 */
	keepRecentTokens: number;
}

export interface ContextManagerOptions {
	/**
	 * Returns the active model's context budget. Called at every compaction /
	 * estimate so the soft trigger threshold tracks the model selected via
	 * `/model switch`. This is the single source of truth for the "which
	 * model is active" budget knowledge.
	 */
	getContextBudget: () => ContextBudget;
	/**
	 * Minimum number of recent messages that must always be retained,
	 * regardless of which trigger fires. Acts as a sanity floor for the
	 * token-based trimming. Defaults to 4.
	 */
	keepRecentMessagesFloor?: number;
	summaryEnabled: boolean;
	logger?: RuntimeLogger;
	runId?: string;
	sessionId?: string | null;
}

export interface ContextUpdateResult {
	summarized: boolean;
	summary: string | null;
	recentMessageCount: number;
	previousRecentMessageCount: number;
	summaryChars: number;
	previousSummaryChars: number;
	/**
	 * Token-based snapshot. `tokensBefore` is computed as
	 *   `lastUsage.totalTokens + sum(estimateMessageTokens for messages added after lastUsage)`,
	 * falling back to `estimateContextTokens` over the full recent message
	 * list when no usage has been recorded yet.
	 */
	tokensBefore: number;
	tokensAfter: number;
	/**
	 * Which trigger fired for summarization, if any. Useful for telemetry
	 * and for the test suite to assert which path was taken.
	 */
	trigger?: "token" | "force" | null;
}

export interface ConversationContextState {
	summary: string | null;
	recentMessages: Message[];
	/**
	 * Optional entry stream backing this context. When present, `summary` and
	 * `recentMessages` are derived from it (last compaction entry's summary,
	 * plus the message entries after its `firstKeptEntryId`). Absent on
	 * pre-v4 sessions or in-memory contexts that have not yet flushed.
	 */
	entries?: SessionEntry[];
}

/**
 * One of the persisted entry kinds in a session. v4 sessions store a flat
 * stream of `MessageEntry` and `CompactionEntry` (and, optionally, future
 * `BranchSummaryEntry`) entries. `turnId` on `MessageEntry` is an audit
 * attribute: the runtime UUID of the turn that produced the message.
 */
export type SessionEntry = MessageEntry | CompactionEntry;

export interface MessageEntry {
	kind: "message";
	id: string;
	turnId: string | null;
	timestamp: string;
	message: Message;
	/**
	 * Provider-reported token usage for the assistant message in this entry.
	 * Only set on assistant entries that came back with a `ModelResponse.usage`
	 * payload. Persisted so that resuming a session can restore the
	 * `lastUsage` ground-truth context size without re-querying the model.
	 */
	usage?: ModelUsage;
}

export interface CompactionEntry {
	kind: "compaction";
	id: string;
	parentId: string | null;
	timestamp: string;
	summary: string;
	/**
	 * Identifier of the first `MessageEntry` kept after this compaction, or
	 * `null` if no messages were kept. The pre-compaction messages are
	 * summarized into `summary`. When the next compaction happens, its
	 * `parentId` references this entry's id, forming a linked list.
	 */
	firstKeptEntryId: string | null;
	/**
	 * Token-based context window snapshot around this compaction. `tokensBefore`
	 * is the pre-compaction estimate; `tokensAfter` is the estimate of the
	 * post-compaction context (new summary + kept messages), matching the
	 * `tokensAfter` reported by the live `context_compacted` event so replayed
	 * history shows the same window change.
	 */
	tokensBefore?: number;
	tokensAfter?: number;
	/**
	 * Provider-reported token usage of the summarize call that produced this
	 * compaction (D7). Audit data only — surfaced in logs and telemetry, never
	 * fed into the `lastUsage` baseline (the summarize request's token count
	 * does not describe the next main request's window).
	 */
	usage?: ModelUsage;
	details?: {
		trigger: ContextUpdateResult["trigger"];
		keptMessages: number;
		summarizedMessages: number;
		triggeredBy?: "soft_limit" | "hard_limit" | "token_estimate" | "manual";
		/**
		 * User-provided custom instructions supplied to this compaction
		 * (via `/compact <instructions>`). Persisted for replay / audit
		 * so future rebuilds know what extra guidance shaped the summary.
		 */
		customInstructions?: string;
	};
}

export interface AgentRunnerOptions {
	maxSteps: number;
	temperature: number;
	maxTokens?: number;
	workingDirectory: string;
	runId?: string;
	sessionId?: string | null;
	/**
	 * Shared `bash` tool context (working dir + output roots). Plumbed from
	 * the runtime so the `bash` tool can carry `cd` across commands and
	 * write overflow/background output.
	 */
	bashToolContext?: BashToolContext;
}

export interface ExecutedToolCall {
	toolCall: ToolCall;
	result: ToolExecutionResult;
}

type RunCompletionStatus = "completed" | "interrupted";
export type InterruptSource = "user_escape" | "process_recovery";
export type InterruptStage = "model" | "tool";

export interface RunTurnResult {
	completionStatus: RunCompletionStatus;
	outputText: string | null;
	steps: number;
	toolExecutions: ExecutedToolCall[];
	contextSummary: string | null;
	contextMessageCount: number;
	contextUpdated: ContextUpdateResult;
	interruptSource: InterruptSource | null;
	interruptStage: InterruptStage | null;
}

type TurnStatus = "in_progress" | "completed" | "failed" | "interrupted";

interface SessionTurnRecord {
	startedAt: string;
	finishedAt: string | null;
	status: TurnStatus;
	userInput: string;
	assistantOutput: string | null;
	toolExecutionCount: number;
	errorMessage?: string | null;
	interruptSource?: InterruptSource | null;
	interruptStage?: InterruptStage | null;
}

export interface PersistedSession {
	version: 4;
	sessionId: string;
	title: string | null;
	createdAt: string;
	updatedAt: string;
	cwd: string;
	systemPromptFingerprint: string;
	loadedSkillNames: string[];
	skillsFingerprint: string | null;
	/**
	 * Flat entry stream backing the conversation. `summary` and
	 * `recentMessages` are derived from this stream (see
	 * `deriveContextStateFromEntries`). v3 sessions are migrated to v4 on
	 * first load; the original v3 file is backed up as `<id>.v3.json.bak`.
	 */
	entries: SessionEntry[];
	turnCount: number;
	lastCompletedUserInput: string | null;
	lastTurn: SessionTurnRecord | null;
}

export interface SessionSummary {
	sessionId: string;
	title: string | null;
	lastCompletedUserInput: string | null;
	updatedAt: string;
	cwd: string;
	turnCount: number;
	lastTurnStatus: TurnStatus | null;
	/**
	 * Crude chars/4 estimate of the persisted session's total token footprint.
	 * `null` for sessions saved before this field existed.
	 */
	estimatedTokens: number | null;
}

export interface LoadedSession {
	session: PersistedSession;
	warnings: string[];
}

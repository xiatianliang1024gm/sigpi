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

export interface BashWorkingDir {
	/** Current working directory, mutated by `cd` across commands in a session. */
	current: string;
	/** Project (launch) directory; the only allowed `cd` boundary. */
	readonly projectDir: string;
	/** When true, ignore carry-over and always run in `projectDir`. */
	readonly maintainProjectWorkingDir: boolean;
}

export interface BashToolContext {
	/** Mutable working directory shared across `bash` calls in this session. */
	workingDir: BashWorkingDir;
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
	/**
	 * Additional roots (outside `cwd`) the read-only tools (`read`, `grep`,
	 * `glob`, `local-search`) may open. Populated at runtime with the session
	 * bash output dir and the directories of loaded skills, so the agent can
	 * read progressive-disclosure skill files that live outside the workspace.
	 */
	allowedReadRoots?: string[];
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

export type RunShellMode = "read_only" | "workspace_write" | "full_access";

export interface ShellRuntime {
	platform: NodeJS.Platform;
	shell: ShellKind;
	executable: string;
	argsPrefix: string[];
	displayName: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export type ProcessOutputMode = "compact" | "detailed";

export interface RuntimeLogger {
	debug(event: string, fields?: Record<string, JsonValue | undefined>): void;
	info(event: string, fields?: Record<string, JsonValue | undefined>): void;
	warn(event: string, fields?: Record<string, JsonValue | undefined>): void;
	error(event: string, fields?: Record<string, JsonValue | undefined>): void;
}

export interface TurnProgressEvent {
	type:
		| "turn_started"
		| "step_started"
		| "interrupt_requested"
		| "model_request_started"
		| "model_request_finished"
		| "assistant_message"
		| "context_checkpoint"
		| "tool_calls_received"
		| "tool_execution_started"
		| "tool_execution_finished"
		| "turn_finished"
		| "turn_interrupted"
		| "turn_failed"
		| "turn_max_steps_reached";
	step?: number;
	message?: string;
	userInput?: string;
	elapsedMs?: number;
	turnId?: string;
	toolName?: string;
	toolArguments?: Record<string, unknown>;
	toolCallCount?: number;
	toolExecutionCount?: number;
	toolOk?: boolean;
	toolResult?: string;
	toolResultData?: JsonValue;
	assistantText?: string;
	detail?: string;
	modelElapsedMs?: number;
	summaryCount?: number;
	trimCount?: number;
	failureType?: string;
	interruptStage?: InterruptStage;
	interruptSource?: InterruptSource;
	estimatedContextChars?: number;
	estimatedContextTokens?: number;
}

export type ProgressReporter = (event: TurnProgressEvent) => void;

export interface ToolExecutionResult {
	ok: boolean;
	data?: JsonValue;
	error?: string;
	details?: JsonValue;
}

export interface LedgerRecorder {
	search(entry: {
		query: string;
		glob?: string | null;
		output?: string | null;
		caseSensitive?: boolean | null;
		resultCount?: number | null;
		truncated?: boolean | null;
		repeatedCount?: number;
	}): void;
	read(
		path: string,
		range?: {
			startLine?: number;
			endLine?: number;
			startChar?: number;
			endChar?: number;
			truncated?: boolean;
		},
	): void;
	modified(path: string): void;
	candidate(path: string): void;
	finding(text: string): void;
	rejected(path: string): void;
	shellFinding(
		command: string,
		ok: boolean | null,
		exitCode: number | null,
	): void;
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
	/**
	 * Optional exploration-ledger recording for a successful tool call.
	 * Receives a `LedgerRecorder` facade so the tool expresses intent (searched,
	 * read, modified, ...) without knowing the ledger's caps or dedup rules.
	 * When absent the ledger records nothing for the tool on success.
	 */
	recordLedger?: (
		recorder: LedgerRecorder,
		toolCall: ToolCall,
		result: ToolExecutionResult,
	) => void;
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

export interface ModelRequestContext {
	runId?: string;
	sessionId?: string | null;
	turnId?: string;
	step?: number;
	purpose?: "turn" | "summary";
}

export interface ModelProvider {
	/**
	 * Model's maximum output tokens, if known. Compaction uses this as a
	 * hard cap when sizing the summary request so we never ask for more
	 * tokens than the model can produce. Optional; consumers should
	 * default to a sensible internal cap (2048) when absent.
	 */
	readonly maxTokens?: number;
	generate(request: ModelRequest): Promise<ModelResponse>;
}

export interface ContextManagerOptions {
	/**
	 * The model's full context window in tokens. Compact triggers when
	 * `tokens > contextWindow - reserveTokens`. Defaults to 200_000.
	 */
	contextWindow: number;
	/**
	 * Tokens reserved for the model's response. Subtracted from
	 * `contextWindow` to compute the soft trigger threshold.
	 * Defaults to 16_384.
	 */
	reserveTokens?: number;
	/**
	 * Token budget of recent messages to keep un-summarized. The cut-point
	 * algorithm walks backwards from the newest message, accumulating tokens
	 * until this budget is filled, then cuts at the nearest valid boundary.
	 * Defaults to 20_000.
	 */
	keepRecentTokens?: number;
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
	/**
	 * Registry of `session_before_compact` hooks. When supplied, every
	 * successful compact runs the registered hooks before applying the
	 * default summarization. A hook can cancel the compact or override
	 * the resulting summary / firstKeptEntryId / details.
	 */
	compactionHooks?: import("./agent/compaction-hook.js").CompactionHookRegistry;
	/**
	 * Callback that records a tool's explorable effects into the exploration
	 * ledger, mirroring how `compactionHooks` is injected. Wired by the runtime
	 * to the tool registry's `recordLedger` dispatch so the context stays
	 * ignorant of the tool set. When absent, the ledger records nothing for
	 * successful tool calls (the failure path still records `rejectedPaths`).
	 */
	ledgerRecorder?: (
		toolCall: ToolCall,
		result: ToolExecutionResult,
		ledger: ExplorationLedger,
	) => ExplorationLedger;
}

export interface ContextUpdateResult {
	summarized: boolean;
	trimmed: boolean;
	summary: string | null;
	recentMessageCount: number;
	previousRecentMessageCount: number;
	summaryChars: number;
	previousSummaryChars: number;
	estimatedCharsBefore: number;
	estimatedCharsAfter: number;
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

export interface ExplorationSearchEntry {
	query: string;
	glob: string | null;
	output: string | null;
	caseSensitive: boolean | null;
	resultCount: number | null;
	truncated: boolean | null;
	repeatedCount: number;
}

export interface ExplorationReadRange {
	path: string;
	startLine?: number | null;
	endLine?: number | null;
	startChar?: number | null;
	endChar?: number | null;
	truncated?: boolean | null;
}

export interface ExplorationLedger {
	searchedQueries: ExplorationSearchEntry[];
	candidateFiles: string[];
	readRanges: ExplorationReadRange[];
	rejectedPaths: string[];
	keyFindings: string[];
	modifiedFiles: string[];
}

export interface ConversationContextState {
	summary: string | null;
	recentMessages: Message[];
	explorationLedger?: ExplorationLedger;
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
 * `BranchSummaryEntry`) entries. `turnId` on `MessageEntry` links it back to
 * the matching `SessionTurnHistoryEntry` for audit / `/history` purposes.
 */
export type SessionEntry = MessageEntry | CompactionEntry;

export interface MessageEntry {
	kind: "message";
	id: string;
	turnId: number | null;
	timestamp: string;
	message: Message;
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
	tokensBefore?: number;
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
	logger?: RuntimeLogger;
	progressReporter?: ProgressReporter;
	processOutputMode?: ProcessOutputMode;
	runId?: string;
	sessionId?: string | null;
	/**
	 * Inject a follow-up user reminder when the model returns a final answer
	 * after mutating files, prompting one extra verification step.
	 * Defaults to `false` because the follow-up round can re-enter a
	 * read/search loop when the working context is already near the soft
	 * limit. Existing tests that depend on the reminder explicitly opt in.
	 */
	enableVerificationReminder?: boolean;
	/**
	 * Shared `bash` tool context (working dir + output roots). Plumbed from
	 * the runtime so the `bash` tool can carry `cd` across commands and
	 * write overflow/background output where the `read` tool can open it.
	 */
	bashToolContext?: BashToolContext;
	/**
	 * Trusted read roots passed through to every tool's execution context
	 * (see `ToolExecutionContext.allowedReadRoots`).
	 */
	allowedReadRoots?: string[];
}

export interface ExecutedToolCall {
	toolCall: ToolCall;
	result: ToolExecutionResult;
}

export type RunCompletionStatus = "completed" | "interrupted";
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

export type SessionStatus = "active" | "interrupted" | "completed";

export type TurnStatus = "in_progress" | "completed" | "failed" | "interrupted";

export interface SessionTurnRecord {
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

export interface SessionToolExecutionEntry {
	toolCall: ToolCall;
	result: ToolExecutionResult;
}

export interface SessionTurnHistoryEntry {
	turnId: number;
	startedAt: string;
	finishedAt: string | null;
	status: TurnStatus;
	userInput: string;
	assistantOutput: string | null;
	steps: number;
	toolExecutions: SessionToolExecutionEntry[];
	errorMessage: string | null;
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
	explorationLedger?: ExplorationLedger;
	turnCount: number;
	lastCompletedUserInput: string | null;
	status: SessionStatus;
	lastTurn: SessionTurnRecord | null;
	turns: SessionTurnHistoryEntry[];
}

export interface SessionSummary {
	sessionId: string;
	title: string | null;
	lastCompletedUserInput: string | null;
	updatedAt: string;
	status: SessionStatus;
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

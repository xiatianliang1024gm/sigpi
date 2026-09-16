import {
	estimateContextTokens,
	estimateMessageTokens,
} from "../context-window.js";
import type {
	ContextBudget,
	Message,
	ModelProvider,
	ModelUsage,
	ToolMessage,
	ToolSchema,
} from "../types.js";
import { summarize } from "./summarizer.js";

/**
 * How many tokens of the most recent tool output stay verbatim in a request
 * before older results are elided.
 *
 * Chosen by comparison with the general practice of other agents rather than
 * from this project's own history. Every comparable implementation keeps a
 * working set in the **10k–50k token** band:
 *
 * - Anthropic's server-side context editing (the vendor implementation of this
 *   exact feature, `clear_tool_uses_20250919`) defaults to triggering at
 *   100k input tokens and keeping the last 3 tool use/result pairs.
 * - Claude Code's equivalent tier clears old tool results and reports
 *   reclaiming ~10k–50k tokens per activation; its session-memory tier keeps
 *   10k–40k tokens of recent messages, and its post-compaction file restore
 *   re-injects recently read files under a 50k token budget.
 *
 * 32k sits mid-band: ~16% of the default 200k window, so the remaining ~150k
 * stays available for the system prompt, tool schemas, conversation and
 * summaries — micro-compaction shapes the request but must not be what governs
 * the window (full compaction does that). In bytes it is ~128 KB, i.e. 2.5
 * max-size reads (the read tool caps at 50 KB) or roughly 10–15 typical source
 * files, which covers a normal multi-file working set without eliding anything.
 *
 * The previous value (8k, ~32 KB) was smaller than a single `read` result, so
 * ordinary multi-file exploration lost results one step after fetching them.
 */
export const MICRO_COMPACT_KEEP_TOOL_TOKENS = 32_000;

/**
 * Minimum number of tool results kept regardless of the token budget. Mirrors
 * Anthropic's `keep: 3` default for `clear_tool_uses_20250919` — that counts
 * tool use/result *pairs*, so flooring on 3 tool results is the more
 * conservative reading of the same intent.
 */
const MICRO_COMPACT_FLOOR_TOOL_RESULTS = 3;

/**
 * Marker prefix of the placeholder that replaces an elided tool result. Kept
 * short (it is re-sent on every subsequent request) but explicit: the
 * placeholder must never be confusable with a tool that genuinely produced no
 * output (see `formatOmittedToolResult`).
 */
export const OMITTED_TOOL_RESULT_MARKER = "[context-elided]";

/**
 * Build the placeholder that stands in for a tool result dropped from the
 * request to save room.
 *
 * The content must be **non-empty and self-describing**. An empty string is
 * indistinguishable from a tool that legitimately returned nothing, so a model
 * that sees one concludes the call failed or the file is empty and re-issues
 * it. That is a self-sustaining loop: the fresh result pushes more output into
 * the window, which evicts the result the model just fetched, which it
 * re-issues again.
 *
 * The wording states what happened (dropped, not empty, the call succeeded) and
 * what a retry actually does. It deliberately does **not** forbid re-running
 * the call: re-running is legitimate and works, because the newest batch is
 * pinned by {@link microCompactMessages}. What it warns against is relying on
 * the output to stay put, which is what the blind retry loop assumed.
 */
export function formatOmittedToolResult(
	name: string,
	originalChars: number,
): string {
	return (
		`${OMITTED_TOOL_RESULT_MARKER} This "${name}" result (${originalChars} characters) ` +
		"was dropped from the request to save room; the call succeeded and the output was " +
		"not empty. Re-running the call returns the same text, but it is dropped again as " +
		"soon as newer results arrive — so re-read only what you need, then use it promptly."
	);
}

/**
 * The two pure compaction interfaces (ADR 0026, D2). `decide` is a pure
 * computation — no I/O, no state mutation — that answers "should we compact,
 * and where should the split land?" `execute` performs the summarization
 * itself (a model call) and returns the new summary plus the provider usage
 * of that call. `ConversationContext.compact()` is the thin orchestrator that
 * calls decide → execute → apply.
 */

/**
 * Decide whether compaction should run and where the split lands.
 *
 * The over-limit check runs inside this function against the whole *request*
 * shape: system prompt + tool schemas + pending user input + recent
 * messages (the summary is not included — it is replaced by whatever
 * compaction produces, so the soft limit gates the live window). The soft
 * limit is `hardContextLimit - reserveTokens`.
 *
 * `splitIndex` preserves the `findCompactSplitIndex` semantics verbatim:
 * from the tail, keep up to `keepRecentTokens` of recent messages, aligned so
 * a split never lands inside a tool-result group; `force` always summarizes
 * at least `keepRecentFloor` messages; a `token` trigger that does not reach
 * `keepRecentTokens` returns `splitIndex = 0` (no compact).
 */
export function decide(input: {
	messages: Message[];
	budget: ContextBudget;
	keepRecentFloor: number;
	systemPrompt: string;
	toolSchemas: readonly ToolSchema[];
	pendingUserInput?: string;
	force?: boolean;
}): { shouldCompact: boolean; splitIndex: number } {
	const estimated = estimateContextTokens({
		systemPrompt: input.systemPrompt,
		summary: null,
		recentMessages: input.messages,
		toolSchemas: input.toolSchemas,
		pendingUserInput: input.pendingUserInput,
	});
	const threshold = Math.max(
		0,
		input.budget.hardContextLimit - input.budget.reserveTokens,
	);
	const overLimit = estimated.totalTokens > threshold;
	const trigger = input.force ? "force" : overLimit ? "token" : null;

	if (!trigger) {
		return { shouldCompact: false, splitIndex: 0 };
	}

	return {
		shouldCompact: true,
		splitIndex: findCompactSplitIndex({
			messages: input.messages,
			trigger,
			keepRecentTokens: input.budget.keepRecentTokens,
			keepRecentFloor: input.keepRecentFloor,
		}),
	};
}

/**
 * Summarize the given slice of messages (the pre-split window). Internally
 * applies `microCompactMessages` (old tool results reduced to `name` +
 * `toolCallId`, content emptied) before calling `summarize`. Returns the new
 * summary and the provider-reported usage of the summarize call.
 *
 * On any model failure it throws (`CompactionFailedError`) — it never trims,
 * never degrades (D4).
 */
export async function execute(input: {
	provider: ModelProvider;
	systemPrompt: string;
	messages: Message[];
	previousSummary: string | null;
	instructions?: string;
	requestContext?: { turnId?: string };
	reserveTokens: number;
	abortSignal?: AbortSignal;
}): Promise<{ summary: string; usage?: ModelUsage }> {
	return summarize(input.provider, {
		systemPrompt: input.systemPrompt,
		messages: microCompactMessages(input.messages),
		previousSummary: input.previousSummary,
		instructions: input.instructions,
		requestContext: input.requestContext,
		reserveTokens: input.reserveTokens,
		abortSignal: input.abortSignal,
	});
}

// ---------------------------------------------------------------------------
// Split / alignment helpers (kept from the old Compactor, unchanged)
// ---------------------------------------------------------------------------

/**
 * Compute the split index for a compaction: messages[0..splitIndex) are
 * summarized, messages[splitIndex..] stay live. `keepRecentTokens` bounds the
 * live window from the tail; `keepRecentFloor` guarantees at least `floor`
 * messages are summarized on `force`.
 */
function findCompactSplitIndex(args: {
	messages: Message[];
	trigger: "token" | "force";
	keepRecentTokens: number;
	keepRecentFloor: number;
}): number {
	const { messages, trigger, keepRecentTokens, keepRecentFloor } = args;
	const messageFloorIndex = alignSplitIndex(
		messages,
		Math.max(1, messages.length - keepRecentFloor),
	);

	let tokenCutIndex = messages.length;
	let accumulated = 0;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (!msg) continue;
		accumulated += estimateMessageTokens(msg);
		if (accumulated >= keepRecentTokens) {
			tokenCutIndex = alignSplitIndex(messages, i);
			break;
		}
	}
	if (tokenCutIndex >= messages.length) {
		if (trigger === "token") {
			return 0;
		}
		return alignSplitIndex(messages, Math.max(1, messages.length - 1));
	}
	// For force trigger the user explicitly asked to compact, so we must
	// always summarize at least `floor` messages worth — even when the
	// recent window already exceeds `keepRecentTokens` (in which case
	// `tokenCutIndex` collapses to 0 and `Math.min` would skip the
	// summary entirely). For token trigger we keep the conservative
	// `Math.min` so we never summarize more than either limit demands.
	if (trigger === "force") {
		return messageFloorIndex;
	}
	return Math.min(tokenCutIndex, messageFloorIndex);
}

// ---------------------------------------------------------------------------
// Micro-compact: stateless, non-mutating view for shrinking tool-result noise
// ---------------------------------------------------------------------------

/**
 * Derived, non-mutating view used to shrink working-context noise without a
 * model call and without touching the append-only entry stream. Old tool
 * results are replaced by an explicit elision placeholder that preserves
 * `name` + `toolCallId` (so tool_use/tool_result pairing stays intact); the
 * most-recent tool results up to a token budget, with a small floor, are kept
 * intact so the summary prompt and the model can still see recent tool output.
 *
 * Two rules protect the tool results the model is actively working with:
 *
 * 1. **The newest batch is pinned.** Every tool result belonging to the most
 *    recent assistant tool-call message is kept in full, whatever the token
 *    budget says. The tail token budget alone cannot guarantee this: a single
 *    step that reads several files at once can exceed `keepToolTokens` on its
 *    own, and without pinning the earlier results of that very batch would be
 *    elided before the model ever got to act on them.
 * 2. **Elision is never silent.** An elided result is replaced by
 *    {@link formatOmittedToolResult}, never by an empty string — an empty tool
 *    result reads as "the tool returned nothing" and provokes the model to
 *    re-issue the identical call forever.
 */
export function microCompactMessages(
	messages: Message[],
	options: {
		keepToolTokens?: number;
		floorToolResults?: number;
	} = {},
): Message[] {
	const keepToolTokens =
		options.keepToolTokens ?? MICRO_COMPACT_KEEP_TOOL_TOKENS;
	const floor = options.floorToolResults ?? MICRO_COMPACT_FLOOR_TOOL_RESULTS;
	let keptTokens = 0;
	let keptCount = 0;
	const keep = new Array<boolean>(messages.length).fill(false);

	for (const index of pinnedToolResultIndexes(messages)) {
		keep[index] = true;
		keptCount += 1;
		keptTokens += estimateMessageTokens(messages[index] as Message);
	}

	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role !== "tool" || keep[i]) {
			continue;
		}
		if (keptCount < floor || keptTokens < keepToolTokens) {
			keep[i] = true;
			keptCount += 1;
			keptTokens += estimateMessageTokens(message);
		}
	}
	return messages.map((message, i) => {
		if (message.role === "tool" && !keep[i]) {
			return makeOmittedToolMessage(message as ToolMessage);
		}
		return message;
	});
}

/**
 * Indexes of the tool results produced by the most recent assistant message
 * that requested tools — i.e. the batch the model has just received and has
 * not yet had a chance to use. Returns an empty list for shapes without such a
 * message (e.g. a bare run of tool messages), leaving the token budget in sole
 * charge.
 */
function pinnedToolResultIndexes(messages: Message[]): number[] {
	let pinnedCallIds: Set<string> | null = null;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role === "assistant" && message.toolCalls?.length) {
			pinnedCallIds = new Set(message.toolCalls.map((toolCall) => toolCall.id));
			break;
		}
	}
	if (!pinnedCallIds) {
		return [];
	}

	const indexes: number[] = [];
	for (let i = 0; i < messages.length; i += 1) {
		const message = messages[i];
		if (
			message?.role === "tool" &&
			message.toolCallId &&
			pinnedCallIds.has(message.toolCallId)
		) {
			indexes.push(i);
		}
	}
	return indexes;
}

function makeOmittedToolMessage(message: ToolMessage): ToolMessage {
	const original = message.content ?? "";
	// Nothing to reclaim, and a notice here would falsely assert that content
	// was dropped. A genuinely empty result stays empty.
	if (
		original.length === 0 ||
		original.startsWith(OMITTED_TOOL_RESULT_MARKER)
	) {
		return message;
	}
	return {
		...message,
		content: formatOmittedToolResult(message.name, original.length),
	};
}

/**
 * Pull a split index forward to the next message boundary that is not a tool
 * message, so a split never leaves an orphan tool result without its
 * assistant tool-call message.
 */
function alignSplitIndex(messages: Message[], splitIndex: number): number {
	let index = Math.min(splitIndex, messages.length);

	while (index < messages.length && messages[index]?.role === "tool") {
		index += 1;
	}

	return index;
}

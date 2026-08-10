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

const MICRO_COMPACT_KEEP_TOOL_TOKENS = 8_000;
const MICRO_COMPACT_FLOOR_TOOL_RESULTS = 3;

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
 * results are replaced by a placeholder that preserves `name` + `toolCallId`
 * (so tool_use/tool_result pairing stays intact); the most-recent tool results
 * up to a token budget, with a small floor, are kept intact so the summary
 * prompt and the model can still see recent tool output.
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
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role !== "tool") {
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

function makeOmittedToolMessage(message: ToolMessage): ToolMessage {
	return { ...message, content: "" };
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

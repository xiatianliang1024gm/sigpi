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
 * Micro-compaction budget used when the caller has no model window to scale
 * against: the default of the pure function, and the historical value this
 * project shipped before the budget became window-relative.
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
 * In production the budget is *not* this constant — it is
 * {@link microCompactToolTokenBudget} applied to the active model's window, so
 * a 200k window gets ~60k rather than a flat 32k. See that function for why.
 */
export const MICRO_COMPACT_KEEP_TOOL_TOKENS = 32_000;

/**
 * Share of the model's context window that may be held by verbatim tool
 * results. One fraction governs **both** micro-compaction paths — the request
 * view (`buildMessages`) and the slice the summarizer re-reads (`execute`) —
 * so the two can never disagree about how much raw tool output the window
 * affords.
 *
 * The earlier flat 32k was ~16% of the default 200k window, and a real session
 * showed why that is too small: a single implementation turn read ~100k tokens
 * of files, so a 32k budget evicted two thirds of the tool output the model had
 * just fetched — 55,879 tokens of the *current* turn's own results, which it
 * then re-read file by file (`transcript.js` four times, `manager.ts` five
 * times). 30% was the first correction; 60% is the settled value, chosen to hold
 * even a heavy implementation turn's working set so the model stops re-reading
 * what it just fetched.
 *
 * Not the whole window: the remaining ~40% still has to hold the system prompt,
 * tool schemas, conversation text, summary, and the summary model's own output
 * (the last sized by `reserveTokens` and the provider's `max_tokens` in
 * `summarizer.ts`). The fraction sits **above** the 10k–50k band the survey
 * above describes for comparable agents — deliberately: those agents elide older
 * turns, whereas this one keeps the running turn whole.
 */
export const MICRO_COMPACT_KEEP_TOOL_FRACTION = 0.6;

/**
 * Lower bound of the scaled budget. A small window (32k, 64k) must not be
 * budgeted a flat 32k of tool output, but nor should the budget collapse to
 * nothing: a couple of file reads have to fit for the agent to work at all.
 */
const MICRO_COMPACT_KEEP_TOOL_MIN_TOKENS = 8_000;

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
 * Scale the tool-result budget to the active model's window.
 *
 * Called by the context manager on every request (never cached — `/model
 * switch` must retarget it immediately, the same way `getContextBudget` does
 * for the full-compaction threshold) and again by `compact()` for the
 * summarized slice, so both paths share one window-relative number.
 */
export function microCompactToolTokenBudget(
	hardContextLimit?: number | null,
): number {
	if (
		typeof hardContextLimit !== "number" ||
		!Number.isFinite(hardContextLimit) ||
		hardContextLimit <= 0
	) {
		return MICRO_COMPACT_KEEP_TOOL_TOKENS;
	}

	return Math.max(
		MICRO_COMPACT_KEEP_TOOL_MIN_TOKENS,
		Math.round(hardContextLimit * MICRO_COMPACT_KEEP_TOOL_FRACTION),
	);
}

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
 * applies `microCompactMessages` (old tool results replaced by a
 * `[context-elided]` notice that preserves `name` + `toolCallId`) before
 * calling `summarize`. Returns the new summary and the provider-reported usage
 * of the summarize call.
 *
 * `keepToolTokens` is the budget for the verbatim tool results the summarizer
 * reads. The caller scales it to the active model's window with
 * {@link microCompactToolTokenBudget} — the same budget the request view uses,
 * so the slice and the window it came from agree. This function stays
 * window-agnostic, and when the budget is omitted it falls back to the flat
 * historical value (tests, legacy callers), the same default as the request
 * path.
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
	/** Budget for verbatim tool results in the summarized slice. */
	keepToolTokens?: number;
	abortSignal?: AbortSignal;
}): Promise<{ summary: string; usage?: ModelUsage }> {
	return summarize(input.provider, {
		systemPrompt: input.systemPrompt,
		messages: microCompactMessages(input.messages, {
			keepToolTokens: input.keepToolTokens,
		}),
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
 * What the planner decided about one request's tool results. Exposed so the
 * context manager can report the decision without recomputing it, and so tests
 * can assert on the decision instead of on rendered placeholder strings.
 */
export interface MicroCompactionPlan {
	/** Indexes (into `messages`) whose tool result is replaced by a notice. */
	elidedIndexes: ReadonlySet<number>;
	/** Tool results kept verbatim. */
	keptToolResults: number;
	/** Estimated tokens of the kept tool results. */
	keptTokens: number;
	/** Estimated tokens reclaimed (original content minus the notice). */
	elidedTokens: number;
	/** Effective budget for this request (already scaled by the caller). */
	budget: number;
}

export interface MicroCompactOptions {
	/** Token budget for tool results. Defaults to the flat legacy value. */
	keepToolTokens?: number;
	/** Minimum tool results kept regardless of the budget. */
	floorToolResults?: number;
	/**
	 * Tool-call ids that must never be elided ahead of older results — the
	 * results of the turn that is still running. Omitted when the caller cannot
	 * identify the current turn (tests, resume paths).
	 */
	protectedToolCallIds?: ReadonlySet<string>;
	/** Observes the plan; used for logging. Never mutates the decision. */
	onPlan?: (plan: MicroCompactionPlan) => void;
}

/**
 * Derived, non-mutating view used to shrink working-context noise without a
 * model call and without touching the append-only entry stream. An elided tool
 * result is replaced by an explicit placeholder that preserves `name` +
 * `toolCallId`, so the tool_use/tool_result pairing stays valid and an elided
 * result is never mistaken for a tool that returned nothing.
 *
 * Rules are listed in the order they are protected; rules 2–3 share one
 * token budget:
 *
 * 1. **The newest batch is pinned.** Every tool result belonging to the most
 *    recent assistant tool-call message is kept in full, whatever the budget
 *    says: one step that reads several files can exceed the entire budget by
 *    itself, and without pinning the earlier results of that very batch are
 *    elided before the model can act on them.
 * 2. **The running turn is frozen.** Every tool result of the turn that is
 *    still in flight is kept ahead of anything older, and the class is pruned
 *    only from its oldest end, as a last resort. What this buys is a guarantee
 *    about *priority*: no earlier turn's content can take room that the running
 *    turn's own results need. It does not buy unbounded room — a turn that
 *    reads more than the budget still loses its own oldest results, because the
 *    alternative is a request that cannot be sent.
 * 3. **The rest is a recency window**: the oldest results are dropped until the
 *    budget is met, lowest priority first.
 *
 * Two further rules were prototyped and deliberately **not** kept (see the
 * amendment in `docs/adr/0026-compaction-refactor.md`): pinning a working set
 * of file/range targets across turns, and dropping copies that a newer copy of
 * the same target supersedes. Both made the planner model *file identity* —
 * which read of which range is the current one, and how many tokens of it stay
 * pinned — to decide what the model still needs. That judgment belongs to the
 * model: the planner's only job is to pick what to drop when there is no room,
 * and it should stay simple enough to predict. The measured cost of not having
 * them is documented in the ADR rather than coded here.
 *
 * Determinism is a feature, not a side effect: the request prefix is the
 * prompt-cache key. Rules 1–2 are pure functions of the message list — a
 * finished turn stays finished — so their decisions never flip back and forth.
 * Only rule 3's boundary moves.
 */
export function microCompactMessages(
	messages: Message[],
	options: MicroCompactOptions = {},
): Message[] {
	const plan = planMicroCompaction(messages, options);
	options.onPlan?.(plan);
	if (plan.elidedIndexes.size === 0) {
		return [...messages];
	}

	return messages.map((message, index) =>
		plan.elidedIndexes.has(index) && message.role === "tool"
			? makeOmittedToolMessage(message as ToolMessage)
			: message,
	);
}

/**
 * Compute the elision decision for one request. Pure: no I/O, no state, no
 * mutation of `messages`.
 */
export function planMicroCompaction(
	messages: Message[],
	options: MicroCompactOptions = {},
): MicroCompactionPlan {
	const budget = options.keepToolTokens ?? MICRO_COMPACT_KEEP_TOOL_TOKENS;
	const floor = options.floorToolResults ?? MICRO_COMPACT_FLOOR_TOOL_RESULTS;
	const protectedIds = options.protectedToolCallIds;

	const toolIndexes: number[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		if (messages[index]?.role === "tool") {
			toolIndexes.push(index);
		}
	}
	if (toolIndexes.length === 0) {
		return {
			elidedIndexes: new Set<number>(),
			keptToolResults: 0,
			keptTokens: 0,
			elidedTokens: 0,
			budget,
		};
	}

	const tokens = new Map<number, number>();
	for (const index of toolIndexes) {
		tokens.set(index, estimateMessageTokens(messages[index] as ToolMessage));
	}

	// Rule 1 — the newest batch, plus results with nothing left to reclaim
	// (empty, or already a placeholder). Neither is ever pruned.
	const keep = new Set<number>(pinnedToolResultIndexes(messages));
	for (const index of toolIndexes) {
		if (!isReclaimable(messages[index] as ToolMessage)) {
			keep.add(index);
		}
	}
	let keptTokens = 0;
	for (const index of keep) {
		keptTokens += tokens.get(index) ?? 0;
	}

	// Rule 2 + 3 — the budgeted classes, highest priority first. Both lists are
	// built in ascending index order (message order is time order), so
	// reversing them yields "newest first" without a sort.
	const protectedIndexes: number[] = [];
	const recencyWindow: number[] = [];
	for (const index of toolIndexes) {
		if (keep.has(index)) {
			continue;
		}
		if (isProtected(messages[index] as ToolMessage, protectedIds)) {
			protectedIndexes.push(index);
			continue;
		}
		recencyWindow.push(index);
	}

	const priorityOrder = [
		// Both lists are newest-first: they were collected in message order
		// (oldest first), so reversing yields newest-first.
		...protectedIndexes.reverse(),
		...recencyWindow.reverse(),
	];
	for (const index of priorityOrder) {
		keep.add(index);
		keptTokens += tokens.get(index) ?? 0;
	}

	// Rule 3 — the budget is enforced by dropping from the lowest-priority end
	// of `priorityOrder`, so the frozen turn is only reached once everything
	// else is gone and a result that does not fit is the one dropped. The walk
	// stops as soon as the budget is met: pruning further (to a low-water mark)
	// was tried and rejected — the trigger is evaluated against the full
	// candidate mass, which includes everything already elided, so it stays true
	// on every later request and the boundary advances by one result per request
	// either way. Pruning past the budget would only lose more context.
	//
	// What this rule does guarantee is monotonicity: a result that has been
	// elided is never restored as the conversation grows, so a decision never
	// flips back and the request prefix changes only forward.
	// The frozen turn is *not* exempt here: when the running turn's own results
	// exceed the whole budget, its oldest ones have to go like any others. That
	// is the safety valve — the alternative is a request that cannot be sent.
	let keptCount = keep.size;
	for (
		let cursor = priorityOrder.length - 1;
		cursor >= 0 && keptTokens > budget && keptCount > floor;
		cursor -= 1
	) {
		const index = priorityOrder[cursor] as number;
		if (!keep.delete(index)) {
			continue;
		}
		keptTokens -= tokens.get(index) ?? 0;
		keptCount -= 1;
	}

	const elided = new Set<number>();
	let elidedTokens = 0;
	for (const index of toolIndexes) {
		if (keep.has(index)) {
			continue;
		}
		elided.add(index);
		const message = messages[index] as ToolMessage;
		elidedTokens += Math.max(
			0,
			(tokens.get(index) ?? 0) -
				estimateMessageTokens({
					...message,
					content: formatOmittedToolResult(
						message.name,
						message.content.length,
					),
				}),
		);
	}

	return {
		elidedIndexes: elided,
		keptToolResults: toolIndexes.length - elided.size,
		keptTokens,
		elidedTokens,
		budget,
	};
}

function isProtected(
	message: ToolMessage,
	protectedIds?: ReadonlySet<string>,
): boolean {
	return protectedIds?.has(message.toolCallId) ?? false;
}

/**
 * Whether eliding this result reclaims anything. An empty result, and a result
 * that is already a placeholder, are left exactly as they are: a notice there
 * would either be false ("content was dropped" when there was none) or a
 * second rewrite of the same message, which is pure prefix churn.
 */
function isReclaimable(message: ToolMessage): boolean {
	const content = message.content ?? "";
	return content.length > 0 && !content.startsWith(OMITTED_TOOL_RESULT_MARKER);
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

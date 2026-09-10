import { formatCompactNumber } from "../format.js";
import type { SessionEntry } from "../types.js";

/**
 * Projection of the persisted session entry stream into the UI-neutral,
 * renderable shape the browser client consumes for a resumed session's history.
 * Kept on the server (and free of any DOM) so the projection is unit-testable
 * and the web client stays a dumb renderer — the same seam principle the SSE
 * reducer follows for live turns.
 */

/** Default number of entries returned per history page. */
export const DEFAULT_HISTORY_LIMIT = 30;

/** Upper bound so a caller cannot request an unbounded page. */
export const MAX_HISTORY_LIMIT = 200;

/**
 * One renderable line of history. `user`/`assistant` mirror the transcript
 * bubbles; `tool` is a completed tool-call line (name only — tool output can be
 * arbitrarily large and is not part of the readable transcript); `compaction`
 * is a context-window notice, matching the live `context_compacted` line.
 */
export type HistoryItem =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string; reasoning: string | null }
	| { kind: "tool"; name: string }
	| { kind: "compaction"; text: string };

export interface HistoryPage {
	/** Page items in chronological order (oldest first). */
	items: HistoryItem[];
	/**
	 * Exclusive end index of the oldest entry in this page. Pass it back as
	 * `before` to fetch the next older page; `null` once the start of the
	 * session is reached (no older entries remain).
	 */
	cursor: number | null;
}

/**
 * Slice a persisted entry stream into one newest-biased page.
 *
 * `before` is an exclusive end index into `entries` (default: the whole
 * stream), and `limit` bounds the page size. Because older indices never shift
 * when new turns append at the end, the returned `cursor` is a stable handle a
 * client can page backwards with by passing it back as `before`.
 */
export function projectHistoryPage(
	entries: readonly SessionEntry[],
	options: { before?: number; limit?: number } = {},
): HistoryPage {
	const limit = clampLimit(options.limit);
	const end = clampIndex(options.before, entries.length);
	const start = Math.max(0, end - limit);
	const items: HistoryItem[] = [];
	for (const entry of entries.slice(start, end)) {
		const item = toHistoryItem(entry);
		if (item) {
			items.push(item);
		}
	}
	return { items, cursor: start > 0 ? start : null };
}

/** Project one persisted entry to a renderable item, or `null` to skip it. */
function toHistoryItem(entry: SessionEntry): HistoryItem | null {
	if (entry.kind === "compaction") {
		return { kind: "compaction", text: formatCompaction(entry) };
	}
	const message = entry.message;
	if (message.role === "user") {
		return { kind: "user", text: message.content };
	}
	if (message.role === "assistant") {
		const reasoning = message.reasoning ?? null;
		const text = message.content ?? "";
		// Tool-only steps produce an empty assistant message; the tool line
		// already conveys the activity, so an empty bubble is noise.
		if (!text && !reasoning) {
			return null;
		}
		return { kind: "assistant", text, reasoning };
	}
	if (message.role === "tool") {
		return { kind: "tool", name: message.name };
	}
	// System messages are synthesized per request and never persisted.
	return null;
}

function formatCompaction(
	entry: Extract<SessionEntry, { kind: "compaction" }>,
): string {
	const before = entry.tokensBefore ?? 0;
	const after = entry.tokensAfter ?? 0;
	if (before > 0 || after > 0) {
		return `Context compacted: context window ${formatCompactNumber(before)} → ${formatCompactNumber(after)} tokens.`;
	}
	return "Context compacted.";
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return DEFAULT_HISTORY_LIMIT;
	}
	return Math.min(MAX_HISTORY_LIMIT, Math.max(1, Math.floor(limit)));
}

function clampIndex(value: number | undefined, max: number): number {
	if (value === undefined || !Number.isFinite(value)) {
		return max;
	}
	return Math.min(max, Math.max(0, Math.floor(value)));
}

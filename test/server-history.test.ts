import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_HISTORY_LIMIT,
	type HistoryItem,
	MAX_HISTORY_LIMIT,
	projectHistoryPage,
} from "../src/server/history.js";
import type { SessionEntry } from "../src/types.js";

let seq = 0;
const nextId = () => `e${++seq}`;

/** The human-readable text of any history item (tool items use `name`). */
function textOf(item: HistoryItem | undefined): string {
	if (!item) {
		return "";
	}
	return item.kind === "tool" ? item.name : item.text;
}

function userEntry(text: string): SessionEntry {
	const id = nextId();
	return {
		kind: "message",
		id,
		turnId: null,
		timestamp: "2025-01-01T00:00:00.000Z",
		message: { role: "user", content: text, id },
	};
}

function assistantEntry(text: string, reasoning?: string): SessionEntry {
	const id = nextId();
	return {
		kind: "message",
		id,
		turnId: null,
		timestamp: "2025-01-01T00:00:00.000Z",
		message: { role: "assistant", content: text, reasoning, id },
	};
}

function toolEntry(name: string, toolCallId = nextId()): SessionEntry {
	const id = nextId();
	return {
		kind: "message",
		id,
		turnId: null,
		timestamp: "2025-01-01T00:00:00.000Z",
		message: { role: "tool", name, toolCallId, content: "...", id },
	};
}

/** An assistant step that issued one tool call, so a later tool line can find it. */
function toolCallEntry(
	toolCallId: string,
	name: string,
	args: Record<string, unknown>,
): SessionEntry {
	const id = nextId();
	return {
		kind: "message",
		id,
		turnId: null,
		timestamp: "2025-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: null,
			id,
			toolCalls: [
				{
					id: toolCallId,
					name,
					arguments: args,
					rawArguments: JSON.stringify(args),
				},
			],
		},
	};
}

function compactionEntry(tokensBefore = 0, tokensAfter = 0): SessionEntry {
	return {
		kind: "compaction",
		id: nextId(),
		parentId: null,
		timestamp: "2025-01-01T00:00:00.000Z",
		summary: "summary",
		firstKeptEntryId: null,
		tokensBefore,
		tokensAfter,
	};
}

test("projects each entry kind into a renderable item", () => {
	const entries: SessionEntry[] = [
		userEntry("hi"),
		assistantEntry("hello", "thinking"),
		toolEntry("read"),
		compactionEntry(1000, 200),
	];
	const { items, cursor } = projectHistoryPage(entries, { limit: 10 });

	assert.equal(cursor, null);
	assert.deepEqual(items, [
		{ kind: "user", text: "hi" },
		{ kind: "assistant", text: "hello", reasoning: "thinking" },
		{ kind: "tool", name: "read", label: "read" },
		{
			kind: "compaction",
			text: "Context compacted: context window 1K → 200 tokens.",
		},
	]);
});

test("reconstructs a tool line's label from the persisted tool call", () => {
	const callId = "call-1";
	const entries: SessionEntry[] = [
		toolCallEntry(callId, "bash", { command: "git status" }),
		toolEntry("bash", callId),
	];

	const { items } = projectHistoryPage(entries, {
		limit: 10,
		describeToolCall: (call) => `shell ${String(call.arguments.command)}`,
	});

	// The assistant tool-call step has no text/reasoning, so it is skipped; the
	// tool line carries the reconstructed label instead of the bare name.
	assert.deepEqual(items, [
		{ kind: "tool", name: "bash", label: "shell git status" },
	]);
});

test("a tool line falls back to the tool name when no describer is given", () => {
	const callId = "call-1";
	const entries: SessionEntry[] = [
		toolCallEntry(callId, "bash", { command: "git status" }),
		toolEntry("bash", callId),
	];

	const { items } = projectHistoryPage(entries, { limit: 10 });
	assert.deepEqual(items, [{ kind: "tool", name: "bash", label: "bash" }]);
});

test("a tool line falls back to the tool name when its call is missing or throwing", () => {
	const orphan = toolEntry("bash", "no-such-call");
	const thrown = toolEntry("bash", "call-2");
	const entries: SessionEntry[] = [
		toolCallEntry("call-2", "bash", {}),
		orphan,
		thrown,
	];

	const { items } = projectHistoryPage(entries, {
		limit: 10,
		describeToolCall: () => {
			throw new Error("tool no longer registered");
		},
	});

	assert.deepEqual(items, [
		{ kind: "tool", name: "bash", label: "bash" },
		{ kind: "tool", name: "bash", label: "bash" },
	]);
});

test("an assistant step with no text or reasoning is skipped", () => {
	const entries: SessionEntry[] = [assistantEntry(""), userEntry("hi")];
	const { items } = projectHistoryPage(entries, { limit: 10 });
	assert.deepEqual(items, [{ kind: "user", text: "hi" }]);
});

test("the default page is the newest slice with a cursor to older entries", () => {
	const entries = Array.from({ length: 75 }, (_, i) => userEntry(`m${i}`));

	const first = projectHistoryPage(entries);
	assert.equal(first.items.length, DEFAULT_HISTORY_LIMIT);
	assert.equal(textOf(first.items[0]), `m${75 - DEFAULT_HISTORY_LIMIT}`);
	assert.equal(textOf(first.items.at(-1)), "m74");
	assert.equal(first.cursor, 75 - DEFAULT_HISTORY_LIMIT);
});

test("paging backwards via the cursor walks to the start exactly once", () => {
	const entries = Array.from({ length: 70 }, (_, i) => userEntry(`m${i}`));

	// Each page is internally chronological; prepending page-by-page (newest
	// first) reconstructs the full stream in order.
	const collected: string[] = [];
	let before: number | undefined;
	let cursor: number | null = null;
	let pages = 0;
	do {
		const page = projectHistoryPage(entries, { before, limit: 30 });
		collected.unshift(...page.items.map(textOf));
		cursor = page.cursor;
		before = cursor ?? undefined;
		pages += 1;
	} while (cursor !== null);

	assert.equal(pages, 3);
	assert.deepEqual(
		collected,
		Array.from({ length: 70 }, (_, i) => `m${i}`),
	);
});

test("limit is clamped to the supported range", () => {
	const entries = Array.from({ length: MAX_HISTORY_LIMIT + 50 }, (_, i) =>
		userEntry(`m${i}`),
	);
	assert.equal(
		projectHistoryPage(entries, { limit: 10_000 }).items.length,
		MAX_HISTORY_LIMIT,
	);
	assert.equal(projectHistoryPage(entries, { limit: 0 }).items.length, 1);
});

test("an empty stream yields an empty page and no cursor", () => {
	assert.deepEqual(projectHistoryPage([]), { items: [], cursor: null });
});

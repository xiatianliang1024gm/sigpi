import assert from "node:assert/strict";
import test from "node:test";
import { buildTranscriptComponents } from "../src/tui/transcript-replay.js";
import type { SessionEntry } from "../src/types.js";

function userEntry(content: string): SessionEntry {
	return {
		kind: "message",
		id: `m-${content}`,
		turnId: 1,
		timestamp: "2026-05-22T00:01:00.000Z",
		message: { role: "user", content, id: `m-${content}` },
	};
}

function assistantEntry(
	content: string | null,
	reasoning?: string,
): SessionEntry {
	return {
		kind: "message",
		id: `m-a-${content ?? "none"}`,
		turnId: 1,
		timestamp: "2026-05-22T00:02:00.000Z",
		message: {
			role: "assistant",
			content,
			...(reasoning ? { reasoning } : {}),
			id: "m-a",
		},
	};
}

function toolEntry(name: string, content: string): SessionEntry {
	return {
		kind: "message",
		id: `m-t-${name}`,
		turnId: 1,
		timestamp: "2026-05-22T00:03:00.000Z",
		message: { role: "tool", name, toolCallId: "call-1", content, id: "m-t" },
	};
}

function compactionEntry(
	summary: string,
	tokens?: [number, number],
): SessionEntry {
	return {
		kind: "compaction",
		id: "compaction-1",
		parentId: null,
		timestamp: "2026-05-22T00:04:00.000Z",
		summary,
		firstKeptEntryId: null,
		...(tokens ? { tokensBefore: tokens[0], tokensAfter: tokens[1] } : {}),
	};
}

test("buildTranscriptComponents maps user/assistant/tool messages to transcript components", () => {
	const components = buildTranscriptComponents([
		userEntry("hello"),
		assistantEntry("hi there", "let me think"),
		toolEntry("bash", "ok: true"),
		assistantEntry("done"),
	]);

	const lines = components.flatMap((component) => component.render(80));
	assert.ok(lines.some((line) => line.includes("❯ hello")));
	assert.ok(lines.some((line) => line.includes("let me think")));
	assert.ok(lines.some((line) => line.includes("hi there")));
	assert.ok(lines.some((line) => line.includes("⎿ bash")));
	assert.ok(lines.some((line) => line.includes("done")));
});

test("buildTranscriptComponents renders failed tool messages with their error", () => {
	const components = buildTranscriptComponents([
		toolEntry(
			"bash",
			"TOOL: bash\nSTATUS: error\nERROR: command not found: nope",
		),
	]);

	const lines = components.flatMap((component) => component.render(80));
	assert.ok(lines.some((line) => line.includes("⎿ bash")));
	assert.ok(
		lines.some((line) => line.includes("command not found: nope")),
		"failed tool error should be visible on the tool line",
	);
});

test("buildTranscriptComponents renders compaction entries with the token window, not the summary body", () => {
	const components = buildTranscriptComponents([
		compactionEntry("summarized earlier work", [12_345, 6_789]),
	]);

	const lines = components.flatMap((component) => component.render(80));
	assert.ok(lines.some((line) => line.includes("Context compacted")));
	assert.ok(
		lines.some((line) => line.includes("12.3K → 6.8K tokens.")),
		"window change should match the live context_compacted status line",
	);
	assert.equal(
		lines.some((line) => line.includes("summarized earlier work")),
		false,
		"the summary body is not meaningful in a replay and must not be shown",
	);
});

test("buildTranscriptComponents falls back to a plain notice when the token snapshot is missing", () => {
	const components = buildTranscriptComponents([
		compactionEntry("summarized earlier work"),
	]);

	const lines = components.flatMap((component) => component.render(80));
	assert.ok(lines.some((line) => line.includes("Context compacted")));
	assert.equal(
		lines.some((line) => line.includes("summarized earlier work")),
		false,
		"the summary body must never be shown",
	);
});

test("buildTranscriptComponents returns an empty list for an empty stream", () => {
	assert.deepEqual(buildTranscriptComponents([]), []);
});

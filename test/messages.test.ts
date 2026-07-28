import assert from "node:assert/strict";
import test from "node:test";
import {
	createAssistantMessage,
	renderMessagesForSummary,
} from "../src/agent/messages.js";

test("createAssistantMessage omits reasoning when none was provided", () => {
	const message = createAssistantMessage("hello");
	assert.equal(message.role, "assistant");
	assert.equal(message.content, "hello");
	assert.equal(message.reasoning, undefined);
});

test("createAssistantMessage persists reasoning when supplied", () => {
	const message = createAssistantMessage("hello", undefined, {
		reasoning: "let me think this through",
	});
	assert.equal(message.content, "hello");
	assert.equal(message.reasoning, "let me think this through");
});

test("createAssistantMessage persists reasoning alongside tool calls", () => {
	const message = createAssistantMessage(
		null,
		[
			{
				id: "c1",
				name: "grep",
				arguments: { q: "x" },
				rawArguments: '{"q":"x"}',
			},
		],
		{
			reasoning: "the user wants me to grep first",
		},
	);
	assert.equal(message.content, null);
	assert.equal(message.toolCalls?.[0]?.name, "grep");
	assert.equal(message.reasoning, "the user wants me to grep first");
});

test("createAssistantMessage drops empty / whitespace-only reasoning", () => {
	const message = createAssistantMessage("hello", undefined, {
		reasoning: "   \n\t  ",
	});
	assert.equal(message.reasoning, undefined);
});

test("renderMessagesForSummary renders a plain assistant message without reasoning", () => {
	const transcript = renderMessagesForSummary([
		{ role: "assistant", content: "hi", id: "a1" },
	]);
	assert.equal(transcript, "[assistant] hi");
});

test("renderMessagesForSummary emits reasoning on a line below the answer", () => {
	const transcript = renderMessagesForSummary([
		{
			role: "assistant",
			content: "42",
			reasoning: "user asked a numeric question",
			id: "a1",
		},
	]);
	assert.equal(
		transcript,
		[
			"[assistant] 42",
			"[assistant reasoning] user asked a numeric question",
		].join("\n"),
	);
});

test("renderMessagesForSummary emits reasoning alongside tool calls", () => {
	const transcript = renderMessagesForSummary([
		{
			role: "assistant",
			content: null,
			reasoning: "I need to inspect the file first",
			toolCalls: [
				{
					id: "c1",
					name: "read",
					arguments: { file_path: "/tmp/x" },
					rawArguments: '{"file_path":"/tmp/x"}',
				},
			],
			id: "a1",
		},
	]);
	// Order: tool_calls header line first, reasoning line second.
	assert.equal(
		transcript,
		[
			'[assistant] tool_calls=read({"file_path":"/tmp/x"})',
			"[assistant reasoning] I need to inspect the file first",
		].join("\n"),
	);
});

test("renderMessagesForSummary does not emit a reasoning line for empty reasoning", () => {
	const transcript = renderMessagesForSummary([
		{ role: "assistant", content: "hi", id: "a1" },
	]);
	assert.equal(transcript.includes("[assistant reasoning]"), false);
});

test("renderMessagesForSummary truncates very long reasoning to the summary budget", () => {
	const long = "x".repeat(5000);
	const transcript = renderMessagesForSummary([
		{
			role: "assistant",
			content: "done",
			reasoning: long,
			id: "a1",
		},
	]);
	const reasoningPrefix = "[assistant reasoning] ";
	// `truncateForSummary` (shared with tool results) caps the body at
	// `SUMMARY_TOOL_CONTENT_MAX_CHARS` (2_000) and appends a truncation marker
	// on a new line. The first `[assistant reasoning]` line should fit inside
	// that budget plus the prefix, and the transcript should carry the marker.
	const firstReasoningLine = transcript
		.split("\n")
		.find((line) => line.startsWith(reasoningPrefix));
	assert.ok(firstReasoningLine);
	assert.ok(
		firstReasoningLine.length <=
			reasoningPrefix.length + 2_000 + /* slack for any future tweak */ 32,
		`expected reasoning line to be budget-capped, got length ${firstReasoningLine.length}`,
	);
	assert.match(transcript, /truncated/);
});

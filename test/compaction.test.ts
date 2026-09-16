import assert from "node:assert/strict";
import test from "node:test";
import {
	decide,
	execute,
	MICRO_COMPACT_KEEP_TOOL_TOKENS,
	microCompactMessages,
} from "../src/agent/compaction.js";
import {
	createAssistantMessage,
	createToolMessage,
} from "../src/agent/messages.js";
import { ModelRequestError } from "../src/model/transport.js";
import type { Message, ModelUsage, ToolSchema } from "../src/types.js";
import { MockProvider } from "./helpers.js";

const SYSTEM_PROMPT = "You are a test agent.";
const NO_TOOLS: readonly ToolSchema[] = [];
const BUDGET = {
	hardContextLimit: 40,
	reserveTokens: 2,
	keepRecentTokens: 5,
};

function tokenMessage(content: string, tokens: number): Message {
	// estimateMessageTokens = ceil((content.length + 16) / 4), so pad the
	// content until the estimate reaches `tokens`.
	const targetChars = tokens * 4 - 16;
	const padding = "x".repeat(Math.max(0, targetChars - content.length));
	return { role: "user", content: content + padding };
}

test("decide does not compact when the estimate is under the soft limit", () => {
	const result = decide({
		messages: [{ role: "user", content: "hi" }],
		budget: BUDGET,
		keepRecentFloor: 2,
		systemPrompt: SYSTEM_PROMPT,
		toolSchemas: NO_TOOLS,
	});

	assert.deepEqual(result, { shouldCompact: false, splitIndex: 0 });
});

test("decide triggers on a token overshoot and splits at the recent-window boundary", () => {
	const messages = [
		tokenMessage("u1", 30),
		tokenMessage("a1", 30),
		tokenMessage("u2", 30),
	];
	const result = decide({
		messages,
		budget: BUDGET,
		keepRecentFloor: 2,
		systemPrompt: SYSTEM_PROMPT,
		toolSchemas: NO_TOOLS,
	});

	// 10 system + 90 messages = 100 > 38 soft limit. The tail message alone
	// exceeds keepRecentTokens, so the split lands at the floor boundary (1):
	// the first message is summarized, the rest stay live.
	assert.deepEqual(result, { shouldCompact: true, splitIndex: 1 });
});

test("decide includes pendingUserInput in the estimate but never splits buffered input", () => {
	// Without the pending input the window fits; with it, the estimate is over
	// the soft limit but the split index is 0 (nothing persisted can be
	// summarized) — exactly the "overshoot lives in the turn buffer" case the
	// runner tolerates by proceeding with the request.
	const without = decide({
		messages: [{ role: "user", content: "hi" }],
		budget: BUDGET,
		keepRecentFloor: 2,
		systemPrompt: SYSTEM_PROMPT,
		toolSchemas: NO_TOOLS,
	});
	assert.equal(without.shouldCompact, false);

	const withPending = decide({
		messages: [{ role: "user", content: "hi" }],
		budget: BUDGET,
		keepRecentFloor: 2,
		systemPrompt: SYSTEM_PROMPT,
		toolSchemas: NO_TOOLS,
		pendingUserInput: "x".repeat(100),
	});
	assert.equal(withPending.shouldCompact, true);
	assert.equal(withPending.splitIndex, 0);
});

test("decide returns no split when a token trigger cannot reach keepRecentTokens", () => {
	// The window is over the soft limit, but keepRecentTokens is huge, so the
	// token scan never accumulates enough and the token trigger declines to
	// summarize anything.
	const result = decide({
		messages: [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "ok" },
		],
		budget: {
			hardContextLimit: 19,
			reserveTokens: 0,
			keepRecentTokens: 1_000_000,
		},
		keepRecentFloor: 2,
		systemPrompt: SYSTEM_PROMPT,
		toolSchemas: NO_TOOLS,
	});

	assert.deepEqual(result, { shouldCompact: true, splitIndex: 0 });
});

test("decide force keeps at least one message when the recent window is tiny", () => {
	// A force compaction of 3 short messages must still summarize something:
	// the early-return branch keeps exactly one message live.
	const messages: Message[] = [
		{ role: "user", content: "hi" },
		{ role: "assistant", content: "ok" },
		{ role: "user", content: "bye" },
	];
	const result = decide({
		messages,
		budget: {
			hardContextLimit: 19,
			reserveTokens: 0,
			keepRecentTokens: 1_000_000,
		},
		keepRecentFloor: 2,
		systemPrompt: SYSTEM_PROMPT,
		toolSchemas: NO_TOOLS,
		force: true,
	});

	assert.deepEqual(result, { shouldCompact: true, splitIndex: 2 });
});

test("decide never splits inside a tool-result group", () => {
	// Both the floor (index 3) and the token scan want a cut near the tool
	// group; alignment must push the split past the tool results so the
	// summarized slice keeps the whole group intact and no tool message is
	// orphaned on its own.
	const messages: Message[] = [
		tokenMessage("u1", 30),
		createAssistantMessage(null, [
			{
				id: "call_1",
				name: "glob",
				arguments: { pattern: "**" },
				rawArguments: '{"pattern":"**"}',
			},
			{
				id: "call_2",
				name: "read",
				arguments: { file_path: "a.ts" },
				rawArguments: '{"file_path":"a.ts"}',
			},
		]),
		createToolMessage("call_1", "glob", { ok: true, data: { files: [] } }),
		createToolMessage("call_2", "read", { ok: true, data: { content: "x" } }),
		tokenMessage("u2", 10),
	];
	const result = decide({
		messages,
		budget: BUDGET,
		keepRecentFloor: 2,
		systemPrompt: SYSTEM_PROMPT,
		toolSchemas: NO_TOOLS,
	});

	assert.equal(result.shouldCompact, true);
	assert.equal(result.splitIndex, 4);
	assert.notEqual(messages[result.splitIndex]?.role, "tool");
	assert.deepEqual(
		messages.slice(result.splitIndex).map((message) => message.role),
		["user"],
	);
	// The summarized slice contains the full tool-result group, not a lone
	// tool message.
	assert.deepEqual(
		messages.slice(0, result.splitIndex).map((message) => message.role),
		["user", "assistant", "tool", "tool"],
	);
});

test("microCompactMessages replaces old tool results with an explicit notice but keeps recent ones", () => {
	const messages: Message[] = [
		{ role: "user", content: "u" },
		createAssistantMessage(null, [
			{
				id: "call_old",
				name: "bash",
				arguments: { command: "ls" },
				rawArguments: '{"command":"ls"}',
			},
		]),
		createToolMessage("call_old", "bash", {
			ok: true,
			data: { stdout: "old huge output".repeat(20) },
		}),
		createAssistantMessage(null, [
			{
				id: "call_recent",
				name: "bash",
				arguments: { command: "pwd" },
				rawArguments: '{"command":"pwd"}',
			},
		]),
		createToolMessage("call_recent", "bash", {
			ok: true,
			data: { stdout: "recent output" },
		}),
	];

	const compacted = microCompactMessages(messages, {
		keepToolTokens: 0,
		floorToolResults: 1,
	});

	const toolMessages = compacted.filter((message) => message.role === "tool");
	assert.equal(toolMessages.length, 2);
	// An elided result must be self-describing. Blanking it would be
	// indistinguishable from a tool that genuinely returned nothing, which is
	// what made the model re-run the same call in a loop.
	assert.notEqual(toolMessages[0]?.content, "");
	assert.match(toolMessages[0]?.content ?? "", /^\[context-elided\]/);
	assert.match(toolMessages[0]?.content ?? "", /not empty/);
	assert.match(toolMessages[0]?.content ?? "", /the call succeeded/);
	// The tool_use/tool_result pairing survives elision.
	assert.equal(toolMessages[0]?.toolCallId, "call_old");
	assert.equal(toolMessages[0]?.name, "bash");
	assert.match(toolMessages[1]?.content ?? "", /recent output/);
	// Non-tool messages are untouched.
	assert.equal(compacted[0]?.content, "u");
});

test("microCompactMessages never elides the batch the model just received", () => {
	// Each result alone blows the entire tool-result budget, so the tail budget
	// cannot keep them — only pinning the newest batch can. Regression guard:
	// before pinning, the first reads of a multi-file batch were blanked before
	// the model could act on them, so it re-read the same files forever.
	const huge = (id: string, marker: string) =>
		createToolMessage(id, "read", {
			ok: true,
			data: { rendered: `${marker}${"x".repeat(60_000)}` },
		});
	const messages: Message[] = [
		{ role: "user", content: "u" },
		createAssistantMessage(null, [
			{
				id: "call_a",
				name: "read",
				arguments: { file_path: "a.ts" },
				rawArguments: '{"file_path":"a.ts"}',
			},
			{
				id: "call_b",
				name: "read",
				arguments: { file_path: "b.ts" },
				rawArguments: '{"file_path":"b.ts"}',
			},
			{
				id: "call_c",
				name: "read",
				arguments: { file_path: "c.ts" },
				rawArguments: '{"file_path":"c.ts"}',
			},
		]),
		huge("call_a", "AAA"),
		huge("call_b", "BBB"),
		huge("call_c", "CCC"),
	];

	const compacted = microCompactMessages(messages, {
		keepToolTokens: 0,
		floorToolResults: 0,
	});

	const toolMessages = compacted.filter((message) => message.role === "tool");
	assert.equal(toolMessages.length, 3);
	assert.match(toolMessages[0]?.content ?? "", /AAA/);
	assert.match(toolMessages[1]?.content ?? "", /BBB/);
	assert.match(toolMessages[2]?.content ?? "", /CCC/);
});

test("microCompactMessages leaves genuinely empty tool results untouched", () => {
	const messages: Message[] = [
		{ role: "user", content: "u" },
		createAssistantMessage(null, [
			{
				id: "call_empty",
				name: "glob",
				arguments: { pattern: "nope" },
				rawArguments: '{"pattern":"nope"}',
			},
		]),
		createToolMessage("call_empty", "glob", { ok: true, data: "" }),
	];

	const compacted = microCompactMessages(messages, {
		keepToolTokens: 0,
		floorToolResults: 0,
	});

	// Nothing was reclaimed, so claiming content was "dropped" would be a lie.
	assert.equal(compacted[2]?.role, "tool");
	assert.equal(compacted[2]?.content, "");
});

test("microCompactMessages reports elision instead of blanking results (session regression)", () => {
	// Mirrors the reported session: the model reads index.html plus two other
	// files in one step, then reads three more files, then two more. The total
	// output is about 1.5x the tool-result budget, so the tail budget must evict
	// the earliest batch — and the model has to be told that explicitly rather
	// than being handed an empty string it reads as "the file is empty".
	//
	// Sizes are expressed as fractions of the budget so the fixture keeps its
	// shape if the budget is retuned.
	const budgetChars = MICRO_COMPACT_KEEP_TOOL_TOKENS * 4;
	const read = (id: string, budgetFraction: number) =>
		createToolMessage(id, "read", {
			ok: true,
			data: { rendered: "x".repeat(Math.round(budgetChars * budgetFraction)) },
		});
	const call = (id: string, file: string) => ({
		id,
		name: "read",
		arguments: { file_path: file },
		rawArguments: `{"file_path":"${file}"}`,
	});

	// Fractions sum to 1.5x the budget; the batch shapes match the session.
	const messages: Message[] = [
		{ role: "user", content: "u" },
		createAssistantMessage(null, [
			call("c1", "index.html"),
			call("c2", "sidebar.js"),
			call("c3", "transcript.js"),
		]),
		read("c1", 0.09),
		read("c2", 0.12),
		read("c3", 0.31),
		createAssistantMessage(null, [
			call("c4", "tree.js"),
			call("c5", "markdown.js"),
			call("c6", "dom.js"),
		]),
		read("c4", 0.22),
		read("c5", 0.35),
		read("c6", 0.04),
		createAssistantMessage(null, [
			call("c7", "app.js"),
			call("c8", "sessions.js"),
		]),
		read("c7", 0.13),
		read("c8", 0.24),
	];

	const compacted = microCompactMessages(messages);
	const toolMessages = compacted.filter(
		(message) => message.role === "tool",
	) as Array<{ content: string; toolCallId: string; name: string }>;

	// No tool result is ever blanked.
	for (const message of toolMessages) {
		assert.notEqual(
			message.content,
			"",
			`${message.toolCallId} was blanked instead of being reported as elided`,
		);
	}
	// The newest batch is intact and usable.
	const newest = toolMessages.slice(-2);
	assert.match(newest[0]?.content ?? "", /^x+$/);
	assert.match(newest[1]?.content ?? "", /^x+$/);
	// The evicted older results announce themselves.
	const evicted = toolMessages.filter((message) =>
		message.content.startsWith("[context-elided]"),
	);
	assert.ok(
		evicted.length > 0,
		"expected the older batch to be elided at this size",
	);
	assert.ok(evicted.some((message) => message.toolCallId === "c1"));
});

test("execute summarizes the pre-split window and returns the summary and usage", async () => {
	const usage: ModelUsage = {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
	};
	const provider = new MockProvider((request) => {
		assert.equal(request.context?.purpose, "summary");
		assert.equal(request.tools.length, 0);
		assert.match(
			request.messages.at(-1)?.content ?? "",
			/transcript above is conversation history/i,
		);
		return {
			assistantText:
				"<analysis>scratch</analysis><summary>Structured summary.</summary>",
			toolCalls: [],
			finishReason: "stop",
			usage,
		};
	});

	const result = await execute({
		provider,
		systemPrompt: SYSTEM_PROMPT,
		messages: [
			{ role: "user", content: "investigate the bug" },
			{ role: "assistant", content: "found it" },
		],
		previousSummary: null,
		reserveTokens: 100,
	});

	assert.equal(result.summary, "Structured summary.");
	assert.deepEqual(result.usage, usage);
});

test("execute propagates a provider failure so the orchestrator can wrap it", async () => {
	const provider = new MockProvider(() => {
		throw new ModelRequestError("connection reset", "network_error");
	});

	await assert.rejects(
		execute({
			provider,
			systemPrompt: SYSTEM_PROMPT,
			messages: [{ role: "user", content: "hi" }],
			previousSummary: null,
			reserveTokens: 100,
		}),
		(error) =>
			error instanceof ModelRequestError && error.kind === "network_error",
	);
});

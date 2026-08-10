import assert from "node:assert/strict";
import test from "node:test";
import {
	decide,
	execute,
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

test("microCompactMessages empties old tool results but keeps recent ones", () => {
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
	assert.equal(toolMessages[0]?.content, "");
	assert.equal(toolMessages[0]?.toolCallId, "call_old");
	assert.equal(toolMessages[0]?.name, "bash");
	assert.match(toolMessages[1]?.content ?? "", /recent output/);
	// Non-tool messages are untouched.
	assert.equal(compacted[0]?.content, "u");
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

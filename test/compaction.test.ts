import assert from "node:assert/strict";
import test from "node:test";
import {
	decide,
	execute,
	MICRO_COMPACT_KEEP_TOOL_FRACTION,
	MICRO_COMPACT_KEEP_TOOL_TOKENS,
	microCompactMessages,
	microCompactToolTokenBudget,
	planMicroCompaction,
} from "../src/agent/compaction.js";
import {
	createAssistantMessage,
	createToolMessage,
} from "../src/agent/messages.js";
import { estimateMessageTokens } from "../src/context-window.js";
import { ModelRequestError } from "../src/model/transport.js";
import type {
	Message,
	ModelUsage,
	ToolMessage,
	ToolSchema,
} from "../src/types.js";
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

// ---------------------------------------------------------------------------
// Micro-compaction policy: turn freeze, working set, budget scaling, hysteresis
// ---------------------------------------------------------------------------

function toolCall(id: string, name: string, args: Record<string, unknown>) {
	return { id, name, arguments: args, rawArguments: JSON.stringify(args) };
}

/** A tool result whose estimated size is approximately `tokens`. */
function sizedToolResult(id: string, name: string, tokens: number): Message {
	// createToolMessage truncates rendered output above 65,536 chars, so the
	// fixtures stay inside that window (~16k tokens per result).
	const chars = Math.max(1, tokens * 4 - 16);
	return createToolMessage(id, name, {
		ok: true,
		data: { rendered: "x".repeat(chars) },
	});
}

function toolIdsWhere(
	messages: Message[],
	indexes: ReadonlySet<number>,
	want: boolean,
): string[] {
	const ids: string[] = [];
	messages.forEach((message, index) => {
		if (message.role === "tool" && indexes.has(index) === want) {
			ids.push((message as ToolMessage).toolCallId);
		}
	});
	return ids;
}

test("microCompactMessages freezes the running turn and elides older turns first", () => {
	// Two turns, four results, a budget that holds two. The running turn's
	// results are the protected ones, so the *earlier* turn gives way. Before
	// this rule the budget was applied by recency alone, so a long turn evicted
	// its own earlier reads and the model fetched the same files again
	// (transcript.js 4x, manager.ts 5x in the session that motivated this).
	const messages: Message[] = [
		{ role: "user", content: "first question" },
		createAssistantMessage(null, [
			toolCall("old1", "read", { file_path: "old-a.ts" }),
		]),
		sizedToolResult("old1", "read", 400),
		createAssistantMessage(null, [
			toolCall("old2", "grep", { pattern: "old-b" }),
		]),
		sizedToolResult("old2", "grep", 400),
		{ role: "user", content: "second question" },
		createAssistantMessage(null, [
			toolCall("new1", "read", { file_path: "new-a.ts" }),
		]),
		sizedToolResult("new1", "read", 400),
		createAssistantMessage(null, [
			toolCall("new2", "read", { file_path: "new-b.ts" }),
		]),
		sizedToolResult("new2", "read", 400),
	];
	const perResult = estimateMessageTokens(messages[2] as Message);
	const options = {
		keepToolTokens: perResult * 2 + 20,
		floorToolResults: 1,
		protectedToolCallIds: new Set(["new1", "new2"]),
	};

	const plan = planMicroCompaction(messages, options);
	assert.deepEqual(toolIdsWhere(messages, plan.elidedIndexes, true), [
		"old1",
		"old2",
	]);

	// The rendered view keeps the frozen turn verbatim and never blanks a result.
	const tools = microCompactMessages(messages, options).filter(
		(message) => message.role === "tool",
	) as ToolMessage[];
	assert.match(tools[0]?.content ?? "", /^\[context-elided\]/);
	assert.match(tools[1]?.content ?? "", /^\[context-elided\]/);
	assert.match(tools[2]?.content ?? "", /^x+$/);
	assert.match(tools[3]?.content ?? "", /^x+$/);
});

test("microCompactMessages treats a repeated read as ordinary content, not free redundancy", () => {
	// The planner deliberately does NOT model file identity: two reads of the
	// same (path, offset, limit) are two pieces of content under one token
	// budget, and while the budget has room both stay. An earlier revision
	// dropped the older copy as provably redundant ("its newer twin is in this
	// request") and pinned a per-target working set; both were removed because
	// deciding which copy the model still needs is the model's call — the
	// planner only picks what to drop when there is no room.
	const messages: Message[] = [
		{ role: "user", content: "u" },
		createAssistantMessage(null, [
			toolCall("r1", "read", { file_path: "same.ts" }),
		]),
		sizedToolResult("r1", "read", 400),
		createAssistantMessage(null, [
			toolCall("r2", "read", { file_path: "same.ts" }),
		]),
		sizedToolResult("r2", "read", 400),
	];

	const plan = planMicroCompaction(messages, { keepToolTokens: 100_000 });
	assert.deepEqual(toolIdsWhere(messages, plan.elidedIndexes, true), []);

	const tools = microCompactMessages(messages, {
		keepToolTokens: 100_000,
	}).filter((message) => message.role === "tool") as ToolMessage[];
	assert.match(tools[0]?.content ?? "", /^x+$/);
	assert.match(tools[1]?.content ?? "", /^x+$/);
});

test("microCompactMessages prunes a repeated read by recency once the budget binds", () => {
	// The only thing that drops the older copy is the budget itself, applied
	// oldest-first — so the surviving copy is always the newest one, and the
	// elision is monotone.
	const messages: Message[] = [
		{ role: "user", content: "u" },
		createAssistantMessage(null, [
			toolCall("r1", "read", { file_path: "same.ts" }),
		]),
		sizedToolResult("r1", "read", 400),
		createAssistantMessage(null, [
			toolCall("r2", "read", { file_path: "same.ts" }),
		]),
		sizedToolResult("r2", "read", 400),
	];
	const perResult = estimateMessageTokens(sizedToolResult("r0", "read", 400));
	// One token short of holding both copies, so the budget has to choose.
	const budget = perResult * 2 - 1;

	const plan = planMicroCompaction(messages, {
		keepToolTokens: budget,
		floorToolResults: 1,
	});
	assert.deepEqual(toolIdsWhere(messages, plan.elidedIndexes, true), ["r1"]);
	assert.match(
		(
			microCompactMessages(messages, {
				keepToolTokens: budget,
				floorToolResults: 1,
			})[2] as ToolMessage
		).content,
		/^\[context-elided\]/,
	);
});

test("microCompactToolTokenBudget scales with the window and never collapses", () => {
	// The flat 32k was ~16% of a 200k window and could not hold one turn's
	// reads; the budget now follows the active model.
	assert.equal(microCompactToolTokenBudget(200_000), 60_000);
	assert.equal(
		microCompactToolTokenBudget(1_000_000),
		1_000_000 * MICRO_COMPACT_KEEP_TOOL_FRACTION,
	);
	// A small window is budgeted in proportion, but never below the floor.
	assert.equal(microCompactToolTokenBudget(16_384), 8_000);
	// No window to scale against (tests, legacy callers): the historical value.
	assert.equal(
		microCompactToolTokenBudget(undefined),
		MICRO_COMPACT_KEEP_TOOL_TOKENS,
	);
	assert.equal(microCompactToolTokenBudget(0), MICRO_COMPACT_KEEP_TOOL_TOKENS);
	assert.equal(
		microCompactToolTokenBudget(null),
		MICRO_COMPACT_KEEP_TOOL_TOKENS,
	);
});

test("microCompactMessages never restores an elided result as the conversation grows", () => {
	// The cache-relevant invariant. The request prefix is the prompt-cache key,
	// so a decision that flips back would change the prefix twice: once when the
	// result is elided, once when it comes back. Elision is therefore
	// monotone — the boundary may advance as new results arrive, but a result
	// that was elided stays elided.
	//
	// (A low-water "prune in bursts" target was tried here and removed: the
	// trigger is evaluated against the full candidate mass, which includes
	// everything already elided, so it stays true on every later request and the
	// boundary advances by one result per request no matter the target — the
	// mark would only have dropped more context.)
	const perResult = estimateMessageTokens(sizedToolResult("r0", "read", 400));
	const budget = perResult * 10;
	const build = (count: number): Message[] => {
		const messages: Message[] = [{ role: "user", content: "u" }];
		for (let index = 0; index < count; index += 1) {
			messages.push(
				createAssistantMessage(null, [
					toolCall(`r${index}`, "read", { file_path: `file-${index}.ts` }),
				]),
				sizedToolResult(`r${index}`, "read", 400),
			);
		}
		return messages;
	};
	const elidedIds = (count: number) => {
		const messages = build(count);
		const plan = planMicroCompaction(messages, { keepToolTokens: budget });
		return new Set(toolIdsWhere(messages, plan.elidedIndexes, true));
	};

	assert.equal(elidedIds(10).size, 0, "inside the budget nothing is elided");

	const elided: string[] = [];
	for (const count of [11, 12, 13, 14, 15, 20, 30]) {
		const now = elidedIds(count);
		for (const id of elided) {
			assert.ok(now.has(id), `${id} must stay elided at ${count} results`);
		}
		elided.length = 0;
		elided.push(...now);
		assert.ok(elided.length > 0, "the budget must bite once it is exceeded");
	}
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

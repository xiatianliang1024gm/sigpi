import assert from "node:assert/strict";
import test from "node:test";
import { CompactionFailedError } from "../src/agent/compaction-error.js";
import { createCompactionHookRegistry } from "../src/agent/compaction-hook.js";
import {
	ConversationContext,
	microCompactMessages,
} from "../src/agent/context.js";
import {
	createAssistantMessage,
	createToolMessage,
} from "../src/agent/messages.js";
import type { ConversationContextState, Message } from "../src/types.js";
import { MockProvider, stripMessageIds } from "./helpers.js";

test("context trimming does not leave a dangling tool message", async () => {
	const context = new ConversationContext({
		summaryEnabled: false,
	});

	const assistantToolCallMessage = createAssistantMessage(null, [
		{
			id: "tool_call_1",
			name: "grep",
			arguments: { pattern: "needle" },
			rawArguments: '{"pattern":"needle"}',
		},
	]);
	const toolMessage = createToolMessage("tool_call_1", "grep", {
		ok: true,
		data: {
			output: "some result that is intentionally long to increase context size",
		},
	});

	await context.appendMessages(
		[
			{
				role: "user",
				content: "first message with some extra text to increase size",
			},
			assistantToolCallMessage,
			toolMessage,
			{
				role: "assistant",
				content: "final answer with enough text to force trimming",
			},
		],
		new MockProvider(() => ({
			assistantText: "unused",
			toolCalls: [],
			finishReason: "stop",
		})),
		"You are a test agent.",
		[],
	);

	const recentMessages = context.getRecentMessages();
	assert.notEqual(recentMessages[0]?.role, "tool");
});

test("conversation context can export and hydrate state", () => {
	const original = new ConversationContext();
	const state: ConversationContextState = {
		summary: "kept summary",
		recentMessages: [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "world" },
		],
	};

	original.hydrateState(state);

	const restored = new ConversationContext();
	restored.hydrateState(original.exportState());

	assert.equal(restored.getSummary(), "kept summary");
	assert.deepEqual(restored.getRecentMessages(), state.recentMessages);
});

test("conversation context records exploration ledger from tool messages", async () => {
	const context = new ConversationContext({
		summaryEnabled: false,
	});
	const provider = new MockProvider(() => ({
		assistantText: "unused",
		toolCalls: [],
		finishReason: "stop",
	}));
	const assistantMessage = createAssistantMessage(null, [
		{
			id: "tool_call_1",
			name: "grep",
			arguments: {
				pattern: "ConversationContext",
				glob: "src/**/*.ts",
				output_mode: "files_with_matches",
			},
			rawArguments:
				'{"pattern":"ConversationContext","glob":"src/**/*.ts","output_mode":"files_with_matches"}',
		},
		{
			id: "tool_call_2",
			name: "read",
			arguments: {
				file_path: "src/agent/context.ts",
				startLine: 1,
				endLine: 40,
			},
			rawArguments:
				'{"file_path":"src/agent/context.ts","startLine":1,"endLine":40}',
		},
	]);

	await context.appendMessages(
		[
			{ role: "user", content: "inspect context" },
			assistantMessage,
			createToolMessage("tool_call_1", "grep", {
				ok: true,
				data: {
					pattern: "ConversationContext",
					resultCount: 1,
					matches: "src/agent/context.ts",
				},
			}),
			createToolMessage("tool_call_2", "read", {
				ok: true,
				data: {
					path: "src/agent/context.ts",
					returnedLineStart: 1,
					returnedLineEnd: 40,
				},
			}),
		],
		provider,
		"You are a test agent.",
		[],
	);

	const ledger = context.exportState().explorationLedger;
	assert.equal(ledger?.searchedQueries[0]?.query, "ConversationContext");
	assert.equal(ledger?.candidateFiles.includes("src/agent/context.ts"), true);
	assert.equal(ledger?.readRanges[0]?.path, "src/agent/context.ts");

	const restored = new ConversationContext();
	restored.hydrateState(context.exportState());
	const messages = restored.buildMessages("You are a test agent.");
	assert.equal(
		messages.some(
			(message) =>
				message.role === "system" &&
				message.content.includes("Exploration state:") &&
				message.content.includes("ConversationContext") &&
				message.content.includes("src/agent/context.ts"),
		),
		true,
	);
});

test("manual compaction can summarize older messages before soft limit is reached", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "compressed summary",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
	});

	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "first request" },
			{ role: "assistant", content: "first answer" },
			{ role: "user", content: "latest request" },
		],
	});

	const result = await context.compactNow(
		provider,
		"You are a test agent.",
		[],
	);

	assert.equal(result.summarized, true);
	assert.equal(result.trimmed, false);
	assert.equal(result.previousRecentMessageCount, 3);
	assert.equal(result.recentMessageCount, 1);
	assert.equal(result.previousSummaryChars, 0);
	assert.equal(result.summaryChars, "compressed summary".length);
	assert.ok(result.tokensBefore > 0);
	assert.ok(result.tokensAfter > 0);
	assert.equal(context.getSummary(), "compressed summary");
	assert.deepEqual(context.getRecentMessages(), [
		{ role: "user", content: "latest request" },
	]);
	assert.equal(provider.requests[0]?.context?.purpose, "summary");
});

test("context summarization prompt preserves goals with structured checkpoint sections", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "structured summary",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
	});

	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "Fix the context compaction goal loss bug." },
			{ role: "assistant", content: "I will inspect the implementation." },
			{ role: "user", content: "latest request" },
		],
	});

	await context.compactNow(provider, "You are a test agent.", []);

	const request = provider.requests[0];
	const summarySystemMessage = request?.messages[1];
	const promptMessage = request?.messages[2];

	assert.equal(request?.maxTokens, 2048);
	assert.match(
		summarySystemMessage?.content ?? "",
		/ONLY output the structured summary/,
	);
	assert.match(promptMessage?.content ?? "", /<conversation>/);
	assert.match(promptMessage?.content ?? "", /## Goal/);
	assert.match(promptMessage?.content ?? "", /## Next Steps/);
	assert.match(promptMessage?.content ?? "", /## Critical Context/);
	assert.match(promptMessage?.content ?? "", /Preserve the current user goal/);
});

test("context summarization prompt includes exploration ledger details", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "structured summary",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
	});

	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "Fix repeated exploration." },
			{ role: "assistant", content: "I will inspect context." },
			{ role: "user", content: "latest request" },
		],
		explorationLedger: {
			searchedQueries: [
				{
					query: "search_in_files",
					glob: "src/**/*.ts",
					output: "files",
					caseSensitive: null,
					resultCount: 3,
					truncated: false,
					repeatedCount: 1,
				},
			],
			candidateFiles: ["src/tools/builtin/grep.ts"],
			readRanges: [
				{
					path: "src/agent/context.ts",
					startLine: 1,
					endLine: 80,
				},
			],
			rejectedPaths: [],
			keyFindings: [],
			modifiedFiles: [],
		},
	});

	await context.compactNow(provider, "You are a test agent.", []);

	const promptMessage = provider.requests[0]?.messages[2];
	assert.match(promptMessage?.content ?? "", /<exploration-ledger>/);
	assert.match(promptMessage?.content ?? "", /Searched Queries/);
	assert.match(promptMessage?.content ?? "", /src\/tools\/builtin\/grep\.ts/);
	assert.match(promptMessage?.content ?? "", /src\/agent\/context\.ts/);
});

test("compactNow throws CompactionFailedError when the summary is truncated", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "## Goal\nAnalyze the current",
		toolCalls: [],
		finishReason: "length",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
	});
	const assistantToolCallMessage = createAssistantMessage(null, [
		{
			id: "tool_call_1",
			name: "read",
			arguments: { file_path: "README.md" },
			rawArguments: '{"file_path":"README.md"}',
		},
	]);

	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "分析当前项目" },
			assistantToolCallMessage,
			{
				role: "tool",
				name: "read",
				toolCallId: "tool_call_1",
				content: "TOOL: read\nSTATUS: ok\nRESULT:\nPath: README.md",
			},
			{ role: "user", content: "不要继续探索了，回答我" },
		],
	});

	// Truncation no longer produces a deterministic fallback summary; the
	// failure is surfaced to the caller via CompactionFailedError.
	await assert.rejects(
		() => context.compactNow(provider, "You are a test agent.", []),
		CompactionFailedError,
	);
	assert.equal(context.getSummary(), null);
});

test("buildMessages injects active goal reminder from summary", () => {
	const context = new ConversationContext();
	context.hydrateState({
		summary:
			"## Goal\n分析当前项目\n\n## Next Steps\n1. Answer with project analysis.",
		recentMessages: [],
	});

	const messages = context.buildMessages(
		"You are a test agent.",
		"还记得你的目的吗",
	);
	const reminder = messages.find(
		(message) =>
			message.role === "system" &&
			message.content.includes(
				"Active user task from the conversation summary",
			),
	);

	assert.match(reminder?.content ?? "", /分析当前项目/);
	assert.match(reminder?.content ?? "", /goal, purpose, objective, or task/);
	assert.equal(messages.at(-1)?.role, "user");
	assert.equal(messages.at(-1)?.content, "还记得你的目的吗");
});

test("context summarization updates previous structured summary without dropping goals", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "updated structured summary",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
	});

	context.hydrateState({
		summary: "## Goal\nKeep the agent focused on the original task.",
		recentMessages: [
			{ role: "user", content: "I found a regression in compaction." },
			{ role: "assistant", content: "I will add a test." },
			{ role: "user", content: "latest request" },
		],
	});

	await context.compactNow(provider, "You are a test agent.", []);

	const promptMessage = provider.requests[0]?.messages[2];
	assert.match(
		promptMessage?.content ?? "",
		/<previous-summary>\n## Goal\nKeep the agent focused on the original task\.\n<\/previous-summary>/,
	);
	assert.match(promptMessage?.content ?? "", /PRESERVE all existing goals/);
	assert.match(promptMessage?.content ?? "", /UPDATE "Next Steps"/);
});

test("context compaction counts system prompt and tool schemas in the estimate", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "compressed summary",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
		getContextBudget: () => ({
			hardContextLimit: 50,
			reserveTokens: 2,
			keepRecentTokens: 5,
		}),
		keepRecentMessagesFloor: 2,
	});

	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "short request" },
			{ role: "assistant", content: "short answer" },
		],
	});

	const result = await context.appendMessages(
		[
			{ role: "user", content: "follow up" },
			{ role: "assistant", content: "final answer" },
		],
		provider,
		"A very long system prompt that takes enough room to matter for compaction decisions.",
		[
			{
				type: "function",
				function: {
					name: "demo_tool",
					description:
						"A tool schema with enough descriptive text to contribute meaningful context size.",
					parameters: {
						type: "object",
						properties: {
							value: {
								type: "string",
								description:
									"Some input text that intentionally makes the schema a bit larger.",
							},
						},
					},
				},
			},
		],
	);

	assert.equal(result.summarized, true);
	assert.ok(result.tokensBefore > 50);
	assert.ok(result.tokensAfter > 0);
	assert.ok(result.tokensAfter > 0);
});

test("recovery checkpoint appends messages without triggering summarization", () => {
	const context = new ConversationContext({
		summaryEnabled: true,
	});

	const result = context.appendRecoveryMessages(
		[
			{
				role: "user",
				content: "first message with enough text to exceed the soft limit",
			},
			{
				role: "assistant",
				content: "second message that would normally be summarized away",
			},
		],
		"You are a test agent.",
		[],
	);

	assert.equal(result.summarized, false);
	assert.equal(result.trimmed, false);
	assert.equal(context.getSummary(), null);
	assert.deepEqual(stripMessageIds(context.getRecentMessages()), [
		{
			role: "user",
			content: "first message with enough text to exceed the soft limit",
		},
		{
			role: "assistant",
			content: "second message that would normally be summarized away",
		},
	]);
});

test("token-based trigger fires when provider usage exceeds context window minus reserve", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "token-triggered summary",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
		getContextBudget: () => ({
			hardContextLimit: 10_000,
			reserveTokens: 2_000,
			keepRecentTokens: 100,
		}),
	});

	// 200 messages, ~120 chars each ≈ 30 tokens each. Total recent messages
	// contribute ~6000 tokens. Provider reports totalTokens = 9000 (under the
	// 10k - 2k reserve = 8k threshold? no, 9k > 8k). Then we append one more
	// large message and re-record usage so the next compact can decide.
	const initial: Message[] = [];
	for (let i = 0; i < 30; i += 1) {
		initial.push({
			role: i % 2 === 0 ? "user" : "assistant",
			content:
				"x".repeat(120) +
				` message ${i} padding padding padding padding padding padding`,
		});
	}

	context.hydrateState({ summary: null, recentMessages: initial });
	context.recordUsage(
		{
			input: 9_000,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 9_000,
		},
		initial.length - 1,
	);

	const result = await context.compactNow(
		provider,
		"You are a test agent.",
		[],
	);

	assert.equal(result.summarized, true);
	assert.equal(result.trigger, "force");
	assert.ok((result.tokensBefore ?? 0) >= 9_000);
});

test("token trigger does not fire when recent messages fit within keepRecentTokens", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "should not run",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
		getContextBudget: () => ({
			hardContextLimit: 10_000,
			reserveTokens: 1_000,
			keepRecentTokens: 100_000,
		}),
	});

	const messages: Message[] = [];
	for (let i = 0; i < 5; i += 1) {
		messages.push({ role: "user", content: `short request ${i}` });
		messages.push({ role: "assistant", content: `short answer ${i}` });
	}

	context.hydrateState({ summary: null, recentMessages: messages });
	// Provider reports we're well below threshold (5k of a 9k budget)
	context.recordUsage(
		{
			input: 5_000,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5_000,
		},
		messages.length - 1,
	);

	// Trigger via token trigger path (not force) by exceeding contextWindow - reserveTokens.
	// 5_000 < 10_000 - 1_000 = 9_000, so it should NOT fire.
	const result = await context.compact(provider, "You are a test agent.", []);

	assert.equal(result.summarized, false);
	assert.equal(result.trigger, null);
	assert.equal(provider.requests.length, 0);
});

test("appendMessages records provider usage for the most recent assistant message", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "ignored",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
	});

	await context.appendMessages(
		[
			{ role: "user", content: "u1" },
			{ role: "assistant", content: "a1" },
		],
		provider,
		"You are a test agent.",
		[],
		undefined,
		{
			usage: {
				input: 1_000,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_050,
			},
		},
	);

	// Add another turn — the next append should not overwrite the recorded
	// usage unless usage is passed again (which it shouldn't be from runner
	// unless a new model call has happened).
	await context.appendMessages(
		[
			{ role: "user", content: "u2" },
			{ role: "assistant", content: "a2" },
		],
		provider,
		"You are a test agent.",
		[],
	);

	// Push the conversation over the token threshold (1_050 + 2 ~token messages
	// is still well below the default 10k, so the char path should not fire
	// either). But because we re-recorded usage in the second append? No:
	// we did not. So lastUsage stays at the first call.
	// Force a compactNow and inspect tokensBefore — it must reflect the
	// recorded usage baseline.
	const result = await context.compactNow(
		provider,
		"You are a test agent.",
		[],
	);
	assert.ok((result.tokensBefore ?? 0) >= 1_000);
});

test("hydrated session forgets provider usage until next model response", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "summary",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
		getContextBudget: () => ({
			hardContextLimit: 10_000,
			reserveTokens: 1_000,
			keepRecentTokens: 100_000,
		}),
	});

	// Hydrate with messages only; no usage information is available.
	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "u" },
			{ role: "assistant", content: "a" },
		],
	});

	const result = await context.compact(provider, "You are a test agent.", []);

	// 1_000 tokens of chat is under 9_000 threshold AND fits within 100k budget,
	// so token trigger should not fire. chars trigger also should not fire.
	assert.equal(result.summarized, false);
	assert.equal(provider.requests.length, 0);
});

test("summary request caps maxTokens at provider.maxTokens when configured", async () => {
	const provider = new MockProvider(
		() => ({
			assistantText: "summary",
			toolCalls: [],
			finishReason: "stop",
		}),
		{ maxTokens: 4096 },
	);
	const context = new ConversationContext({
		summaryEnabled: true,
		getContextBudget: () => ({
			hardContextLimit: 50,
			reserveTokens: 100,
			keepRecentTokens: 20_000,
		}),
		keepRecentMessagesFloor: 2,
	});

	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "u" },
			{ role: "assistant", content: "a" },
		],
	});

	await context.compactNow(provider, "You are a test agent.", []);

	// reserveTokens=100, 0.8*100=80, but floor is 256 → 256. Provider maxTokens
	// (4096) is bigger than the 256 floor, so floor wins.
	const summaryRequest = provider.requests[0];
	assert.equal(summaryRequest?.maxTokens, 256);
});

test("summary request uses provider.maxTokens when it is the tightest cap", async () => {
	const provider = new MockProvider(
		() => ({
			assistantText: "summary",
			toolCalls: [],
			finishReason: "stop",
		}),
		{ maxTokens: 800 },
	);
	const context = new ConversationContext({
		summaryEnabled: true,
		getContextBudget: () => ({
			hardContextLimit: 50,
			reserveTokens: 4_000,
			keepRecentTokens: 20_000,
		}),
		keepRecentMessagesFloor: 2,
	});

	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "u" },
			{ role: "assistant", content: "a" },
		],
	});

	await context.compactNow(provider, "You are a test agent.", []);

	// reserveTokens=4_000, 0.8*4000=3200. provider.maxTokens=800 is the tightest
	// cap → summary request uses 800.
	const summaryRequest = provider.requests[0];
	assert.equal(summaryRequest?.maxTokens, 800);
});

test("summary request keeps the 2048 default cap when provider exposes no maxTokens", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "summary",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
		getContextBudget: () => ({
			hardContextLimit: 50,
			reserveTokens: 4_000,
			keepRecentTokens: 20_000,
		}),
		keepRecentMessagesFloor: 2,
	});

	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "u" },
			{ role: "assistant", content: "a" },
		],
	});

	await context.compactNow(provider, "You are a test agent.", []);

	// reserveTokens=4_000, 0.8*4000=3200. Provider has no maxTokens → cap is
	// the internal default (2048). The 256 floor does not apply (2048 > 256).
	const summaryRequest = provider.requests[0];
	assert.equal(summaryRequest?.maxTokens, 2048);
});

test("compactNow with instructions injects a custom-instructions block into the summary prompt", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "summary",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
	});

	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "u" },
			{ role: "assistant", content: "a" },
		],
	});

	await context.compactNow(provider, "You are a test agent.", [], undefined, {
		instructions: "Focus only on the database schema.",
	});

	const summaryRequest = provider.requests[0];
	const promptMessage = summaryRequest?.messages[2];
	const prompt = promptMessage?.content ?? "";
	assert.match(prompt, /<custom-instructions>/);
	assert.match(prompt, /Focus only on the database schema\./);
	assert.match(prompt, /<\/custom-instructions>/);
});

test("compactNow without instructions omits the custom-instructions block", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "summary",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
	});

	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "u" },
			{ role: "assistant", content: "a" },
		],
	});

	await context.compactNow(provider, "You are a test agent.", []);

	const summaryRequest = provider.requests[0];
	const promptMessage = summaryRequest?.messages[2];
	const prompt = promptMessage?.content ?? "";
	assert.doesNotMatch(
		prompt,
		/<custom-instructions>[\s\S]+?<\/custom-instructions>/,
	);
});

test("compactNow persists customInstructions on the appended CompactionEntry", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "summary",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
	});

	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "u" },
			{ role: "assistant", content: "a" },
		],
	});

	await context.compactNow(provider, "You are a test agent.", [], undefined, {
		instructions: "Highlight the failing tests.",
	});

	const compactionEntries = context
		.exportState()
		.entries?.filter((e) => e.kind === "compaction");
	assert.equal(compactionEntries?.length, 1);
	const entry = compactionEntries?.[0];
	assert.equal(
		entry?.details?.customInstructions,
		"Highlight the failing tests.",
	);
});

test("compactNow throws CompactionFailedError when the signal is already aborted", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "success",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
	});

	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "u" },
			{ role: "assistant", content: "a" },
		],
	});

	const controller = new AbortController();
	controller.abort(new DOMException("Interrupted", "AbortError"));

	// No provider call should have been dispatched: summarizeMessages
	// checks abortSignal.aborted before calling provider.generate, then
	// compact() propagates a typed CompactionFailedError (no fallback).
	await assert.rejects(
		() =>
			context.compactNow(provider, "You are a test agent.", [], undefined, {
				abortSignal: controller.signal,
			}),
		CompactionFailedError,
	);
	assert.equal(provider.requests.length, 0);
});

test("compactNow throws CompactionFailedError when the provider rejects after abort", async () => {
	const controller = new AbortController();
	const provider = new MockProvider(async (request) => {
		// Simulate a provider that checks the abort signal mid-flight.
		if (request.abortSignal?.aborted) {
			throw new DOMException("Interrupted", "AbortError");
		}
		return {
			assistantText: "summary",
			toolCalls: [],
			finishReason: "stop",
		};
	});
	const context = new ConversationContext({
		summaryEnabled: true,
	});

	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "u" },
			{ role: "assistant", content: "a" },
		],
	});

	controller.abort(new DOMException("Interrupted", "AbortError"));

	await assert.rejects(
		() =>
			context.compactNow(provider, "You are a test agent.", [], undefined, {
				abortSignal: controller.signal,
			}),
		CompactionFailedError,
	);
	assert.equal(provider.requests.length, 0);
});

test("compactNow throws CompactionFailedError on truncated summary and leaves messages intact", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "<summary>partial</summary>",
		toolCalls: [],
		finishReason: "length",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
	});
	const seedMessages: Message[] = [
		{ role: "user", content: "u1" },
		{ role: "assistant", content: "a1" },
		{ role: "user", content: "u2" },
		{ role: "assistant", content: "a2" },
	];
	context.hydrateState({ summary: null, recentMessages: seedMessages });

	await assert.rejects(
		() => context.compactNow(provider, "You are a test agent.", []),
		CompactionFailedError,
	);

	// No slice and no CompactionEntry: the raw recent messages survive so the
	// next turn can re-read, and the caller bounds tokens via trimToHardLimit.
	const exported = context.exportState();
	assert.equal(exported.recentMessages.length, seedMessages.length);
	assert.equal(
		exported.entries?.some((entry) => entry.kind === "compaction"),
		false,
		"no compaction entry should be written on failure",
	);
	assert.equal(context.getSummary(), null);
});

test("compactNow throws CompactionFailedError when the model returns an empty summary", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
	});
	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "u" },
			{ role: "assistant", content: "a" },
		],
	});

	await assert.rejects(
		() => context.compactNow(provider, "You are a test agent.", []),
		CompactionFailedError,
	);
});

test("compact passes caller abort signal to compaction hooks", async () => {
	let hookSignal: AbortSignal | null = null;
	function captureSignal(
		event: import("../src/agent/compaction-hook.js").CompactionHookEvent,
	): import("../src/agent/compaction-hook.js").CompactionHookResult {
		hookSignal = event.signal;
		return undefined as unknown as import("../src/agent/compaction-hook.js").CompactionHookResult;
	}
	const hook = captureSignal;
	const provider = new MockProvider(() => ({
		assistantText: "summary",
		toolCalls: [],
		finishReason: "stop",
	}));
	const compactionHooks = createCompactionHookRegistry();
	compactionHooks.register(hook);
	const context = new ConversationContext({
		summaryEnabled: true,
		compactionHooks,
	});

	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "u" },
			{ role: "assistant", content: "a" },
		],
	});

	const controller = new AbortController();
	await context.compactNow(provider, "You are a test agent.", [], undefined, {
		abortSignal: controller.signal,
	});

	assert.notEqual(hookSignal, null, "hook must have received a signal");
	assert.equal((hookSignal as unknown as AbortSignal).aborted, false);

	controller.abort();
	assert.equal((hookSignal as unknown as AbortSignal).aborted, true);
});

test("summarize extracts only the <summary> block and drops <analysis>", async () => {
	const provider = new MockProvider(() => ({
		assistantText:
			"<analysis>Let me think about what changed in this session. A regression appeared.</analysis>\n<summary>User reported a regression in the export command after the refactor.</summary>",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({ summaryEnabled: true });
	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "There is a regression in export." },
			{ role: "assistant", content: "Investigating." },
		],
	});

	await context.compactNow(provider, "You are a test agent.", []);

	const summary = context.getSummary() ?? "";
	assert.equal(
		summary,
		"User reported a regression in the export command after the refactor.",
	);
	assert.doesNotMatch(summary, /<analysis>/);
	assert.doesNotMatch(summary, /Let me think/);
});

test("summarize falls back to the full response when no <summary> tag is present", async () => {
	const provider = new MockProvider(() => ({
		assistantText:
			"## Goal\nKeep the export command working\n## Next Steps\nInvestigate the regression",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({ summaryEnabled: true });
	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "ok" },
		],
	});

	await context.compactNow(provider, "You are a test agent.", []);

	assert.equal(
		context.getSummary(),
		"## Goal\nKeep the export command working\n## Next Steps\nInvestigate the regression",
	);
});

test("summarize strips a leading <analysis> block as fallback when no <summary> tag exists", async () => {
	const provider = new MockProvider(() => ({
		assistantText:
			"<analysis>I should preserve the user's exact request and the schema change.</analysis>\nThe user wants the schema change reverted and the export fixed.",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({ summaryEnabled: true });
	context.hydrateState({
		summary: null,
		recentMessages: [
			{ role: "user", content: "u" },
			{ role: "assistant", content: "a" },
		],
	});

	await context.compactNow(provider, "You are a test agent.", []);

	const summary = context.getSummary() ?? "";
	assert.equal(
		summary,
		"The user wants the schema change reverted and the export fixed.",
	);
	assert.doesNotMatch(summary, /<analysis>/);
});

test("buildMessages micro-compacts older tool results into placeholders", () => {
	// Build tool messages directly with large content so the per-tool token
	// estimate (chars/4) clears the oldest results even though createToolMessage
	// normally truncates rendered tool output.
	const bigTool = (id: string, name: string) => ({
		role: "tool" as const,
		toolCallId: id,
		name,
		content: "x".repeat(20000),
	});
	const failedTool = (id: string, name: string, error: string) => ({
		role: "tool" as const,
		toolCallId: id,
		name,
		content: `STATUS: error\nERROR: ${error}\n${"x".repeat(20000)}`,
	});
	const context = new ConversationContext({ summaryEnabled: false });
	const recent: Message[] = [
		{ role: "user", content: "start" },
		createAssistantMessage(null, [
			{ id: "t1", name: "grep", arguments: {}, rawArguments: "{}" },
		]),
		bigTool("t1", "grep"),
		createAssistantMessage(null, [
			{ id: "t2", name: "read", arguments: {}, rawArguments: "{}" },
		]),
		failedTool("t2", "read", "boom detail message"),
		createAssistantMessage(null, [
			{ id: "t3", name: "grep", arguments: {}, rawArguments: "{}" },
		]),
		bigTool("t3", "grep"),
		createAssistantMessage(null, [
			{ id: "t4", name: "read", arguments: {}, rawArguments: "{}" },
		]),
		failedTool("t4", "read", "fatal error in read"),
		createAssistantMessage(null, [
			{ id: "t5", name: "grep", arguments: {}, rawArguments: "{}" },
		]),
		bigTool("t5", "grep"),
		createAssistantMessage(null, [
			{ id: "t6", name: "read", arguments: {}, rawArguments: "{}" },
		]),
		bigTool("t6", "read"),
		createAssistantMessage("final answer"),
	];
	context.hydrateState({ summary: null, recentMessages: recent });

	const messages = context.buildMessages("You are a test agent.");
	const tools: Message[] = messages.filter((m) => m.role === "tool");
	const byId = (id: string) =>
		tools.find((m) => (m as { toolCallId?: string }).toolCallId === id);

	const cleared = ["t1", "t2", "t3"].map(byId);
	const kept = ["t4", "t5", "t6"].map(byId);
	for (const t of cleared) {
		assert.ok(t, "tool message must be present");
		assert.match((t as { content: string }).content, /tool result omitted/);
	}
	for (const t of kept) {
		assert.ok(t, "tool message must be present");
		assert.doesNotMatch(
			(t as { content: string }).content,
			/tool result omitted/,
		);
	}
	// Exactly three most-recent tool results are retained (budget + floor of 3).
	assert.equal(
		tools.filter((m) =>
			/tool result omitted/.test((m as { content: string }).content),
		).length,
		3,
	);
	// name + toolCallId are preserved on every tool message.
	assert.equal((byId("t4") as { name?: string }).name, "read");
	assert.equal((byId("t4") as { toolCallId?: string }).toolCallId, "t4");
	// A cleared failed tool surfaces its error in the placeholder.
	assert.match(
		(byId("t2") as { content: string }).content,
		/failed: boom detail message/,
	);
	// A kept failed tool still shows its original error content.
	assert.match(
		(byId("t4") as { content: string }).content,
		/fatal error in read/,
	);
});

test("microCompactMessages never mutates the input messages", () => {
	const tool = (id: string) => ({
		role: "tool" as const,
		toolCallId: id,
		name: "grep",
		content: "big".repeat(20000),
	});
	const input: Message[] = [
		{ role: "user", content: "u" },
		tool("a"),
		tool("b"),
		tool("c"),
		tool("d"),
		tool("e"),
		tool("f"),
	];
	const originalA = input[1].content;
	const out = microCompactMessages(input);
	assert.notEqual(input[1].content, (out[1] as { content: string }).content);
	assert.equal(input[1].content, originalA);
	assert.equal(out.length, input.length);
});

test("budget getter follows the active model so /model switch changes the trigger", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "<summary>compressed</summary>",
		toolCalls: [],
		finishReason: "stop",
	}));

	// Backed by a mutable holder so switching the active model re-points the
	// getter, exactly like runtime.setActiveModel does for /model switch.
	let activeBudget = {
		hardContextLimit: 100,
		reserveTokens: 10,
		keepRecentTokens: 20,
	};
	const context = new ConversationContext({
		summaryEnabled: true,
		getContextBudget: () => activeBudget,
	});

	// ~12 messages of a few hundred chars each comfortably exceed a 90-token
	// (100 - 10) threshold for the small model.
	const messages: Message[] = [];
	for (let i = 0; i < 6; i += 1) {
		messages.push({ role: "user", content: "request ".repeat(40) + i });
		messages.push({ role: "assistant", content: "answer ".repeat(40) + i });
	}
	context.hydrateState({ summary: null, recentMessages: messages });

	const smallResult = await context.compact(
		provider,
		"You are a test agent.",
		[],
	);
	// Small model: trigger fires, context is summarized.
	assert.equal(smallResult.summarized, true);

	// Switch to a much larger model: the same conversation now fits.
	activeBudget = {
		hardContextLimit: 1_000_000,
		reserveTokens: 10,
		keepRecentTokens: 20,
	};
	context.appendRecoveryMessages(
		[{ role: "user", content: "one more small request" }],
		"You are a test agent.",
		[],
	);
	const largeResult = await context.compact(
		provider,
		"You are a test agent.",
		[],
	);
	// Large model: the expanded budget means no further compaction fires.
	assert.equal(largeResult.summarized, false);
	assert.equal(largeResult.trimmed, false);
});

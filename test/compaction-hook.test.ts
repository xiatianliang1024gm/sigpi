import assert from "node:assert/strict";
import test from "node:test";
import {
	type CompactionHookFn,
	type CompactionHookRegistry,
	type CompactionPreparation,
	createCompactionHookRegistry,
} from "../src/agent/compaction-hook.js";
import { ConversationContext } from "../src/agent/context.js";
import {
	createAssistantMessage,
	createUserMessage,
} from "../src/agent/messages.js";
import type { CompactionEntry, Message } from "../src/types.js";
import { MockProvider } from "./helpers.js";

function buildContext(hooks?: CompactionHookRegistry): ConversationContext {
	return new ConversationContext({
		contextWindow: 60,
		reserveTokens: 2,
		keepRecentTokens: 10,
		keepRecentMessagesFloor: 2,
		summaryEnabled: true,
		compactionHooks: hooks,
	});
}

function attachLongHistory(_context: ConversationContext): Message[] {
	const messages = [
		createUserMessage(
			"first long enough user message to push past the soft limit",
		),
		createAssistantMessage("first assistant reply that takes some space too"),
		createUserMessage(
			"second long enough user message to push past the soft limit",
		),
		createAssistantMessage("second assistant reply that takes some space too"),
		createUserMessage("latest short request"),
	];
	return messages;
}

test("compaction hook registry merges field-by-field overrides and reports count", async () => {
	const registry = createCompactionHookRegistry();
	const calls: string[] = [];

	registry.register((_event) => {
		calls.push("first");
		return { compaction: { summary: "summary from first hook" } };
	});
	registry.register((_event) => {
		calls.push("second");
		// second hook overrides tokensBefore and details; leaves summary alone
		return {
			compaction: {
				tokensBefore: 9999,
				details: { triggeredBy: "manual" },
			},
		};
	});

	const result = await registry.runHooks(
		{
			trigger: "token",
			tokensBefore: 100,
			totalChars: 0,
			summarizedMessages: [],
			keptMessages: [],
			recentMessages: [],
			previousSummary: null,
		},
		new AbortController().signal,
	);

	assert.ok(result, "no hook asked to cancel");
	assert.equal(calls.join(","), "first,second");
	assert.equal(result.summary, "summary from first hook");
	assert.equal(result.tokensBefore, 9999);
	assert.equal(result.details?.triggeredBy, "manual");
});

test("cancel result from any hook returns null and short-circuits later hooks", async () => {
	const registry = createCompactionHookRegistry();
	let laterHookInvoked = false;
	registry.register(() => ({ cancel: true }));
	registry.register(() => {
		laterHookInvoked = true;
		return undefined;
	});

	const result = await registry.runHooks(
		{
			trigger: "force",
			tokensBefore: 0,
			totalChars: 0,
			summarizedMessages: [],
			keptMessages: [],
			recentMessages: [],
			previousSummary: null,
		},
		new AbortController().signal,
	);

	assert.equal(result, null);
	assert.equal(laterHookInvoked, false);
});

test("a throwing hook is swallowed but later hooks still run", async () => {
	const registry = createCompactionHookRegistry();
	const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
	registry.register(() => {
		throw new Error("boom");
	});
	registry.register(() => ({ compaction: { summary: "from second" } }));

	const result = await registry.runHooks(
		{
			trigger: "token",
			tokensBefore: 0,
			totalChars: 0,
			summarizedMessages: [],
			keptMessages: [],
			recentMessages: [],
			previousSummary: null,
		},
		new AbortController().signal,
		(message, meta) => logs.push({ message, ...(meta ? { meta } : {}) }),
	);

	assert.ok(result);
	assert.equal(result.summary, "from second");
	const failureLog = logs.find(
		(entry) => entry.message === "compaction_hook_failed",
	);
	assert.ok(failureLog, "thrown hook should be logged as failure");
});

test("register returns an unsubscribe that removes the hook", async () => {
	const registry = createCompactionHookRegistry();
	const fn: CompactionHookFn = () => ({
		compaction: { summary: "should not run" },
	});
	const unsubscribe = registry.register(fn);
	unsubscribe();
	assert.equal(registry.size, 0);
	const result = await registry.runHooks(
		{
			trigger: "token",
			tokensBefore: 0,
			totalChars: 0,
			summarizedMessages: [],
			keptMessages: [],
			recentMessages: [],
			previousSummary: null,
		},
		new AbortController().signal,
	);
	assert.deepEqual(result, {});
});

test("hook that cancels prevents summarization and recentMessages is left untouched", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "should not be used",
		toolCalls: [],
		finishReason: "stop",
	}));
	const registry = createCompactionHookRegistry();
	let cancelCalled = false;
	registry.register(() => {
		cancelCalled = true;
		return { cancel: true };
	});
	const context = buildContext(registry);

	const messages = attachLongHistory(context);
	const result = await context.appendMessages(
		messages,
		provider,
		"You are a test agent.",
		[],
	);

	assert.equal(cancelCalled, true);
	assert.equal(result.summarized, false);
	assert.equal(context.getSummary(), null);
	assert.equal(context.getRecentMessages().length, messages.length);
	assert.equal(
		context.exportState().entries?.filter((e) => e.kind === "compaction")
			.length ?? 0,
		0,
		"no compaction entry should be appended when hook cancels",
	);
});

test("hook can override the summary without calling summarizeMessages", async () => {
	const provider = new MockProvider(() => {
		throw new Error(
			"summarizeMessages should not be called when hook overrides summary",
		);
	});
	const registry = createCompactionHookRegistry();
	registry.register(() => ({
		compaction: { summary: "hand-crafted summary" },
	}));
	const context = buildContext(registry);

	await context.appendMessages(
		attachLongHistory(context),
		provider,
		"You are a test agent.",
		[],
	);

	assert.equal(context.getSummary(), "hand-crafted summary");
	const compactionEntries = context
		.exportState()
		.entries?.filter((e): e is CompactionEntry => e.kind === "compaction");
	assert.equal(compactionEntries?.length, 1);
	assert.equal(compactionEntries?.[0]?.summary, "hand-crafted summary");
	// firstKeptEntryId should still point at recentMessages[0]
	const firstKeptId = compactionEntries?.[0]?.firstKeptEntryId;
	assert.ok(firstKeptId);
	assert.equal(firstKeptId, context.getRecentMessages()[0]?.id);
});

test("hook receives preparation snapshot including summarized/kept/recentMessages", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "default summary",
		toolCalls: [],
		finishReason: "stop",
	}));
	const registry = createCompactionHookRegistry();
	const captured: { value: CompactionPreparation | null } = { value: null };
	registry.register((event) => {
		captured.value = event.preparation;
		return undefined;
	});
	const context = buildContext(registry);

	await context.appendMessages(
		attachLongHistory(context),
		provider,
		"You are a test agent.",
		[],
	);

	assert.ok(captured.value);
	assert.equal(captured.value?.trigger, "token");
	assert.ok((captured.value?.summarizedMessages.length ?? 0) > 0);
	assert.ok((captured.value?.keptMessages.length ?? 0) > 0);
	assert.equal(
		captured.value?.recentMessages.length,
		5,
		"recentMessages snapshot should include all 5 messages",
	);
	assert.equal(captured.value?.previousSummary, null);
});

import assert from "node:assert/strict";
import test from "node:test";
import { ConversationContext } from "../src/agent/context.js";
import {
	createAssistantMessage,
	createUserMessage,
} from "../src/agent/messages.js";
import type { ConversationContextState } from "../src/types.js";
import { MockProvider } from "./helpers.js";

const STATIC_PROVIDER = new MockProvider(() => ({
	assistantText: "noop",
	toolCalls: [],
	finishReason: "stop",
}));

function buildContext(): ConversationContext {
	return new ConversationContext({
		summaryEnabled: true,
	});
}

test("appendMessages records a MessageEntry per message and mints ids for legacy callers", async () => {
	const context = buildContext();
	const userMessage = { role: "user" as const, content: "hello" };
	const assistantMessage = createAssistantMessage("hi");

	const result = await context.appendMessages(
		[userMessage, assistantMessage],
		STATIC_PROVIDER,
		"You are a test agent.",
		[],
	);

	assert.equal(result.summarized, false);
	const state = context.exportState();
	assert.ok(state.entries, "entries should be populated");
	assert.equal(state.entries?.length, 2);

	const messageEntries = state.entries?.filter(
		(entry) => entry.kind === "message",
	);
	assert.equal(messageEntries?.length, 2);
	assert.ok(messageEntries?.[0]?.id, "first entry must carry an id");
	assert.ok(messageEntries?.[1]?.id);
	assert.notEqual(messageEntries?.[0]?.id, messageEntries?.[1]?.id);

	const derivedIds = state.entries
		?.filter((entry) => entry.kind === "message")
		.map((entry) => entry.id);
	assert.deepEqual(
		state.recentMessages.map((m) => m.id),
		derivedIds,
	);
});

test("compact appends a CompactionEntry whose firstKeptEntryId matches the new recentMessages[0]", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "compacted snapshot",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		getContextBudget: () => ({
			hardContextLimit: 1_000_000,
			reserveTokens: 16_384,
			keepRecentTokens: 20_000,
		}), // appendMessages must not auto-summarize
		summaryEnabled: true,
	});

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
	await context.appendMessages(messages, provider, "You are a test agent.", []);

	const result = await context.compactNow(
		provider,
		"You are a test agent.",
		[],
	);
	assert.equal(result.summarized, true);

	const state = context.exportState();
	const compactionEntries = (state.entries ?? []).filter(
		(entry) => entry.kind === "compaction",
	);
	assert.equal(compactionEntries.length, 1);

	const compaction = compactionEntries[0];
	assert.ok(compaction);
	assert.equal(compaction.summary, "compacted snapshot");
	const firstKeptId = compaction.firstKeptEntryId;
	assert.ok(
		firstKeptId,
		"firstKeptEntryId must reference a real message entry",
	);

	const firstKeptMessage = state.entries?.find(
		(entry) => entry.kind === "message" && entry.id === firstKeptId,
	);
	assert.ok(
		firstKeptMessage,
		"firstKeptEntryId must resolve to a message entry",
	);
	assert.equal(
		firstKeptMessage?.id,
		state.recentMessages[0]?.id,
		"firstKeptEntryId must point at the new head of recentMessages",
	);
});

test("hydrateState rebuilds entries from summary+recentMessages when entries are absent", async () => {
	const context = buildContext();
	const state: ConversationContextState = {
		summary: "prior summary text",
		recentMessages: [createUserMessage("u"), createAssistantMessage("a")],
	};

	context.hydrateState(state);

	const exported = context.exportState();
	assert.ok(exported.entries && exported.entries.length > 0);

	const compactionEntry = exported.entries?.find(
		(entry) => entry.kind === "compaction",
	);
	assert.ok(
		compactionEntry,
		"fallback hydration should synthesize one compaction",
	);
	assert.equal(compactionEntry?.summary, "prior summary text");

	const messageEntries = exported.entries?.filter(
		(entry) => entry.kind === "message",
	);
	assert.equal(messageEntries?.length, 2);
	assert.equal(
		compactionEntry?.firstKeptEntryId,
		messageEntries?.[0]?.id,
		"synthesized compaction.firstKeptEntryId must point at the first message entry",
	);
});

test("hydrateState restores caller-supplied entries verbatim", () => {
	const context = buildContext();
	const seedId = "msg-prebuilt-1";
	const state: ConversationContextState = {
		summary: "restored summary",
		recentMessages: [createUserMessage("restored input", { id: seedId })],
		entries: [
			{
				kind: "compaction",
				id: "cmp-prebuilt",
				parentId: null,
				timestamp: "2026-07-08T00:00:00.000Z",
				summary: "restored summary",
				firstKeptEntryId: seedId,
			},
			{
				kind: "message",
				id: seedId,
				turnId: 1,
				timestamp: "2026-07-08T00:00:00.000Z",
				message: createUserMessage("restored input", { id: seedId }),
			},
		],
	};

	context.hydrateState(state);

	assert.equal(context.getSummary(), "restored summary");
	assert.deepEqual(context.getRecentMessages(), [
		createUserMessage("restored input", { id: seedId }),
	]);
});

test("reset clears both recentMessages and entries", async () => {
	const context = buildContext();
	await context.appendMessages(
		[createUserMessage("u"), createAssistantMessage("a")],
		STATIC_PROVIDER,
		"You are a test agent.",
		[],
	);

	context.reset();

	const state = context.exportState();
	assert.equal(state.recentMessages.length, 0);
	assert.equal(state.entries?.length ?? 0, 0);
	assert.equal(state.summary, null);
});

test("compact with custom instructions persists them on the CompactionEntry details", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "focused summary",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext({
		summaryEnabled: true,
	});
	context.hydrateState({
		summary: null,
		recentMessages: [
			createUserMessage("u1"),
			createAssistantMessage("a1"),
			createUserMessage("latest"),
		],
	});

	await context.compactNow(provider, "You are a test agent.", [], undefined, {
		instructions: "Focus only on schema changes.",
	});

	const compactionEntries = context
		.exportState()
		.entries?.filter((entry) => entry.kind === "compaction");
	assert.equal(compactionEntries?.length, 1);
	assert.equal(
		compactionEntries?.[0]?.details?.customInstructions,
		"Focus only on schema changes.",
	);
});

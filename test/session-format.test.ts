import assert from "node:assert/strict";
import test from "node:test";
import {
	buildEntriesFromContextState,
	deriveContextStateFromEntries,
	resolveEntriesForPersist,
} from "../src/session/format.js";
import type { PersistedSession, SessionEntry } from "../src/types.js";

test("deriveContextStateFromEntries returns the summary and live messages after the last compaction", () => {
	const entries = buildEntriesFromContextState({
		summary: "the goal",
		recentMessages: [
			{ role: "user", content: "first", id: "m1" },
			{ role: "assistant", content: "second", id: "m2" },
		],
	});
	const state = deriveContextStateFromEntries(entries);
	assert.equal(state.summary, "the goal");
	assert.deepEqual(
		state.recentMessages.map((m) => m.content),
		["first", "second"],
	);
});

test("deriveContextStateFromEntries finds firstKeptEntryId even when it precedes the compaction entry", () => {
	// The compactor records the id of the first kept message *before*
	// appending the compaction entry, so the compaction entry's
	// `firstKeptEntryId` points to a message that lives earlier in the
	// stream. The derivation must scan the whole stream for that id, not
	// only the entries that follow the compaction entry.
	const entries: SessionEntry[] = [
		{
			kind: "message",
			id: "kept-1",
			turnId: null,
			timestamp: "2026-07-31T10:00:00.000Z",
			message: { role: "user", content: "first kept", id: "kept-1" },
		},
		{
			kind: "message",
			id: "kept-2",
			turnId: null,
			timestamp: "2026-07-31T10:00:01.000Z",
			message: { role: "assistant", content: "second kept", id: "kept-2" },
		},
		{
			kind: "compaction",
			id: "compaction-1",
			parentId: null,
			timestamp: "2026-07-31T10:00:02.000Z",
			summary: "compacted summary",
			firstKeptEntryId: "kept-1",
			tokensBefore: 1000,
			details: {
				trigger: "token",
				keptMessages: 2,
				summarizedMessages: 5,
				triggeredBy: "token_estimate",
			},
		},
		{
			kind: "message",
			id: "after-1",
			turnId: null,
			timestamp: "2026-07-31T10:00:03.000Z",
			message: { role: "user", content: "after compact", id: "after-1" },
		},
	];
	const state = deriveContextStateFromEntries(entries);
	assert.equal(state.summary, "compacted summary");
	assert.deepEqual(
		state.recentMessages.map((m) => m.content),
		["first kept", "second kept", "after compact"],
	);
});

test("deriveContextStateFromEntries returns a null summary when there is no compaction entry", () => {
	const entries = buildEntriesFromContextState({
		summary: null,
		recentMessages: [{ role: "user", content: "x", id: "m1" }],
	});
	const state = deriveContextStateFromEntries(entries);
	assert.equal(state.summary, null);
	assert.deepEqual(
		state.recentMessages.map((m) => m.content),
		["x"],
	);
});

test("resolveEntriesForPersist trusts the cumulative entries stream directly", () => {
	const entries = buildEntriesFromContextState({
		summary: null,
		recentMessages: [{ role: "user", content: "x", id: "m1" }],
	});
	const result = resolveEntriesForPersist({
		session: { entries } as unknown as PersistedSession,
		contextState: { summary: null, recentMessages: [], entries },
	});
	assert.equal(result, entries);
});

test("resolveEntriesForPersist returns the existing stream unchanged when no contextState is supplied", () => {
	const entries = buildEntriesFromContextState({
		summary: null,
		recentMessages: [{ role: "user", content: "x", id: "m1" }],
	});
	const result = resolveEntriesForPersist({
		session: { entries } as unknown as PersistedSession,
		contextState: undefined,
	});
	assert.equal(result, entries);
});

test("resolveEntriesForPersist extends the persisted stream with a synthesized window when no entries stream is supplied", () => {
	const base = buildEntriesFromContextState({
		summary: null,
		recentMessages: [{ role: "user", content: "old", id: "old1" }],
	});
	const result = resolveEntriesForPersist({
		session: { entries: base } as unknown as PersistedSession,
		contextState: {
			summary: null,
			recentMessages: [{ role: "user", content: "new", id: "new1" }],
		},
	});
	// The caller did not maintain an entry stream, so the synthesized window
	// is appended to the existing transcript (append-only, never rewritten).
	const derived = deriveContextStateFromEntries(result);
	assert.deepEqual(
		derived.recentMessages.map((m) => m.content),
		["old", "new"],
	);
});

test("resolveEntriesForPersist records a compaction entry from a summary when extending the persisted stream", () => {
	const result = resolveEntriesForPersist({
		session: { entries: [] } as unknown as PersistedSession,
		contextState: {
			summary: "goal",
			recentMessages: [{ role: "user", content: "x", id: "m1" }],
		},
	});
	assert.equal(result.filter((e) => e.kind === "compaction").length, 1);
	const derived = deriveContextStateFromEntries(result);
	assert.equal(derived.summary, "goal");
	assert.deepEqual(
		derived.recentMessages.map((m) => m.content),
		["x"],
	);
});

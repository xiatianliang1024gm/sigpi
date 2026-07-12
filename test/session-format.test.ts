import assert from "node:assert/strict";
import test from "node:test";
import {
	buildEntriesFromContextState,
	deriveContextStateFromEntries,
	formatSessionDetails,
	resolveEntriesForPersist,
} from "../src/session/format.js";
import type { PersistedSession } from "../src/types.js";
import { createTestToolExecution } from "./helpers.js";

test("session show formatting returns snapshot and recent history only", () => {
	const session: PersistedSession = {
		version: 4,
		sessionId: "11111111-1111-4111-8111-111111111111",
		title: "demo",
		createdAt: "2026-05-22T00:00:00.000Z",
		updatedAt: "2026-05-22T00:04:00.000Z",
		cwd: "/tmp/demo",
		systemPromptFingerprint: "fingerprint",
		loadedSkillNames: ["demo"],
		skillsFingerprint: "skills-fingerprint",
		entries: buildEntriesFromContextState({
			summary: "snapshot summary",
			recentMessages: [
				{ role: "user", content: "latest question", id: "msg-u-1" },
				{ role: "assistant", content: "latest answer", id: "msg-a-1" },
			],
		}),
		turnCount: 4,
		lastCompletedUserInput: "latest question",
		status: "active",
		lastTurn: {
			startedAt: "2026-05-22T00:03:00.000Z",
			finishedAt: "2026-05-22T00:04:00.000Z",
			status: "completed",
			userInput: "latest question",
			assistantOutput: "latest answer",
			toolExecutionCount: 1,
			errorMessage: null,
		},
		turns: [
			{
				turnId: 1,
				startedAt: "2026-05-22T00:00:00.000Z",
				finishedAt: "2026-05-22T00:01:00.000Z",
				status: "completed",
				userInput: "one",
				assistantOutput: "a",
				steps: 1,
				toolExecutions: [],
				errorMessage: null,
			},
			{
				turnId: 2,
				startedAt: "2026-05-22T00:01:00.000Z",
				finishedAt: "2026-05-22T00:02:00.000Z",
				status: "failed",
				userInput: "two",
				assistantOutput: null,
				steps: 0,
				toolExecutions: [],
				errorMessage: "bad",
			},
			{
				turnId: 3,
				startedAt: "2026-05-22T00:02:00.000Z",
				finishedAt: "2026-05-22T00:03:00.000Z",
				status: "completed",
				userInput: "three",
				assistantOutput: "c",
				steps: 2,
				toolExecutions: [createTestToolExecution()],
				errorMessage: null,
			},
			{
				turnId: 4,
				startedAt: "2026-05-22T00:03:00.000Z",
				finishedAt: "2026-05-22T00:04:00.000Z",
				status: "completed",
				userInput: "latest question",
				assistantOutput: "latest answer",
				steps: 1,
				toolExecutions: [createTestToolExecution()],
				errorMessage: null,
			},
		],
	};

	const formatted = formatSessionDetails(session);

	assert.equal(formatted.session.sessionId, session.sessionId);
	assert.equal(formatted.snapshot.summary, "snapshot summary");
	assert.equal(formatted.history.totalTurns, 4);
	assert.equal(formatted.history.recentTurns.length, 3);
	assert.deepEqual(
		formatted.history.recentTurns.map((turn) => turn.userInput),
		["two", "three", "latest question"],
	);
	assert.equal(
		"turns" in (formatted.history as Record<string, unknown>),
		false,
	);
});

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

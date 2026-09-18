import assert from "node:assert/strict";
import test from "node:test";
import { derivePlanFromEntries } from "../src/server/plan-state.js";
import type { SessionEntry } from "../src/types.js";

/**
 * `derivePlanFromEntries` is how a *restored* session gets its plan back: tool
 * results are persisted as rendered text (`"ok"`), so the only durable traces of
 * an `update_plan` call are the assistant entry's tool-call arguments plus each
 * entry's timestamp. These cases drive that reconstruction directly.
 */

let seq = 0;
const nextId = () => `e${++seq}`;

/** One assistant step whose single tool call is an `update_plan`. */
function planEntry(
	plan: Array<{ step: string; status: string }>,
	timestamp: string,
	options: { explanation?: string; name?: string } = {},
): SessionEntry {
	const id = nextId();
	const args: Record<string, unknown> = { plan };
	if (options.explanation !== undefined) args.explanation = options.explanation;
	return {
		kind: "message",
		id,
		turnId: null,
		timestamp,
		message: {
			role: "assistant",
			content: null,
			id,
			toolCalls: [
				{
					id: `${id}-call`,
					name: options.name ?? "update_plan",
					arguments: args,
					rawArguments: JSON.stringify(args),
				},
			],
		},
	};
}

function userEntry(timestamp: string): SessionEntry {
	const id = nextId();
	return {
		kind: "message",
		id,
		turnId: null,
		timestamp,
		message: { role: "user", content: "go", id: `${id}-msg` },
	};
}

const T0 = "2025-01-01T00:00:00.000Z";
const T1 = "2025-01-01T00:00:30.000Z";
const T2 = "2025-01-01T00:01:10.000Z";

test("derivePlanFromEntries returns null when the session never planned", () => {
	assert.equal(derivePlanFromEntries([]), null);
	assert.equal(derivePlanFromEntries([userEntry(T0)]), null);
	assert.equal(
		derivePlanFromEntries([
			planEntry([{ step: "a", status: "pending" }], T0, { name: "bash" }),
		]),
		null,
	);
});

test("derivePlanFromEntries returns null when every plan call is unusable", () => {
	assert.equal(
		derivePlanFromEntries([
			// An empty list is not a plan.
			planEntry([], T0),
			// Every item is dropped (unknown status), so the call yields nothing.
			planEntry([{ step: "a", status: "sideways" }], T1),
		]),
		null,
	);
});

test("derivePlanFromEntries keeps the last usable plan when a later call is malformed", () => {
	const brokenId = nextId();
	const broken: SessionEntry = {
		kind: "message",
		id: brokenId,
		turnId: null,
		timestamp: T2,
		message: {
			role: "assistant",
			content: null,
			id: brokenId,
			toolCalls: [
				{
					id: `${brokenId}-call`,
					name: "update_plan",
					arguments: { plan: "not-an-array" },
					rawArguments: "{}",
				},
			],
		},
	};
	const snapshot = derivePlanFromEntries([
		planEntry([{ step: "a", status: "completed" }], T0),
		userEntry(T1),
		broken,
	]);
	assert.equal(snapshot?.updatedAt, T0);
	assert.deepEqual(
		snapshot?.items.map((item) => item.step),
		["a"],
	);
});

test("derivePlanFromEntries reads the latest call's list and metadata", () => {
	const snapshot = derivePlanFromEntries([
		userEntry(T0),
		planEntry([{ step: "a", status: "pending" }], T0, { explanation: "first" }),
		planEntry(
			[
				{ step: "a", status: "completed" },
				{ step: "b", status: "in_progress" },
				{ step: "c", status: "pending" },
			],
			T1,
			{ explanation: "second" },
		),
	]);
	assert.equal(snapshot?.explanation, "second");
	assert.equal(snapshot?.updatedAt, T1);
	assert.deepEqual(snapshot?.items, [
		{
			step: "a",
			status: "completed",
			startedAt: null,
			completedAt: T1,
			elapsedMs: null,
		},
		{
			step: "b",
			status: "in_progress",
			startedAt: T1,
			completedAt: null,
			elapsedMs: null,
		},
		{
			step: "c",
			status: "pending",
			startedAt: null,
			completedAt: null,
			elapsedMs: null,
		},
	]);
});

test("derivePlanFromEntries measures each item between its in_progress and completed calls", () => {
	const snapshot = derivePlanFromEntries([
		planEntry(
			[
				{ step: "a", status: "in_progress" },
				{ step: "b", status: "pending" },
			],
			T0,
		),
		planEntry(
			[
				{ step: "a", status: "completed" },
				{ step: "b", status: "in_progress" },
			],
			T1,
		),
		planEntry(
			[
				{ step: "a", status: "completed" },
				{ step: "b", status: "completed" },
			],
			T2,
		),
	]);
	const a = snapshot?.items[0];
	const b = snapshot?.items[1];
	assert.equal(a?.startedAt, T0);
	assert.equal(a?.completedAt, T1);
	assert.equal(a?.elapsedMs, 30_000);
	assert.equal(b?.startedAt, T1);
	assert.equal(b?.completedAt, T2);
	assert.equal(b?.elapsedMs, 40_000);
});

test("derivePlanFromEntries restarts the clock when a step is re-opened", () => {
	const snapshot = derivePlanFromEntries([
		planEntry([{ step: "a", status: "in_progress" }], T0),
		planEntry([{ step: "a", status: "completed" }], T1),
		planEntry([{ step: "a", status: "in_progress" }], T2),
	]);
	const item = snapshot?.items[0];
	assert.equal(item?.status, "in_progress");
	assert.equal(item?.startedAt, T2);
	// The re-opened run has no end yet, so no elapsed time is claimed.
	assert.equal(item?.completedAt, null);
	assert.equal(item?.elapsedMs, null);
});

test("derivePlanFromEntries leaves elapsed time unknown when the model skips in_progress", () => {
	const snapshot = derivePlanFromEntries([
		planEntry([{ step: "a", status: "pending" }], T0),
		planEntry([{ step: "a", status: "completed" }], T1),
	]);
	assert.equal(snapshot?.items[0]?.elapsedMs, null);
	assert.equal(snapshot?.items[0]?.completedAt, T1);
});

test("derivePlanFromEntries drops timings for a step that falls back to pending", () => {
	const snapshot = derivePlanFromEntries([
		planEntry([{ step: "a", status: "in_progress" }], T0),
		planEntry([{ step: "a", status: "pending" }], T1),
	]);
	assert.deepEqual(snapshot?.items[0], {
		step: "a",
		status: "pending",
		startedAt: null,
		completedAt: null,
		elapsedMs: null,
	});
});

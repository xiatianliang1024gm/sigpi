import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

/**
 * The web plan fold (`src/server/web/plan-fold.js`) is the browser's reduction
 * of the `update_plan` SSE frames into the snapshot the plan bar renders. It is
 * DOM-free (like `reducer.js`), so it loads as a plain ES module in Node and can
 * be driven directly with the frames the runner emits.
 */

const foldUrl = new URL("../src/server/web/plan-fold.js", import.meta.url);
const stateUrl = new URL("../src/server/web/state.js", import.meta.url);

interface PlanItemShape {
	step: string;
	status: string;
	startedAt: string | null;
	completedAt: string | null;
	elapsedMs: number | null;
	localStartedAt: number | null;
}

interface PlanShape {
	explanation: string | null;
	updatedAt: string | null;
	items: PlanItemShape[];
}

interface FoldModule {
	foldPlanEvent: (event: unknown, now?: number) => boolean;
	parsePlanArgs: (args: unknown) => PlanShape | null;
	planProgress: (plan: PlanShape) => {
		total: number;
		completed: number;
		done: number;
		current: PlanItemShape | null;
	};
	itemElapsedMs: (item: PlanItemShape, now?: number) => number | null;
	planTotalMs: (plan: PlanShape, now?: number) => number | null;
}

interface StateModule {
	state: { plan: PlanShape | null };
	resetState: () => void;
}

const fold = (await import(foldUrl.href)) as FoldModule;
const { state, resetState } = (await import(stateUrl.href)) as StateModule;

/** A `tool_execution_started` frame for `update_plan`. */
function startedFrame(
	plan: Array<{ step: string; status: string }>,
	options: { explanation?: string; subAgent?: unknown; toolName?: string } = {},
): Record<string, unknown> {
	return {
		type: "tool_execution_started",
		toolName: options.toolName ?? "update_plan",
		toolCallId: "call-1",
		arguments: { explanation: options.explanation, plan },
		message: "[1/2] a",
		subAgent: options.subAgent,
	};
}

/** A `tool_execution_finished` frame carrying the tool's structured result. */
function finishedFrame(
	plan: Array<{ step: string; status: string }>,
	options: { explanation?: string; data?: unknown; subAgent?: unknown } = {},
): Record<string, unknown> {
	return {
		type: "tool_execution_finished",
		toolName: "update_plan",
		toolCallId: "call-1",
		ok: true,
		elapsedMs: 3,
		result: "ok",
		data:
			options.data !== undefined
				? options.data
				: {
						explanation: options.explanation,
						updatedAt: "2025-01-01T00:00:00.000Z",
						plan,
					},
		subAgent: options.subAgent,
	};
}

test.beforeEach(() => {
	resetState();
});

test("foldPlanEvent ignores frames that are not the plan tool", () => {
	assert.equal(
		fold.foldPlanEvent(
			startedFrame([{ step: "a", status: "pending" }], { toolName: "bash" }),
		),
		false,
	);
	assert.equal(fold.foldPlanEvent({ type: "step_started" }), false);
	assert.equal(state.plan, null);
});

test("foldPlanEvent ignores sub-agent frames", () => {
	const subAgent = { id: "child-1", name: "scout" };
	assert.equal(
		fold.foldPlanEvent(
			startedFrame([{ step: "a", status: "pending" }], { subAgent }),
		),
		false,
	);
	assert.equal(
		fold.foldPlanEvent(
			finishedFrame([{ step: "a", status: "pending" }], { subAgent }),
		),
		false,
	);
	assert.equal(state.plan, null);
});

test("foldPlanEvent takes the started frame's arguments ahead of the call", () => {
	const changed = fold.foldPlanEvent(
		startedFrame(
			[
				{ step: "a", status: "in_progress" },
				{ step: "b", status: "pending" },
			],
			{ explanation: "kick off" },
		),
		1_000,
	);
	assert.equal(changed, true);
	assert.equal(state.plan?.explanation, "kick off");
	assert.equal(state.plan?.items[0]?.status, "in_progress");
	assert.equal(state.plan?.items[0]?.localStartedAt, 1_000);
	assert.equal(state.plan?.items[1]?.status, "pending");
});

test("foldPlanEvent lets the finished frame's data win over the arguments", () => {
	fold.foldPlanEvent(
		startedFrame([{ step: "a", status: "in_progress" }]),
		1_000,
	);
	fold.foldPlanEvent(
		finishedFrame([
			{ step: "a", status: "completed" },
			{ step: "b", status: "in_progress" },
		]),
		5_000,
	);
	assert.deepEqual(
		state.plan?.items.map((item) => [item.step, item.status]),
		[
			["a", "completed"],
			["b", "in_progress"],
		],
	);
	// The step that just finished freezes at the fold's clock.
	assert.equal(state.plan?.items[0]?.elapsedMs, 4_000);
	assert.equal(state.plan?.items[1]?.localStartedAt, 5_000);
});

test("foldPlanEvent keeps the previous plan when a frame is malformed", () => {
	fold.foldPlanEvent(
		startedFrame([{ step: "a", status: "in_progress" }]),
		1_000,
	);
	assert.equal(
		fold.foldPlanEvent(finishedFrame([], { data: { plan: "nope" } }), 2_000),
		false,
	);
	assert.equal(
		fold.foldPlanEvent(finishedFrame([], { data: null }), 2_000),
		false,
	);
	assert.equal(
		fold.foldPlanEvent(startedFrame([], { toolName: "update_plan" }), 2_000),
		false,
	);
	assert.deepEqual(
		state.plan?.items.map((item) => item.step),
		["a"],
	);
});

test("foldPlanEvent is idempotent: replaying the open turn lands on the same snapshot", () => {
	const frames = [
		startedFrame([
			{ step: "a", status: "in_progress" },
			{ step: "b", status: "pending" },
		]),
		finishedFrame([
			{ step: "a", status: "completed" },
			{ step: "b", status: "in_progress" },
		]),
		finishedFrame([
			{ step: "a", status: "completed" },
			{ step: "b", status: "completed" },
		]),
	];
	const runThrough = () => {
		resetState();
		for (const frame of frames) fold.foldPlanEvent(frame, 10_000);
		return state.plan;
	};
	const first = runThrough();
	const replay = runThrough();
	assert.deepEqual(replay, first);
	assert.equal(first?.items[0]?.elapsedMs, 0);
	assert.equal(first?.items[1]?.elapsedMs, 0);
});

test("planProgress counts the work position, not just finished steps", () => {
	const plan: PlanShape = {
		explanation: null,
		updatedAt: null,
		items: [
			{
				step: "a",
				status: "completed",
				startedAt: null,
				completedAt: null,
				elapsedMs: 1_000,
				localStartedAt: null,
			},
			{
				step: "b",
				status: "in_progress",
				startedAt: null,
				completedAt: null,
				elapsedMs: null,
				localStartedAt: 5_000,
			},
			{
				step: "c",
				status: "pending",
				startedAt: null,
				completedAt: null,
				elapsedMs: null,
				localStartedAt: null,
			},
		],
	};
	assert.deepEqual(fold.planProgress(plan), {
		total: 3,
		completed: 1,
		done: 2,
		current: plan.items[1],
	});
});

test("itemElapsedMs ticks a running step and freezes a finished one", () => {
	const running: PlanItemShape = {
		step: "b",
		status: "in_progress",
		startedAt: null,
		completedAt: null,
		elapsedMs: null,
		localStartedAt: 5_000,
	};
	assert.equal(fold.itemElapsedMs(running, 8_000), 3_000);
	const done: PlanItemShape = {
		...running,
		status: "completed",
		elapsedMs: 4_000,
	};
	assert.equal(fold.itemElapsedMs(done, 99_000), 4_000);
	// A restored (server-timed) step falls back to its persisted timestamps.
	assert.equal(
		fold.itemElapsedMs(
			{
				step: "b",
				status: "completed",
				startedAt: "2025-01-01T00:00:00.000Z",
				completedAt: "2025-01-01T00:00:12.000Z",
				elapsedMs: null,
				localStartedAt: null,
			},
			0,
		),
		12_000,
	);
	assert.equal(
		fold.itemElapsedMs(
			{ ...running, status: "pending", localStartedAt: null },
			8_000,
		),
		null,
	);
});

test("the plan bar and panel render against the real index.html", async () => {
	// `dom.js` collects its element handles at import time, so the document has
	// to exist before `plan.js` (and its `./dom.js` import) is loaded.
	const html = await readFile(
		new URL("../src/server/web/index.html", import.meta.url),
		"utf8",
	);
	const dom = new JSDOM(html, { url: "http://localhost/" });
	globalThis.document = dom.window.document;
	const planModule = (await import(
		new URL("../src/server/web/plan.js", import.meta.url).href
	)) as {
		renderPlan: () => void;
		togglePlanPanel: () => void;
		closePlanPanel: () => void;
		resetPlan: () => void;
	};

	const element = (id: string) => {
		const found = dom.window.document.getElementById(id);
		assert.ok(found, `#${id} should exist in index.html`);
		return found;
	};

	assert.equal(element("plan-bar").hidden, true, "hidden until a plan exists");

	state.plan = {
		explanation: "多步任务",
		updatedAt: new Date().toISOString(),
		items: [
			{
				step: "a",
				status: "completed",
				startedAt: null,
				completedAt: null,
				elapsedMs: 30_000,
				localStartedAt: null,
			},
			{
				step: "b",
				status: "in_progress",
				startedAt: null,
				completedAt: null,
				elapsedMs: null,
				localStartedAt: Date.now() - 3_000,
			},
			{
				step: "c",
				status: "pending",
				startedAt: null,
				completedAt: null,
				elapsedMs: null,
				localStartedAt: null,
			},
		],
	};
	planModule.renderPlan();

	assert.equal(element("plan-bar").hidden, false);
	assert.match(element("plan-bar-label").textContent ?? "", /\[2\/3\] b/);
	assert.match(element("plan-bar-time").textContent ?? "", /^\d+s$/);
	assert.ok(element("plan-bar").classList.contains("is-running"));

	planModule.togglePlanPanel();
	assert.equal(element("plan-panel").hidden, false);
	assert.equal(element("plan-list").children.length, 3);
	assert.match(element("plan-list").textContent ?? "", /🔄.*b/);
	assert.match(element("plan-meta").textContent ?? "", /多步任务/);

	planModule.closePlanPanel();
	assert.equal(element("plan-panel").hidden, true);

	planModule.resetPlan();
	assert.equal(element("plan-bar").hidden, true);
	assert.equal(state.plan, null);
});

test("planTotalMs sums what is measurable and gives up when nothing is", () => {
	assert.equal(
		fold.planTotalMs({
			explanation: null,
			updatedAt: null,
			items: [
				{
					step: "a",
					status: "completed",
					startedAt: null,
					completedAt: null,
					elapsedMs: 1_000,
					localStartedAt: null,
				},
				{
					step: "b",
					status: "completed",
					startedAt: null,
					completedAt: null,
					elapsedMs: 2_500,
					localStartedAt: null,
				},
			],
		}),
		3_500,
	);
	assert.equal(
		fold.planTotalMs({
			explanation: null,
			updatedAt: null,
			items: [
				{
					step: "a",
					status: "pending",
					startedAt: null,
					completedAt: null,
					elapsedMs: null,
					localStartedAt: null,
				},
			],
		}),
		null,
	);
});

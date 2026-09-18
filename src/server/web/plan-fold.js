// The `update_plan` fold for the browser client: a pure reduction of the SSE
// tool frames into the plan snapshot the bar and the panel render.
//
// Deliberately DOM-free (like `reducer.js`) so it loads as a plain ES module and
// is unit-testable in Node; `plan.js` owns every `document` touch. The events
// come straight off the wire: `tool_execution_started` carries the tool's
// *arguments* (so the UI can move before the call resolves) and
// `tool_execution_finished` carries the tool's structured `data` — the plan
// array the tool actually stored, which is authoritative.
//
// `parsePlanArgs` below is a verbatim port of `src/plan-tracker.ts` (the browser
// cannot import the TypeScript source) — keep the two in sync.

import { state } from "./state.js";

/** The tool whose frames this fold absorbs. */
const PLAN_TOOL = "update_plan";

/** Statuses the tool's schema allows. */
export const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);

/**
 * Build a plan view from raw tool arguments. Returns `null` when there is no
 * usable plan, so callers can treat "no plan" and "empty plan" uniformly.
 * Port of `parsePlanArgs` in `src/plan-tracker.ts`.
 */
export function parsePlanArgs(args) {
	if (!args || !Array.isArray(args.plan)) return null;
	const items = [];
	for (const raw of args.plan) {
		if (
			!raw ||
			typeof raw !== "object" ||
			typeof raw.step !== "string" ||
			!PLAN_STATUSES.has(raw.status)
		) {
			continue;
		}
		items.push({ step: raw.step, status: raw.status });
	}
	if (items.length === 0) return null;
	return {
		explanation:
			typeof args.explanation === "string" && args.explanation.trim()
				? args.explanation.trim()
				: null,
		items,
		updatedAt: new Date().toISOString(),
	};
}

/**
 * Fold one SSE frame into {@link state.plan}. Non-plan frames (and every
 * sub-agent frame — a child run's plan is not the session's) are ignored, so
 * this is safe to call for every event.
 *
 * Idempotent by construction: each frame overwrites the plan wholesale and only
 * a status *transition* moves a clock, so replaying the same frame sequence
 * (a reconnect replays the whole open turn) lands on the same snapshot.
 *
 * Returns whether the plan changed, so the caller knows it must repaint.
 */
export function foldPlanEvent(event, now = Date.now()) {
	if (!event || event.subAgent || event.toolName !== PLAN_TOOL) return false;

	if (event.type === "tool_execution_started") {
		const view = parsePlanArgs(event.arguments);
		if (!view) return false;
		applyPlan(view, now);
		return true;
	}

	if (event.type !== "tool_execution_finished") return false;
	const data = event.data;
	if (!data || typeof data !== "object" || !Array.isArray(data.plan)) {
		return false;
	}
	const items = [];
	for (const raw of data.plan) {
		if (
			!raw ||
			typeof raw !== "object" ||
			typeof raw.step !== "string" ||
			!PLAN_STATUSES.has(raw.status)
		) {
			continue;
		}
		items.push({ step: raw.step, status: raw.status });
	}
	if (items.length === 0) return false;
	applyPlan(
		{
			explanation:
				typeof data.explanation === "string" && data.explanation.trim()
					? data.explanation.trim()
					: (state.plan?.explanation ?? null),
			updatedAt:
				typeof data.updatedAt === "string"
					? data.updatedAt
					: new Date(now).toISOString(),
			items,
		},
		now,
	);
	return true;
}

/**
 * Replace the plan, carrying per-step timings across by `step`. A step that
 * reappears keeps the clock it already had; one that transitions gets a fresh
 * start (in-progress) or a frozen elapsed time (completed).
 */
function applyPlan(view, now) {
	const previous = new Map(
		(state.plan?.items ?? []).map((item) => [item.step, item]),
	);
	const items = view.items.map((item) => {
		const old = previous.get(item.step);
		const next = {
			step: item.step,
			status: item.status,
			startedAt: old?.startedAt ?? null,
			completedAt: old?.completedAt ?? null,
			elapsedMs: old?.elapsedMs ?? null,
			// Client-clock start, so a live in-progress step can tick without
			// trusting the server's timestamps for wall-clock math.
			localStartedAt: old?.localStartedAt ?? null,
		};
		if (old?.status === item.status) return next;

		if (item.status === "in_progress") {
			next.localStartedAt = now;
			next.startedAt = new Date(now).toISOString();
			next.completedAt = null;
			next.elapsedMs = null;
		} else if (item.status === "completed") {
			next.completedAt = new Date(now).toISOString();
			next.elapsedMs =
				next.localStartedAt != null
					? Math.max(0, now - next.localStartedAt)
					: next.elapsedMs;
			next.localStartedAt = null;
		} else {
			next.localStartedAt = null;
			next.startedAt = null;
			next.completedAt = null;
			next.elapsedMs = null;
		}
		return next;
	});
	state.plan = {
		explanation: view.explanation ?? null,
		updatedAt: view.updatedAt ?? new Date(now).toISOString(),
		items,
	};
}

/**
 * The plan's progress counters: `done` counts the work position (completed
 * items plus the single in-progress one), matching
 * `formatPlanProgressSummaryLine` in `src/plan-tracker.ts`.
 */
export function planProgress(plan) {
	const total = plan.items.length;
	const completed = plan.items.filter(
		(item) => item.status === "completed",
	).length;
	const current =
		plan.items.find((item) => item.status === "in_progress") ?? null;
	return { total, completed, done: completed + (current ? 1 : 0), current };
}

/**
 * Elapsed time for one plan item in ms, or `null` when it cannot be derived
 * (a step the model jumped straight to completed, or one that never started).
 * Live turns measure from the client clock; a restored session falls back to
 * the persisted timestamps — both are approximations by design.
 */
export function itemElapsedMs(item, now = Date.now()) {
	if (item.status === "completed") {
		if (Number.isFinite(item.elapsedMs)) return item.elapsedMs;
		return isoDiff(item.startedAt, item.completedAt);
	}
	if (item.status === "in_progress") {
		if (Number.isFinite(item.localStartedAt)) {
			return Math.max(0, now - item.localStartedAt);
		}
		const started = item.startedAt ? Date.parse(item.startedAt) : Number.NaN;
		if (Number.isFinite(started)) return Math.max(0, now - started);
	}
	return null;
}

/** Total measured time across the plan's items; `null` when none is measurable. */
export function planTotalMs(plan, now = Date.now()) {
	let total = 0;
	let measured = false;
	for (const item of plan.items) {
		const elapsed = itemElapsedMs(item, now);
		if (elapsed == null) continue;
		total += elapsed;
		measured = true;
	}
	return measured ? total : null;
}

/** Milliseconds between two ISO timestamps; `null` when either is unusable. */
function isoDiff(startedAt, endedAt) {
	if (!startedAt || !endedAt) return null;
	const start = Date.parse(startedAt);
	const end = Date.parse(endedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	return Math.max(0, end - start);
}

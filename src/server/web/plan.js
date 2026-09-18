// The plan bar and its popover: the web-only view of the agent's `update_plan`
// task list. The transcript keeps showing the shared `⚙ [n/m] …` line (that
// line is the TUI/web reducer's output); the bar is the incremental,
// web-specific surface that shows the current step with a live timer and lets
// the reader open the full plan.
//
// State arrives two ways and both funnel into `state.plan`:
//   * live — `foldPlanEvent` (in `plan-fold.js`) reduces the SSE tool frames;
//   * restored — `fetchPlan` reads `GET .../plan`, which the server rebuilds
//     from the persisted entry stream.
//
// Interaction mirrors the background-task popover (`tasks.js`): the bar toggles
// the panel, an outside click closes it, and nothing is fetched while it is
// closed.

import { requestJson, sessionBase } from "./api.js";
import { els } from "./dom.js";
import {
	itemElapsedMs,
	PLAN_STATUSES,
	planProgress,
	planTotalMs,
} from "./plan-fold.js";
import { state } from "./state.js";

/** How often the live timer repaints while a step is in progress. */
const TICK_MS = 1000;

/** Whether the popover is currently open. */
let panelOpen = false;
/** Interval repainting the running timer; `null` while no step is in progress. */
let ticker = null;

/** Wire the bar, the panel's close button, and the outside-click dismissal. */
export function initPlan() {
	els.planBar?.addEventListener("click", (event) => {
		event.stopPropagation();
		togglePlanPanel();
	});
	els.planClose?.addEventListener("click", (event) => {
		event.stopPropagation();
		closePlanPanel();
	});
	// Clicks inside the panel must not reach the document handler below it.
	els.planPanel?.addEventListener("click", (event) => {
		event.stopPropagation();
	});
}

/** Forget the plan (on session switch and disconnect). */
export function resetPlan() {
	closePlanPanel();
	state.plan = null;
	renderPlanBar();
	stopTicker();
}

/**
 * Load the plan a stored session left off with. Failures (an older server, a
 * session with no plan) collapse to `null` — the bar simply stays hidden; a
 * session switch mid-flight drops the stale result.
 */
export async function fetchPlan() {
	if (!state.sessionId) {
		resetPlan();
		return;
	}
	const projectKey = state.projectKey;
	const sessionId = state.sessionId;
	let plan = null;
	try {
		const body = await requestJson(`${sessionBase()}/plan`);
		if (state.sessionId !== sessionId || state.projectKey !== projectKey)
			return;
		plan = normalizePlan(body?.plan);
	} catch {
		if (state.sessionId !== sessionId || state.projectKey !== projectKey)
			return;
		plan = null;
	}
	state.plan = plan;
	renderPlan();
}

/** Close the popover. Safe to call when it is already closed. */
export function closePlanPanel() {
	if (!panelOpen) return;
	panelOpen = false;
	if (els.planPanel) els.planPanel.hidden = true;
	renderPlanBar();
}

/** Toggle the popover from the bar. */
export function togglePlanPanel() {
	if (panelOpen) closePlanPanel();
	else openPlanPanel();
}

/** Open the popover over the bar with the plan's current state. */
function openPlanPanel() {
	if (panelOpen || !state.plan) return;
	panelOpen = true;
	if (els.planPanel) els.planPanel.hidden = false;
	renderPlanPanel();
	renderPlanBar();
}

/** Coerce a `GET .../plan` payload into the client's plan shape. */
function normalizePlan(raw) {
	if (!raw || !Array.isArray(raw.items)) return null;
	const items = raw.items
		.filter(
			(item) =>
				item && typeof item.step === "string" && PLAN_STATUSES.has(item.status),
		)
		.map((item) => ({
			step: item.step,
			status: item.status,
			startedAt: typeof item.startedAt === "string" ? item.startedAt : null,
			completedAt:
				typeof item.completedAt === "string" ? item.completedAt : null,
			elapsedMs: Number.isFinite(item.elapsedMs) ? item.elapsedMs : null,
			// A restored plan is timed from the server's timestamps only.
			localStartedAt: null,
		}));
	if (items.length === 0) return null;
	return {
		explanation: typeof raw.explanation === "string" ? raw.explanation : null,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
		items,
	};
}

// --- rendering -------------------------------------------------------------

/** Repaint the bar, and the panel when it is open. */
export function renderPlan() {
	renderPlanBar();
	if (panelOpen) renderPlanPanel();
	syncTicker();
}

/**
 * The bar: the current step (or a completion summary) plus its running time.
 * Hidden entirely while the session has no plan.
 */
function renderPlanBar() {
	const bar = els.planBar;
	if (!bar) return;
	const plan = state.plan;
	if (!plan || plan.items.length === 0) {
		bar.hidden = true;
		stopTicker();
		return;
	}

	const now = Date.now();
	const { total, done, current } = planProgress(plan);
	const allDone = plan.items.every((item) => item.status === "completed");
	bar.hidden = false;
	bar.classList.toggle("is-done", allDone);
	bar.classList.toggle("is-running", !allDone && Boolean(current));
	bar.setAttribute("aria-expanded", panelOpen ? "true" : "false");

	const label = allDone
		? `全部完成 (${total}/${total})`
		: current
			? `[${done}/${total}] ${current.step}`
			: `[${done}/${total}]`;
	if (els.planBarLabel) els.planBarLabel.textContent = label;
	const elapsed = allDone
		? planTotalMs(plan, now)
		: current
			? itemElapsedMs(current, now)
			: null;
	if (els.planBarTime) els.planBarTime.textContent = formatDuration(elapsed);
	bar.title = `任务计划 · ${label}（点击${panelOpen ? "收起" : "展开"}完整计划）`;
}

/** The panel: one row per step, then the plan's own metadata. */
function renderPlanPanel() {
	const list = els.planList;
	if (!list || !state.plan) return;
	const plan = state.plan;
	const now = Date.now();
	list.textContent = "";
	for (const item of plan.items) {
		const row = document.createElement("div");
		row.className = "plan-item";
		if (item.status === "in_progress") row.classList.add("running");
		else if (item.status === "completed") row.classList.add("done");

		const glyph = document.createElement("span");
		glyph.className = "plan-glyph";
		glyph.textContent = statusGlyph(item.status);

		const step = document.createElement("span");
		step.className = "plan-step";
		step.textContent = item.step;
		step.title = item.step;

		const meta = document.createElement("span");
		meta.className = "plan-item-meta";
		meta.textContent = `${statusLabel(item.status)} · ${formatDuration(itemElapsedMs(item, now))}`;

		row.append(glyph, step, meta);
		list.append(row);
	}
	renderPlanMeta(plan);
}

/** The panel footer: the model's explanation and the last update time. */
function renderPlanMeta(plan) {
	const meta = els.planMeta;
	if (!meta) return;
	const bits = [];
	if (plan.explanation) bits.push(plan.explanation);
	if (plan.updatedAt) {
		const when = formatTimestamp(plan.updatedAt);
		if (when) bits.push(`更新于 ${when}`);
	}
	meta.textContent = bits.join(" · ");
	meta.title = meta.textContent;
}

/** Keep the 1s repaint alive only while a step is actually running. */
function syncTicker() {
	const running = Boolean(
		state.plan?.items.some((item) => item.status === "in_progress"),
	);
	if (running) startTicker();
	else stopTicker();
}

function startTicker() {
	if (ticker !== null) return;
	ticker = setInterval(() => {
		renderPlanBar();
		if (panelOpen) renderPlanPanel();
		syncTicker();
	}, TICK_MS);
	// Never pin the process open (the jsdom test harness runs this module).
	ticker?.unref?.();
}

function stopTicker() {
	if (ticker === null) return;
	clearInterval(ticker);
	ticker = null;
}

// --- formatting ------------------------------------------------------------

/** Status glyphs, matching `formatPlanStatusGlyph` in `src/plan-tracker.ts`. */
function statusGlyph(status) {
	if (status === "completed") return "✅";
	if (status === "in_progress") return "🔄";
	return "⬜";
}

function statusLabel(status) {
	if (status === "completed") return "已完成";
	if (status === "in_progress") return "进行中";
	return "待处理";
}

/** Format an elapsed duration as `12s`, `3m 12s`, `1h 2m`; `—` when unknown. */
function formatDuration(ms) {
	if (ms == null || !Number.isFinite(ms)) return "—";
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const parts = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
	return parts.join(" ");
}

/** A short local time for the plan's `updatedAt`; `""` when unparseable. */
function formatTimestamp(iso) {
	const parsed = Date.parse(iso);
	if (!Number.isFinite(parsed)) return "";
	return new Date(parsed).toLocaleTimeString();
}

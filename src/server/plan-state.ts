import {
	type PlanStatus,
	type PlanView,
	parsePlanArgs,
} from "../plan-tracker.js";
import type { SessionEntry } from "../types.js";

/**
 * Rebuild the `update_plan` snapshot for a session from its persisted entry
 * stream. The live turn carries the plan on every `update_plan` tool frame, but
 * a *restored* session only has disk: tool results are persisted as rendered
 * text (`"ok"`), so the plan has to be reconstructed from the assistant
 * entries' preserved tool-call arguments plus each entry's timestamp.
 *
 * Kept a pure function over the stream (no I/O, no DOM) so it is unit-testable
 * and usable for both live and offline sessions.
 */

export interface PlanItemSnapshot {
	step: string;
	status: PlanStatus;
	/** Timestamp of the `update_plan` call that first put this item in progress. */
	startedAt: string | null;
	/** Timestamp of the call that marked it completed. */
	completedAt: string | null;
	/** `completedAt − startedAt`; `null` when either end is unknown. */
	elapsedMs: number | null;
}

export interface PlanSnapshot {
	explanation: string | null;
	/** Timestamp of the last `update_plan` call in the stream. */
	updatedAt: string | null;
	items: PlanItemSnapshot[];
}

/** Per-step timing accumulated while scanning the stream. */
interface StepTiming {
	startedAt: string | null;
	completedAt: string | null;
	elapsedMs: number | null;
	lastStatus: PlanStatus | null;
}

/**
 * Derive the session's plan, or `null` when it never called `update_plan` (or
 * every persisted call's arguments were unusable).
 *
 * The scan is single-pass and chronological: each `update_plan` call overwrites
 * the plan wholesale (the model replaces the list, it does not patch it), while
 * per-step timings accumulate keyed by `step` so an item that is re-opened
 * (`in_progress` again after being completed, or after a `pending` reset)
 * restarts its clock from the newer call.
 */
export function derivePlanFromEntries(
	entries: readonly SessionEntry[],
): PlanSnapshot | null {
	const timing = new Map<string, StepTiming>();
	let latestView: PlanView | null = null;
	let latestTimestamp: string | null = null;

	for (const entry of entries) {
		if (entry.kind !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant" || !message.toolCalls) continue;
		const timestamp = entry.timestamp;
		for (const call of message.toolCalls) {
			if (call.name !== "update_plan") continue;
			const view = parsePlanArgs(call.arguments);
			if (!view) continue;
			latestView = view;
			latestTimestamp = timestamp;
			for (const item of view.items) {
				timing.set(
					item.step,
					advanceTiming(timing.get(item.step), item.status, timestamp),
				);
			}
		}
	}

	if (!latestView) return null;
	const view = latestView;

	return {
		explanation: view.explanation,
		updatedAt: latestTimestamp,
		items: view.items.map((item) => {
			const step = timing.get(item.step);
			return {
				step: item.step,
				status: item.status,
				startedAt: step?.startedAt ?? null,
				completedAt: step?.completedAt ?? null,
				// A completed item keeps whatever interval was measurable; an
				// in-progress one has no end yet (`null`, rendered live).
				elapsedMs:
					item.status === "completed" ? (step?.elapsedMs ?? null) : null,
			};
		}),
	};
}

/**
 * Fold one `update_plan` call's status for `step` into its running timing.
 * Only a *transition* moves a clock: a repeated status leaves the recorded
 * interval alone, so the item's elapsed time is the last visible
 * in-progress → completed span rather than a sum of re-announcements.
 */
function advanceTiming(
	previous: StepTiming | undefined,
	status: PlanStatus,
	timestamp: string,
): StepTiming {
	const next: StepTiming = previous
		? { ...previous }
		: { startedAt: null, completedAt: null, elapsedMs: null, lastStatus: null };

	if (status === previous?.lastStatus) {
		// A re-announced status is not a transition; keep the clock as-is.
		return next;
	}

	if (status === "in_progress") {
		next.startedAt = timestamp;
		next.completedAt = null;
		next.elapsedMs = null;
	} else if (status === "completed") {
		next.completedAt = timestamp;
		next.elapsedMs = elapsedBetween(previous?.startedAt ?? null, timestamp);
	} else {
		next.startedAt = null;
		next.completedAt = null;
		next.elapsedMs = null;
	}
	next.lastStatus = status;
	return next;
}

/** Milliseconds between two ISO timestamps; `null` when either is unusable. */
function elapsedBetween(
	startedAt: string | null,
	endedAt: string,
): number | null {
	if (!startedAt) return null;
	const start = Date.parse(startedAt);
	const end = Date.parse(endedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	return Math.max(0, end - start);
}

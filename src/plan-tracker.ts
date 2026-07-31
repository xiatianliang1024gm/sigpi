type PlanStatus = "pending" | "in_progress" | "completed";

interface PlanItem {
	step: string;
	status: PlanStatus;
	activeForm?: string;
}

interface PlanView {
	explanation: string | null;
	items: PlanItem[];
	updatedAt: string | null;
}

export function formatPlanStatusGlyph(status: PlanStatus | string): string {
	switch (status) {
		case "completed":
			return "✅";
		case "in_progress":
			return "🔄";
		default:
			return "⬜";
	}
}

/**
 * One-line summary for the `update_plan` tool's progress description, e.g.
 * "[2/5] Patching the renderer" while a step is in progress, or
 * "[5/5] All steps completed" when every step is done. Falls back to
 * "[completed/total]" with no trailing step label when no step is in progress
 * and the plan is not fully complete (e.g. all items still pending).
 */
export function formatPlanProgressSummaryLine(view: PlanView): string {
	const total = view.items.length;
	const completed = view.items.filter(
		(item) => item.status === "completed",
	).length;
	const inProgressCount = view.items.filter(
		(item) => item.status === "in_progress",
	).length;
	const done = completed + inProgressCount;

	if (view.items.every((item) => item.status === "completed")) {
		return `[${total}/${total}] All steps completed`;
	}

	const inProgress = view.items.find((item) => item.status === "in_progress");
	if (inProgress) {
		const label = inProgress.activeForm?.trim() || inProgress.step;
		return `[${done}/${total}] ${label}`;
	}

	return `[${completed}/${total}]`;
}

interface ParsedPlanArgs {
	explanation?: unknown;
	plan?: unknown;
}

/**
 * Build a PlanView from raw tool arguments. Returns null when there is no
 * usable plan, so callers can treat "no plan" and "empty plan" uniformly.
 */
export function parsePlanArgs(
	args: ParsedPlanArgs | null | undefined,
): PlanView | null {
	if (!args || !Array.isArray(args.plan)) {
		return null;
	}

	const items: PlanItem[] = [];
	for (const raw of args.plan) {
		if (
			typeof raw !== "object" ||
			raw === null ||
			typeof (raw as { step?: unknown }).step !== "string" ||
			typeof (raw as { status?: unknown }).status !== "string"
		) {
			continue;
		}
		const item = raw as { step: string; status: string; activeForm?: unknown };
		const status = item.status;
		if (
			status !== "pending" &&
			status !== "in_progress" &&
			status !== "completed"
		) {
			continue;
		}
		items.push({
			step: item.step,
			status,
			...(typeof item.activeForm === "string" && item.activeForm.trim()
				? { activeForm: item.activeForm.trim() }
				: {}),
		});
	}

	if (items.length === 0) {
		return null;
	}

	return {
		explanation:
			typeof args.explanation === "string" && args.explanation.trim()
				? args.explanation.trim()
				: null,
		items,
		updatedAt: new Date().toISOString(),
	};
}

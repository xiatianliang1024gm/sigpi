export type PlanStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
	step: string;
	status: PlanStatus;
	activeForm?: string;
}

export interface PlanView {
	explanation: string | null;
	items: PlanItem[];
	updatedAt: string | null;
}

let currentPlan: PlanView | null = null;

export function setCurrentPlan(plan: PlanView | null): void {
	currentPlan = plan;
}

export function getCurrentPlan(): PlanView | null {
	return currentPlan;
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
 * Compact, glanceable summary for the persistent TUI status bar, e.g.
 * "📋 2/5 ✅✅🔄⬜⬜ 🔄 Running the test suite".
 */
export function formatPlanProgressSummary(view: PlanView): string {
	const total = view.items.length;
	const done = view.items.filter((item) => item.status === "completed").length;
	const glyphs = view.items
		.map((item) => formatPlanStatusGlyph(item.status))
		.join("");
	const inProgress = view.items.find((item) => item.status === "in_progress");
	const parts = [`📋 ${done}/${total}`];
	if (glyphs) {
		parts.push(glyphs);
	}
	if (inProgress) {
		const label = inProgress.activeForm?.trim() || inProgress.step;
		parts.push(`🔄 ${label}`);
	}
	return parts.join(" ");
}

/**
 * Full numbered checklist, used as a banner in the non-TUI CLI.
 */
export function renderPlanFull(view: PlanView): string {
	const lines: string[] = [];
	if (view.explanation) {
		lines.push(`Note: ${view.explanation}`);
	}
	lines.push("Plan:");
	view.items.forEach((item, index) => {
		const glyph = formatPlanStatusGlyph(item.status);
		const label =
			item.status === "in_progress" && item.activeForm?.trim()
				? item.activeForm.trim()
				: item.step;
		lines.push(`${index + 1}. ${glyph} ${label}`);
	});
	return lines.join("\n");
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

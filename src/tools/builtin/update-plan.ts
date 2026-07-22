import { z } from "zod";
import { formatPlanStatusGlyph } from "../../plan-tracker.js";
import { compactWhitespace, getString, truncate } from "../../progress.js";
import type { ToolDefinition } from "../../types.js";
import { joinRenderedSections, withRendered } from "../render.js";

const planItemSchema = z.object({
	step: z.string().min(1).max(120),
	status: z.enum(["pending", "in_progress", "completed"]),
	activeForm: z.string().max(120).optional(),
});

const updatePlanSchema = z.object({
	explanation: z.string().min(1).max(1_000).optional(),
	plan: z.array(planItemSchema).min(1).max(12),
});

type UpdatePlanArgs = z.infer<typeof updatePlanSchema>;

export interface PlanState {
	explanation: string | null;
	items: UpdatePlanArgs["plan"];
	updatedAt: string | null;
}

export function createUpdatePlanTool(
	state: PlanState = { explanation: null, items: [], updatedAt: null },
): ToolDefinition<UpdatePlanArgs> {
	return {
		name: "update_plan",
		description:
			"Track progress for multi-step tasks. Use it for any task with several dependent steps, ambiguity, or visible checkpoints. Call it at the start with the full ordered list of steps, keep exactly one step in_progress while work remains, and update it as you finish each step. Provide an activeForm (present-continuous phrase, e.g. 'Running the test suite') for the in_progress step so progress is clear at a glance. Keep steps short and actionable.",
		inputSchema: updatePlanSchema,
		parameters: {
			type: "object",
			properties: {
				explanation: {
					type: "string",
					description:
						"Optional brief reason for creating or changing the plan.",
				},
				plan: {
					type: "array",
					description:
						"Ordered plan items. Use one in_progress item while work remains; all completed when finished.",
					items: {
						type: "object",
						properties: {
							step: {
								type: "string",
								description: "Short actionable step description.",
							},
							status: {
								type: "string",
								enum: ["pending", "in_progress", "completed"],
							},
							activeForm: {
								type: "string",
								description:
									"Optional present-continuous phrase for an in_progress step, shown in the progress display (e.g. 'Running the test suite').",
							},
						},
						required: ["step", "status"],
						additionalProperties: false,
					},
				},
			},
			required: ["plan"],
			additionalProperties: false,
		},
		execute: ({ explanation, plan }) => {
			state.explanation = explanation ?? null;
			state.items = plan.map((item) => ({ ...item }));
			state.updatedAt = new Date().toISOString();

			return withRendered(
				{
					explanation: state.explanation,
					updatedAt: state.updatedAt,
					plan: state.items,
				},
				"ok",
			);
		},
		describeProgress(args) {
			return { summary: "plan", detail: renderPlanProgress(args) };
		},
	};
}

export const updatePlanTool: ToolDefinition<UpdatePlanArgs> =
	createUpdatePlanTool();

function isPlanItem(
	value: unknown,
): value is { step: string; status: string; activeForm?: unknown } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { step?: unknown }).step === "string" &&
		typeof (value as { status?: unknown }).status === "string"
	);
}

function renderPlanProgress(
	value: Record<string, unknown>,
): string | undefined {
	const plan = Array.isArray(value.plan) ? value.plan : [];
	if (plan.length === 0) {
		return undefined;
	}
	const explanation = getString(value.explanation);
	const lines = explanation
		? [truncate(compactWhitespace(explanation), 160)]
		: [];
	for (const [index, item] of plan.entries()) {
		if (!isPlanItem(item)) {
			continue;
		}
		const label =
			item.status === "in_progress" &&
			typeof item.activeForm === "string" &&
			item.activeForm.trim()
				? item.activeForm.trim()
				: item.step;
		lines.push(
			`${index + 1}. ${formatPlanStatusGlyph(item.status)} ${truncate(
				compactWhitespace(label),
				120,
			)}`,
		);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function _renderPlan(state: PlanState): string {
	return joinRenderedSections([
		state.explanation ? `Note: ${state.explanation}` : null,
		"Plan:",
		...state.items.map((item, index) => {
			const label =
				item.status === "in_progress" && item.activeForm?.trim()
					? item.activeForm.trim()
					: item.step;
			return `${index + 1}. ${formatPlanStatusGlyph(item.status)} ${label}`;
		}),
	]);
}

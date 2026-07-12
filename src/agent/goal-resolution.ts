import type { Message } from "../types.js";

/**
 * Goal resolution — inferring the user's current goal from the conversation
 * state (summary, exploration findings, and recent messages) and collapsing
 * continuation inputs ("continue", "继续", …) back onto the previous real goal.
 *
 * This is a deep, stateless module: its interface is the set of exported
 * functions, and it depends only on explicit inputs, never on
 * {@link ConversationContext}.
 */

const CONTINUATION_INPUTS = new Set([
	"continue",
	"继续",
	"继续吧",
	"接着",
	"接着做",
	"go on",
	"keep going",
	"resume",
]);

export interface GoalResolutionInputs {
	summary: string | null;
	keyFindings: readonly string[] | undefined;
	recentMessages: readonly Message[];
}

/** Whether the user input is a bare continuation rather than a new goal. */
export function isContinuationInput(input: string): boolean {
	return CONTINUATION_INPUTS.has(
		input.replace(/\s+/g, " ").trim().toLowerCase(),
	);
}

/** Pull the `## Goal` line out of a compacted summary, if present. */
export function extractGoalFromSummary(summary: string | null): string | null {
	if (!summary) {
		return null;
	}

	const goalMatch = summary.match(
		/## Goal\s*\n(?<goal>[\s\S]*?)(?:\n## |\n### |$)/i,
	);
	const goal = goalMatch?.groups?.goal
		?.split("\n")
		.map((line) => line.replace(/^[-*\d.\s[\]x]+/i, "").trim())
		.filter(Boolean)
		.join(" ")
		.trim();

	return goal || null;
}

/** The most recent non-continuation user message, if any. */
export function findPreviousUserGoal(
	messages: readonly Message[],
): string | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") {
			continue;
		}
		const content = message.content.trim();
		if (!content || isContinuationInput(content)) {
			continue;
		}
		return content;
	}

	return null;
}

/** The first non-empty finding from the exploration ledger, if any. */
export function extractFirstFinding(
	findings: readonly string[] | undefined,
): string | null {
	if (!findings || findings.length === 0) {
		return null;
	}
	for (const finding of findings) {
		const trimmed = finding?.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	return null;
}

/** Ordered candidate goals: summary goal, then ledger finding, then previous user goal. */
export function collectGoalCandidates(inputs: GoalResolutionInputs): string[] {
	const candidates: string[] = [];
	const summaryGoal = extractGoalFromSummary(inputs.summary);
	if (summaryGoal) candidates.push(summaryGoal);
	const ledgerGoal = extractFirstFinding(inputs.keyFindings);
	if (ledgerGoal) candidates.push(ledgerGoal);
	const previousGoal = findPreviousUserGoal(inputs.recentMessages);
	if (previousGoal) candidates.push(previousGoal);
	return candidates;
}

/**
 * Resolve the current user goal for this turn.
 *
 * A non-continuation input is its own goal. A continuation input resolves to
 * the first candidate goal that differs from it and isn't itself a
 * continuation; if none qualifies, it falls back to the trimmed input (or the
 * first available candidate).
 */
export function resolveCurrentGoal(
	userInput: string,
	inputs: GoalResolutionInputs,
): string {
	if (!isContinuationInput(userInput)) {
		return userInput;
	}

	const candidates = collectGoalCandidates(inputs);
	const trimmedInput = userInput.trim();
	for (const candidate of candidates) {
		if (!candidate) continue;
		if (candidate.trim() === trimmedInput) continue;
		if (isContinuationInput(candidate)) continue;
		return candidate;
	}

	return trimmedInput || candidates.find((c) => c) || userInput;
}

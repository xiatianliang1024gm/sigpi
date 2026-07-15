import type { ChatReplState } from "./chat-repl.js";
import {
	estimateContextTokens,
	estimateSystemPromptSections,
	groupToolSchemas,
	summarizeRecentMessagesByRole,
} from "./context-window.js";

export function formatContextWindowSummary(state: ChatReplState): string {
	const recentMessages = state.runtime.context.getRecentMessages();
	const systemPromptSections = estimateSystemPromptSections(
		state.runtime.systemPromptSections,
	);
	const toolGroups = groupToolSchemas(state.runtime.toolSchemas);
	const summary = state.runtime.context.getSummary();
	const recentStats = summarizeRecentMessagesByRole(recentMessages);
	const lastUsage = state.runtime.context.getLastUsage();
	const tokens = estimateContextTokens({
		systemPrompt: state.runtime.systemPromptSections
			.map((section) => section.content)
			.join(" "),
		summary,
		recentMessages,
		toolSchemas: state.runtime.toolSchemas,
		lastUsage: lastUsage?.usage ?? null,
		lastUsageMessageIndex: lastUsage?.messageIndex ?? null,
	});
	const usedTokens = tokens.totalTokens;
	const budget = state.runtime.context.getContextBudget();
	const thresholdTokens = budget.hardContextLimit - budget.reserveTokens;
	const remainingTokens = thresholdTokens - usedTokens;

	return [
		`Context window: ${usedTokens}/${thresholdTokens} tokens used (${formatPercent(usedTokens, thresholdTokens)}). Remaining: ${formatSignedTokens(remainingTokens)}.`,
		`Reserve tokens: ${budget.reserveTokens}. Trigger threshold: ${thresholdTokens} tokens (= hard_context_limit - reserve_tokens).`,
		`System prompt: ${tokens.systemPromptTokens} tokens (${formatPercent(tokens.systemPromptTokens, usedTokens)} of total).`,
		...systemPromptSections.map(
			(section) => `  - ${section.label}: ${section.tokens} tokens.`,
		),
		`Tool definitions: ${tokens.toolSchemaTokens} tokens across ${state.runtime.toolSchemas.length} tool(s) (${formatPercent(tokens.toolSchemaTokens, usedTokens)} of total).`,
		...toolGroups.map(
			(group) =>
				`  - ${group.label}: ${group.count} tool(s), ${group.tokens} tokens.`,
		),
		`Summary memory: ${tokens.summaryTokens} tokens sent, raw length ${summary?.length ?? 0} (${formatPercent(tokens.summaryTokens, usedTokens)} of total).`,
		`Recent uncompressed messages: ${recentStats.totalTokens} tokens across ${recentStats.totalCount} message(s) (${formatPercent(recentStats.totalTokens, usedTokens)} of total).`,
		...recentStats.byRole.map(
			(role) =>
				`  - ${role.role}: ${role.count} message(s), ${role.tokens} tokens.`,
		),
		`Loaded skills: ${state.loadedSkillNames.length > 0 ? state.loadedSkillNames.join(", ") : "(none)"}.`,
	].join("\n");
}

function formatPercent(value: number, total: number): string {
	if (total <= 0) {
		return "0.0%";
	}
	return `${((value / total) * 100).toFixed(1)}%`;
}

function formatSignedTokens(value: number): string {
	return `${value >= 0 ? value : `-${Math.abs(value)}`} tokens`;
}

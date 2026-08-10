import { estimateMessageChars } from "./agent/messages.js";
import type { Message, ModelUsage, ToolSchema } from "./types.js";

const SUMMARY_TOKEN_PREFIX = "Conversation summary from earlier turns:\n";

/**
 * Conservative token estimate using the `chars / 4` heuristic.
 * Overestimates for CJK content and underestimates for code-heavy payloads;
 * the bias is acceptable because compact is an upper-bound safety check, not
 * a precise budget counter.
 */
export function estimateMessageTokens(
	message:
		| Message
		| {
				role: Message["role"];
				content: string | null;
				toolCalls?: Array<{ rawArguments: string }>;
		  },
): number {
	const chars = estimateMessageChars(
		message as unknown as Parameters<typeof estimateMessageChars>[0],
	);
	return Math.ceil(chars / 4);
}

export function estimateRecentMessagesTokens(
	messages: readonly Message[],
): number {
	return messages.reduce(
		(total, message) => total + estimateMessageTokens(message),
		0,
	);
}

export function estimateToolSchemaTokens(
	schemas: readonly ToolSchema[],
): number {
	return schemas.reduce(
		(total, schema) => total + Math.ceil(JSON.stringify(schema).length / 4),
		0,
	);
}

function estimateSystemPromptTokens(systemPrompt: string): number {
	return Math.ceil(
		estimateMessageChars({ role: "system", content: systemPrompt }) / 4,
	);
}

function estimateSummaryTokens(summary: string): number {
	return estimateSystemPromptTokens(`${SUMMARY_TOKEN_PREFIX}${summary}`);
}

/**
 * Estimate total context tokens for a request.
 *
 * Prefers the provider-reported `lastUsage` as ground truth: when `lastUsage`
 * and `lastUsageMessageIndex` are both supplied (and the index is valid), the
 * total is `lastUsage.totalTokens` — which already covers the system prompt,
 * summary, tool schemas and every message up to and including
 * `lastUsageMessageIndex` — plus the chars/4 cost of messages appended after
 * that index and any pending user input.
 *
 * Only when no usable `lastUsage` exists does it fall back to a full
 * chars/4 estimate over system prompt + summary + recent messages + tool
 * schemas + pending input.
 */
export function estimateContextTokens(args: {
	systemPrompt: string;
	summary: string | null;
	recentMessages: readonly Message[];
	toolSchemas: readonly ToolSchema[];
	pendingUserInput?: string;
	lastUsage?: ModelUsage | null;
	lastUsageMessageIndex?: number | null;
}): { totalTokens: number; usedUsage: boolean } {
	if (
		args.lastUsage &&
		typeof args.lastUsageMessageIndex === "number" &&
		args.lastUsageMessageIndex >= 0 &&
		args.lastUsageMessageIndex < args.recentMessages.length
	) {
		// The provider's totalTokens already accounted for system prompt,
		// summary, messages up to and including `lastUsageMessageIndex`,
		// and tool schemas. Only messages appended after that index plus
		// any pending user input need estimating.
		let trailingTokens = 0;
		for (
			let i = args.lastUsageMessageIndex + 1;
			i < args.recentMessages.length;
			i += 1
		) {
			trailingTokens += estimateMessageTokens(args.recentMessages[i]);
		}

		return {
			totalTokens:
				args.lastUsage.totalTokens +
				trailingTokens +
				(args.pendingUserInput
					? estimateMessageTokens({
							role: "user",
							content: args.pendingUserInput,
						})
					: 0),
			usedUsage: true,
		};
	}

	return {
		totalTokens:
			estimateSystemPromptTokens(args.systemPrompt) +
			(args.summary ? estimateSummaryTokens(args.summary) : 0) +
			estimateRecentMessagesTokens(args.recentMessages) +
			estimateToolSchemaTokens(args.toolSchemas) +
			(args.pendingUserInput
				? estimateMessageTokens({
						role: "user",
						content: args.pendingUserInput,
					})
				: 0),
		usedUsage: false,
	};
}

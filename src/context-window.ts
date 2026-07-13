import { estimateMessageChars } from "./agent/messages.js";
import type {
	Message,
	ModelUsage,
	SystemPromptSection,
	ToolSchema,
} from "./types.js";

export const SUMMARY_PREFIX = "Conversation summary from earlier turns:\n";
export const SUMMARY_TOKEN_PREFIX = SUMMARY_PREFIX;
const MESSAGE_ROLE_ORDER: Message["role"][] = [
	"system",
	"user",
	"assistant",
	"tool",
];

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
	return groupToolSchemas(schemas).reduce(
		(total, group) => total + group.tokens,
		0,
	);
}

export function estimateSystemPromptTokens(systemPrompt: string): number {
	return Math.ceil(
		estimateMessageChars({ role: "system", content: systemPrompt }) / 4,
	);
}

export function estimateSummaryTokens(summary: string): number {
	return estimateSystemPromptTokens(`${SUMMARY_TOKEN_PREFIX}${summary}`);
}

/**
 * Estimate total context tokens for a request.
 *
 * When `lastUsage` and `lastUsageMessageIndex` are both supplied, the function
 * uses the provider-reported `totalTokens` as the ground-truth context size
 * for the conversation up to (and including) the message at
 * `lastUsageMessageIndex`, then adds the cost of any messages appended after
 * that index via `estimateMessageTokens`. This mirrors the way the OpenAI /
 * Responses API `usage.total_tokens` reflects the entire request payload.
 *
 * When `lastUsage` is missing, falls back to a full `chars / 4` estimate over
 * system prompt + summary + recent messages + tool schemas + pending input.
 */
export function estimateContextTokens(args: {
	systemPrompt: string;
	summary: string | null;
	recentMessages: readonly Message[];
	toolSchemas: readonly ToolSchema[];
	pendingUserInput?: string;
	lastUsage?: ModelUsage | null;
	lastUsageMessageIndex?: number | null;
}): {
	totalTokens: number;
	systemPromptTokens: number;
	summaryTokens: number;
	recentMessageTokens: number;
	toolSchemaTokens: number;
	pendingUserInputTokens: number;
	usedUsage: boolean;
} {
	const systemPromptTokens = estimateSystemPromptTokens(args.systemPrompt);
	const summaryTokens = args.summary ? estimateSummaryTokens(args.summary) : 0;
	const recentMessageTokens = estimateRecentMessagesTokens(args.recentMessages);
	const toolSchemaTokens = estimateToolSchemaTokens(args.toolSchemas);
	const pendingUserInputTokens = args.pendingUserInput
		? estimateMessageTokens({ role: "user", content: args.pendingUserInput })
		: 0;

	if (
		args.lastUsage &&
		typeof args.lastUsageMessageIndex === "number" &&
		args.lastUsageMessageIndex >= 0 &&
		args.lastUsageMessageIndex < args.recentMessages.length
	) {
		// The provider's totalTokens already accounted for system prompt,
		// summary, messages up to and including `lastUsageMessageIndex`,
		// and tool schemas. We only need to add tokens for messages appended
		// after that index plus any pending user input.
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
				args.lastUsage.totalTokens + trailingTokens + pendingUserInputTokens,
			systemPromptTokens,
			summaryTokens,
			recentMessageTokens,
			toolSchemaTokens,
			pendingUserInputTokens,
			usedUsage: true,
		};
	}

	return {
		totalTokens:
			systemPromptTokens +
			summaryTokens +
			recentMessageTokens +
			toolSchemaTokens +
			pendingUserInputTokens,
		systemPromptTokens,
		summaryTokens,
		recentMessageTokens,
		toolSchemaTokens,
		pendingUserInputTokens,
		usedUsage: false,
	};
}

export function estimateSystemPromptSections(
	sections: readonly SystemPromptSection[],
): Array<{ label: string; chars: number; tokens: number }> {
	return sections.map((section, index) => {
		const chars =
			section.content.length + (index < sections.length - 1 ? 1 : 0);
		return {
			label: section.label,
			chars,
			tokens: Math.ceil(chars / 4),
		};
	});
}

export function groupToolSchemas(
	schemas: readonly ToolSchema[],
): Array<{ label: string; count: number; chars: number; tokens: number }> {
	const groups = new Map<
		string,
		{ label: string; count: number; chars: number; tokens: number }
	>([["built_in", { label: "Built-in tools", count: 0, chars: 0, tokens: 0 }]]);

	for (const schema of schemas) {
		const group = groups.get("built_in");
		if (!group) {
			continue;
		}
		const chars = JSON.stringify(schema).length;
		group.count += 1;
		group.chars += chars;
		group.tokens += Math.ceil(chars / 4);
	}

	return [...groups.values()].filter((group) => group.count > 0);
}

export function summarizeRecentMessagesByRole(messages: readonly Message[]): {
	totalChars: number;
	totalTokens: number;
	totalCount: number;
	byRole: Array<{
		role: Message["role"];
		count: number;
		chars: number;
		tokens: number;
	}>;
} {
	const byRole = new Map<
		Message["role"],
		{
			role: Message["role"];
			count: number;
			chars: number;
			tokens: number;
		}
	>();
	let totalChars = 0;
	let totalTokens = 0;

	for (const message of messages) {
		const chars = estimateMessageChars(message);
		const tokens = Math.ceil(chars / 4);
		totalChars += chars;
		totalTokens += tokens;
		const current = byRole.get(message.role) ?? {
			role: message.role,
			count: 0,
			chars: 0,
			tokens: 0,
		};
		current.count += 1;
		current.chars += chars;
		current.tokens += tokens;
		byRole.set(message.role, current);
	}

	return {
		totalChars,
		totalTokens,
		totalCount: messages.length,
		byRole: MESSAGE_ROLE_ORDER.map((role) => byRole.get(role)).filter(
			(role): role is NonNullable<typeof role> => role !== undefined,
		),
	};
}

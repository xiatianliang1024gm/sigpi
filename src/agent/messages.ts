import { randomUUID } from "node:crypto";
import { formatToolExecutionResult } from "../tools/render.js";
import type {
	AssistantMessage,
	JsonValue,
	Message,
	SystemMessage,
	ToolCall,
	ToolExecutionResult,
	ToolMessage,
	UserMessage,
} from "../types.js";

const SUMMARY_TOOL_CONTENT_MAX_CHARS = 2_000;
const TOOL_MESSAGE_CONTENT_MAX_CHARS = 65_536;
const TOOL_MESSAGE_HEAD_CHARS = 20_000;
const TOOL_MESSAGE_TAIL_CHARS = 20_000;

export function createSystemMessage(content: string): SystemMessage {
	return { role: "system", content };
}

export function createUserMessage(
	content: string,
	options: { id?: string } = {},
): UserMessage {
	return { role: "user", content, id: options.id ?? randomUUID() };
}

export function createAssistantMessage(
	content: string | null,
	toolCalls?: ToolCall[],
	options: { id?: string } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		toolCalls,
		id: options.id ?? randomUUID(),
	};
}

export function createToolMessage(
	toolCallId: string,
	name: string,
	result: ToolExecutionResult,
	options: { id?: string } = {},
): ToolMessage {
	return {
		role: "tool",
		name,
		toolCallId,
		content: truncateToolMessageContent(
			formatToolExecutionResult(name, result),
			TOOL_MESSAGE_CONTENT_MAX_CHARS,
		),
		id: options.id ?? randomUUID(),
	};
}

/**
 * Loose shape that the char / token estimators accept. Real messages always
 * have an `id` (except system messages, which are never persisted), but the
 * estimators only care about content shape, so call sites that synthesize a
 * placeholder for "the next pending user input" or a synthetic system
 * message don't need to mint an id.
 */
export type MessageCharEstimateInput = {
	role: Message["role"];
	content: string | null;
	toolCalls?: ToolCall[];
	name?: string;
	toolCallId?: string;
};

export function estimateMessageChars(
	message: MessageCharEstimateInput,
): number {
	const shared = (message.content?.length ?? 0) + 16;

	if (message.role === "assistant" && message.toolCalls?.length) {
		return shared + JSON.stringify(message.toolCalls).length;
	}

	if (message.role === "tool") {
		return (
			shared + (message.name?.length ?? 0) + (message.toolCallId?.length ?? 0)
		);
	}

	return shared;
}

export function renderMessagesForSummary(messages: Message[]): string {
	return messages
		.map((message) => {
			if (message.role === "assistant" && message.toolCalls?.length) {
				const calls = message.toolCalls
					.map((toolCall) => `${toolCall.name}(${toolCall.rawArguments})`)
					.join(", ");
				return `[assistant] tool_calls=${calls}`;
			}

			if (message.role === "tool") {
				return `[tool:${message.name}] ${truncateForSummary(message.content, SUMMARY_TOOL_CONTENT_MAX_CHARS)}`;
			}

			return `[${message.role}] ${message.content}`;
		})
		.join("\n");
}

function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}

	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

function truncateToolMessageContent(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}

	const headChars = Math.min(TOOL_MESSAGE_HEAD_CHARS, Math.floor(maxChars / 2));
	const tailChars = Math.min(TOOL_MESSAGE_TAIL_CHARS, maxChars - headChars);
	const omittedChars = text.length - headChars - tailChars;
	const marker = `\n\n[tool result truncated: ${omittedChars} characters omitted; showing first ${headChars} and last ${tailChars} characters]\n\n`;
	return `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`;
}

export function safeJsonValue(input: unknown): JsonValue {
	try {
		return JSON.parse(JSON.stringify(input)) as JsonValue;
	} catch {
		return String(input);
	}
}

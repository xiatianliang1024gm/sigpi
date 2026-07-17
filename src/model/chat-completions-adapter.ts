import type { ModelConfig } from "../config.js";
import type {
	Message,
	ModelDelta,
	ModelRequest,
	ModelResponse,
	ModelUsage,
	ToolCall,
} from "../types.js";
import { stripThinking, ThinkingSplitter } from "./thinking.js";
import { ModelRequestError } from "./transport.js";
import { isPlainObject, readFiniteNumber, safeParseArguments } from "./util.js";
import type { WireFormatAdapter } from "./wire-format.js";

interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | null;
	name?: string;
	tool_call_id?: string;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: {
			name: string;
			arguments: string;
		};
	}>;
}

interface ParsedResponse {
	choices: Array<{
		finish_reason?: string | null;
		message: OpenAIMessage;
	}>;
	usage?: {
		prompt_tokens?: number | null;
		completion_tokens?: number | null;
		total_tokens?: number | null;
		prompt_tokens_details?: {
			cached_tokens?: number | null;
		} | null;
	};
}

interface ChatCompletionsChunk {
	choices?: Array<{
		index?: number;
		delta?: {
			role?: string;
			content?: string;
			/** Provider extension (DeepSeek / OpenAI reasoning) for chain-of-thought. */
			reasoning_content?: string;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: ParsedResponse["usage"];
}

/** Wire-format adapter for the OpenAI `chat/completions` API. */
export class ChatCompletionsAdapter implements WireFormatAdapter {
	private accumulated: ParsedResponse | null = null;
	// Extracts thinking wrapped in tags (<mm:think>, <think>, <reasoning>) from
	// streamed `content` so it is shown as a separate reasoning preview and kept
	// out of the final answer (some providers do not use `reasoning_content`).
	private thinking = new ThinkingSplitter();

	constructor(private readonly config: ModelConfig) {}

	toParams(request: ModelRequest): Record<string, unknown> {
		return {
			model: this.config.name,
			messages: request.messages.map((message) => this.toApiMessage(message)),
			tools: request.tools.length > 0 ? request.tools : undefined,
			temperature: request.temperature,
			max_tokens: request.maxTokens,
			...(this.config.stream ? { stream: true } : {}),
		};
	}

	parse(data: unknown): ModelResponse {
		const parsed = validateChatCompletionsResponse(data);
		return this.convert(parsed);
	}

	private convert(parsed: ParsedResponse): ModelResponse {
		const choice = parsed.choices[0];
		const message = choice.message;
		const assistantText = stripThinking(message.content ?? null);
		const toolCalls = this.parseChatCompletionsToolCalls(message.tool_calls);

		return {
			assistantText,
			toolCalls,
			finishReason: choice.finish_reason ?? null,
			usage: parseChatCompletionsUsage(parsed.usage),
			rawResponse: parsed,
		};
	}

	accumulate(frame: unknown): void {
		if (!isPlainObject(frame)) {
			throw new ModelRequestError(
				"SSE frame was not a JSON object.",
				"stream_error",
				{},
			);
		}
		const frameObj = frame as Record<string, unknown>;
		if (isPlainObject(frameObj.error)) {
			throw new ModelRequestError(
				`Chat completions SSE error: ${JSON.stringify(frameObj.error)}`,
				"stream_error",
				{},
			);
		}

		const chunk = frame as ChatCompletionsChunk;
		if (!this.accumulated) {
			this.accumulated = { choices: [], usage: undefined };
			// Fresh stream: clear any stale thinking-tag parsing state.
			this.thinking = new ThinkingSplitter();
		}
		this.foldChunk(this.accumulated, chunk);
	}

	finalize(): ModelResponse {
		if (!this.accumulated) {
			throw new ModelRequestError(
				"No streamed data was accumulated before the stream ended.",
				"stream_error",
				{},
			);
		}
		return this.convert(validateChatCompletionsResponse(this.accumulated));
	}

	isComplete(): boolean {
		return this.accumulated?.choices[0]?.finish_reason != null;
	}

	onDelta(frame: unknown): ModelDelta | null {
		if (!isPlainObject(frame)) {
			return null;
		}
		const chunk = frame as ChatCompletionsChunk;
		const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
		let delta: ModelDelta | null = null;
		for (const chunkChoice of choices) {
			if (!isPlainObject(chunkChoice)) {
				continue;
			}
			const choiceDelta = isPlainObject(chunkChoice.delta)
				? (chunkChoice.delta as Record<string, unknown>)
				: undefined;
			if (!choiceDelta) {
				continue;
			}
			if (typeof choiceDelta.reasoning_content === "string") {
				delta = delta ?? {};
				delta.reasoningDelta =
					(delta.reasoningDelta ?? "") + choiceDelta.reasoning_content;
			}
			if (typeof choiceDelta.content === "string") {
				const { reasoning, content } = this.thinking.push(choiceDelta.content);
				delta = delta ?? {};
				if (content) {
					delta.contentDelta = (delta.contentDelta ?? "") + content;
				}
				if (reasoning) {
					delta.reasoningDelta = (delta.reasoningDelta ?? "") + reasoning;
				}
			}
			if (Array.isArray(choiceDelta.tool_calls)) {
				for (const tc of choiceDelta.tool_calls) {
					if (!isPlainObject(tc)) {
						continue;
					}
					const index = typeof tc.index === "number" ? tc.index : 0;
					const fn = isPlainObject(tc.function)
						? (tc.function as Record<string, unknown>)
						: undefined;
					const argumentsDelta =
						fn && typeof fn.arguments === "string" ? fn.arguments : undefined;
					if (
						typeof tc.id === "string" ||
						typeof fn?.name === "string" ||
						typeof argumentsDelta === "string"
					) {
						delta = delta ?? {};
						delta.toolCallDelta = {
							index,
							...(typeof tc.id === "string" ? { id: tc.id } : {}),
							...(typeof fn?.name === "string" ? { name: fn.name } : {}),
							...(typeof argumentsDelta === "string" ? { argumentsDelta } : {}),
						};
					}
				}
			}
			if (typeof chunkChoice.finish_reason === "string") {
				delta = delta ?? {};
				delta.finishReason = chunkChoice.finish_reason;
			}
		}
		return delta;
	}

	getPartialView(): ModelResponse {
		if (!this.accumulated) {
			return {
				assistantText: null,
				toolCalls: [],
				finishReason: null,
				usage: undefined,
				rawResponse: undefined,
			};
		}
		return this.convert(validateChatCompletionsResponse(this.accumulated));
	}

	private toApiMessage(message: Message): OpenAIMessage {
		if (message.role === "tool") {
			return {
				role: "tool",
				content: message.content,
				name: message.name,
				tool_call_id: message.toolCallId,
			};
		}

		if (message.role === "assistant" && message.toolCalls?.length) {
			return {
				role: "assistant",
				content: message.content,
				tool_calls: message.toolCalls.map((toolCall) => ({
					id: toolCall.id,
					type: "function",
					function: {
						name: toolCall.name,
						arguments: toolCall.rawArguments,
					},
				})),
			};
		}

		return {
			role: message.role,
			content: message.content,
		};
	}

	private parseChatCompletionsToolCalls(
		rawToolCalls: OpenAIMessage["tool_calls"],
	): ToolCall[] {
		if (rawToolCalls === undefined) {
			return [];
		}

		if (!Array.isArray(rawToolCalls)) {
			throw new ModelRequestError(
				"Model response has invalid tool_calls: expected an array.",
				"invalid_response",
				{
					responseField: "choices[0].message.tool_calls",
				},
			);
		}

		return rawToolCalls.map<ToolCall>((toolCall, index) => {
			if (
				!toolCall ||
				typeof toolCall !== "object" ||
				typeof toolCall.id !== "string" ||
				toolCall.type !== "function" ||
				!toolCall.function ||
				typeof toolCall.function.name !== "string" ||
				typeof toolCall.function.arguments !== "string"
			) {
				throw new ModelRequestError(
					`Model response has invalid tool_calls[${index}] structure.`,
					"invalid_response",
					{
						responseField: `choices[0].message.tool_calls[${index}]`,
					},
				);
			}

			return {
				id: toolCall.id,
				name: toolCall.function.name,
				rawArguments: toolCall.function.arguments,
				...safeParseArguments(toolCall.function.arguments),
			};
		});
	}

	private foldChunk(state: ParsedResponse, chunk: ChatCompletionsChunk): void {
		const choices = chunk.choices;
		if (!Array.isArray(choices)) {
			return;
		}
		for (const chunkChoice of choices) {
			if (!isPlainObject(chunkChoice)) {
				continue;
			}
			const index =
				typeof chunkChoice.index === "number" ? chunkChoice.index : 0;
			let target = state.choices[index];
			if (!target) {
				target = { message: { role: "assistant", content: null } };
				state.choices[index] = target;
			}
			const delta = chunkChoice.delta;
			if (isPlainObject(delta)) {
				if (typeof delta.content === "string") {
					target.message.content =
						(target.message.content ?? "") + delta.content;
				}
				if (Array.isArray(delta.tool_calls)) {
					for (const tc of delta.tool_calls) {
						if (isPlainObject(tc)) {
							this.foldToolCallDelta(target.message, tc);
						}
					}
				}
			}
			if (typeof chunkChoice.finish_reason === "string") {
				target.finish_reason = chunkChoice.finish_reason;
			}
		}
		if (isPlainObject(chunk.usage)) {
			state.usage = chunk.usage;
		}
	}

	private foldToolCallDelta(
		message: OpenAIMessage,
		tc: Record<string, unknown>,
	): void {
		const idx =
			typeof tc.index === "number"
				? tc.index
				: (message.tool_calls?.length ?? 0);
		if (!Array.isArray(message.tool_calls)) {
			message.tool_calls = [];
		}
		let entry = message.tool_calls[idx];
		if (!entry) {
			entry = {
				id: "",
				type: "function",
				function: { name: "", arguments: "" },
			};
			message.tool_calls[idx] = entry;
		}
		if (typeof tc.id === "string") {
			entry.id = tc.id;
		}
		const fn = isPlainObject(tc.function)
			? (tc.function as Record<string, unknown>)
			: undefined;
		if (fn) {
			if (typeof fn.name === "string") {
				entry.function.name += fn.name;
			}
			if (typeof fn.arguments === "string") {
				entry.function.arguments += fn.arguments;
			}
		}
	}
}

function validateChatCompletionsResponse(value: unknown): ParsedResponse {
	if (!isPlainObject(value)) {
		throw new ModelRequestError(
			"Model response is not a JSON object.",
			"invalid_response",
		);
	}

	if (!Array.isArray(value.choices)) {
		throw new ModelRequestError(
			"Model response missing choices array.",
			"invalid_response",
			{
				responseField: "choices",
			},
		);
	}

	if (value.choices.length === 0) {
		throw new ModelRequestError(
			"Model response choices array is empty.",
			"invalid_response",
			{
				responseField: "choices",
			},
		);
	}

	const choice = value.choices[0];
	if (!isPlainObject(choice) || !isPlainObject(choice.message)) {
		throw new ModelRequestError(
			"Model response missing choices[0].message.",
			"invalid_response",
			{
				responseField: "choices[0].message",
			},
		);
	}

	if (
		choice.message.content !== undefined &&
		choice.message.content !== null &&
		typeof choice.message.content !== "string"
	) {
		throw new ModelRequestError(
			"Model response has invalid choices[0].message.content.",
			"invalid_response",
			{
				responseField: "choices[0].message.content",
			},
		);
	}

	choice.message.content ??= null;

	return value as unknown as ParsedResponse;
}

function parseChatCompletionsUsage(raw: unknown): ModelUsage | undefined {
	if (!isPlainObject(raw)) {
		return undefined;
	}

	const input = readFiniteNumber(raw.prompt_tokens);
	const output = readFiniteNumber(raw.completion_tokens);
	const total = readFiniteNumber(raw.total_tokens);
	if (input === null || output === null || total === null) {
		return undefined;
	}

	const details = isPlainObject(raw.prompt_tokens_details)
		? raw.prompt_tokens_details
		: null;
	const cacheRead = details
		? (readFiniteNumber(details.cached_tokens) ?? 0)
		: 0;

	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: total,
	};
}

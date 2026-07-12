import type { ModelConfig } from "../config.js";
import type {
	Message,
	ModelRequest,
	ModelResponse,
	ModelUsage,
	ToolCall,
	ToolSchema,
} from "../types.js";
import { ModelRequestError } from "./transport.js";
import { isPlainObject, readFiniteNumber, safeParseArguments } from "./util.js";
import type { WireFormatAdapter } from "./wire-format.js";

type ResponsesInputItem =
	| {
			type: "message";
			role: "system" | "user" | "assistant";
			content: string;
	  }
	| {
			type: "function_call";
			call_id: string;
			name: string;
			arguments: string;
	  }
	| {
			type: "function_call_output";
			call_id: string;
			output: string;
	  };

interface ResponsesFunctionTool {
	type: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** Wire-format adapter for the OpenAI `responses` API. */
export class ResponsesAdapter implements WireFormatAdapter {
	private accumulated: ValidatedResponsesResponse = { output: [] };

	constructor(private readonly config: ModelConfig) {}

	buildUrl(): string {
		const baseURL = this.config.baseURL.endsWith("/")
			? this.config.baseURL.slice(0, -1)
			: this.config.baseURL;

		if (baseURL.endsWith("/responses")) {
			return baseURL;
		}

		if (baseURL.endsWith("/v1")) {
			return `${baseURL}/responses`;
		}

		return `${baseURL}/v1/responses`;
	}

	toRequestBody(request: ModelRequest): Record<string, unknown> {
		return {
			model: this.config.name,
			input: request.messages.flatMap((message) =>
				this.toResponsesInputItems(message),
			),
			tools:
				request.tools.length > 0
					? request.tools.map((tool) => this.toResponsesTool(tool))
					: undefined,
			temperature: request.temperature,
			max_output_tokens: request.maxTokens,
			...(this.config.stream ? { stream: true } : {}),
		};
	}

	parse(data: unknown): ModelResponse {
		const parsed = validateResponsesResponse(data);
		return this.convert(parsed);
	}

	private convert(parsed: ValidatedResponsesResponse): ModelResponse {
		const toolCalls = this.parseResponsesToolCalls(parsed.output);
		return {
			assistantText: extractResponsesAssistantText(parsed),
			toolCalls,
			finishReason: mapResponsesFinishReason(parsed.status, toolCalls, parsed),
			usage: parseResponsesUsage(parsed.usage),
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
				`Responses API SSE error: ${JSON.stringify(frameObj.error)}`,
				"stream_error",
				{},
			);
		}

		const eventType = typeof frameObj.type === "string" ? frameObj.type : "";
		switch (eventType) {
			case "response.output_item.added":
			case "response.output_item.done": {
				const item = frameObj.item;
				if (
					isPlainObject(item) &&
					typeof (item as { id?: unknown }).id === "string"
				) {
					this.upsertOutputItem(item as Record<string, unknown>);
				}
				break;
			}
			case "response.output_item.delta":
			case "response.content_part.delta": {
				const itemId = frameObj.item_id;
				let textChunk: string | undefined;
				if (
					isPlainObject(frameObj.part) &&
					typeof frameObj.part.text === "string"
				) {
					textChunk = frameObj.part.text;
				} else if (isPlainObject(frameObj.delta)) {
					const d = frameObj.delta as { type?: string; text?: string };
					if (typeof d.text === "string") {
						textChunk = d.text;
					}
				}
				if (typeof itemId === "string" && typeof textChunk === "string") {
					this.appendOutputText(itemId, textChunk);
				}
				break;
			}
			case "response.output_text.delta": {
				const itemId = frameObj.item_id;
				const textChunk =
					typeof frameObj.delta === "string" ? frameObj.delta : undefined;
				if (typeof itemId === "string" && typeof textChunk === "string") {
					this.appendOutputText(itemId, textChunk);
				}
				break;
			}
			case "response.function_call_arguments.delta": {
				const itemId = frameObj.item_id;
				const raw = frameObj.delta;
				const args =
					typeof raw === "string"
						? raw
						: isPlainObject(raw) && typeof raw.arguments === "string"
							? raw.arguments
							: typeof frameObj.arguments === "string"
								? frameObj.arguments
								: undefined;
				if (typeof itemId === "string" && typeof args === "string") {
					this.appendOutputArguments(itemId, args);
				}
				break;
			}
			case "response.completed": {
				const f = frameObj;
				if (typeof f.status === "string") this.accumulated.status = f.status;
				if (isPlainObject(f.usage)) this.accumulated.usage = f.usage;
				if (typeof f.output_text === "string") {
					this.accumulated.output_text = f.output_text;
				}
				// response.completed is not the assembly source (ADR-0007): we
				// only adopt its output when our own folding produced nothing.
				if (
					Array.isArray(f.output) &&
					f.output.length > 0 &&
					this.accumulated.output.length === 0
				) {
					this.accumulated.output = f.output;
				}
				break;
			}
			default:
				break;
		}
	}

	finalize(): ModelResponse {
		if (
			this.accumulated.output.length === 0 &&
			this.accumulated.output_text === undefined &&
			this.accumulated.status === undefined
		) {
			throw new ModelRequestError(
				"No streamed data was accumulated before the stream ended.",
				"stream_error",
				{},
			);
		}
		return this.convert(validateResponsesResponse(this.accumulated));
	}

	private toResponsesInputItems(message: Message): ResponsesInputItem[] {
		if (message.role === "tool") {
			return [
				{
					type: "function_call_output",
					call_id: message.toolCallId,
					output: message.content,
				},
			];
		}

		if (message.role === "assistant" && message.toolCalls?.length) {
			const items: ResponsesInputItem[] = [];

			if (message.content) {
				items.push({
					type: "message",
					role: "assistant",
					content: message.content,
				});
			}

			for (const toolCall of message.toolCalls) {
				items.push({
					type: "function_call",
					call_id: toolCall.id,
					name: toolCall.name,
					arguments: toolCall.rawArguments,
				});
			}

			return items;
		}

		return [
			{
				type: "message",
				role: message.role,
				content: message.content ?? "",
			},
		];
	}

	private toResponsesTool(tool: ToolSchema): ResponsesFunctionTool {
		return {
			type: "function",
			name: tool.function.name,
			description: tool.function.description,
			parameters: tool.function.parameters,
		};
	}

	private parseResponsesToolCalls(output: unknown[]): ToolCall[] {
		return output.flatMap<ToolCall>((item, index) => {
			if (!isPlainObject(item) || item.type !== "function_call") {
				return [];
			}

			const id =
				typeof item.call_id === "string"
					? item.call_id
					: typeof item.id === "string"
						? item.id
						: null;

			if (
				id === null ||
				typeof item.name !== "string" ||
				typeof item.arguments !== "string"
			) {
				throw new ModelRequestError(
					`Responses API response has invalid output[${index}] function_call structure.`,
					"invalid_response",
					{
						responseField: `output[${index}]`,
					},
				);
			}

			return [
				{
					id,
					name: item.name,
					rawArguments: item.arguments,
					...safeParseArguments(item.arguments),
				},
			];
		});
	}

	private upsertOutputItem(item: Record<string, unknown>): void {
		const id = item.id;
		if (typeof id !== "string") {
			return;
		}
		const existing = this.accumulated.output.find(
			(it) => isPlainObject(it) && (it as { id?: unknown }).id === id,
		) as Record<string, unknown> | undefined;
		if (existing && isPlainObject(existing)) {
			for (const [key, value] of Object.entries(item)) {
				// Keep the more complete arguments string: deltas or
				// output_item.done may each carry the fuller value.
				if (
					key === "arguments" &&
					typeof value === "string" &&
					typeof existing.arguments === "string" &&
					value.length < existing.arguments.length
				) {
					continue;
				}
				existing[key] = value;
			}
		} else {
			this.accumulated.output.push(item);
		}
	}

	private findOutputItem(itemId: string): Record<string, unknown> | undefined {
		return this.accumulated.output.find(
			(it) => isPlainObject(it) && (it as { id?: unknown }).id === itemId,
		) as Record<string, unknown> | undefined;
	}

	private appendOutputText(itemId: string, text: string): void {
		const item = this.findOutputItem(itemId);
		if (item) {
			this.appendOutputTextToItem(item, text);
		}
	}

	private appendOutputArguments(itemId: string, args: string): void {
		const item = this.findOutputItem(itemId);
		if (!item) {
			return;
		}
		const current = typeof item.arguments === "string" ? item.arguments : "";
		item.arguments = current + args;
	}

	private appendOutputTextToItem(
		item: Record<string, unknown>,
		text: string,
	): void {
		if (!Array.isArray(item.content)) {
			item.content = [];
		}
		const content = item.content as Array<Record<string, unknown>>;
		const last = content[content.length - 1];
		if (last && isPlainObject(last) && last.type === "output_text") {
			last.text = (typeof last.text === "string" ? last.text : "") + text;
		} else {
			content.push({ type: "output_text", text });
		}
	}
}

interface ValidatedResponsesResponse {
	output: unknown[];
	output_text?: unknown;
	status?: unknown;
	incomplete_details?: unknown;
	usage?: {
		input_tokens?: number | null;
		output_tokens?: number | null;
		total_tokens?: number | null;
		input_tokens_details?: {
			cached_tokens?: number | null;
		} | null;
	};
}

function validateResponsesResponse(value: unknown): ValidatedResponsesResponse {
	if (!isPlainObject(value)) {
		throw new ModelRequestError(
			"Model response is not a JSON object.",
			"invalid_response",
		);
	}

	if (!Array.isArray(value.output)) {
		throw new ModelRequestError(
			"Responses API response missing output array.",
			"invalid_response",
			{
				responseField: "output",
			},
		);
	}

	if (
		value.output_text !== undefined &&
		value.output_text !== null &&
		typeof value.output_text !== "string"
	) {
		throw new ModelRequestError(
			"Responses API response has invalid output_text.",
			"invalid_response",
			{
				responseField: "output_text",
			},
		);
	}

	if (value.status !== undefined && typeof value.status !== "string") {
		throw new ModelRequestError(
			"Responses API response has invalid status.",
			"invalid_response",
			{
				responseField: "status",
			},
		);
	}

	return value as unknown as ValidatedResponsesResponse;
}

function parseResponsesUsage(raw: unknown): ModelUsage | undefined {
	if (!isPlainObject(raw)) {
		return undefined;
	}

	const input = readFiniteNumber(raw.input_tokens);
	const output = readFiniteNumber(raw.output_tokens);
	const total = readFiniteNumber(raw.total_tokens);
	if (input === null || output === null || total === null) {
		return undefined;
	}

	const details = isPlainObject(raw.input_tokens_details)
		? raw.input_tokens_details
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

function extractResponsesAssistantText(parsed: {
	output: unknown[];
	output_text?: unknown;
}): string | null {
	if (typeof parsed.output_text === "string") {
		return parsed.output_text;
	}

	const parts: string[] = [];

	parsed.output.forEach((item, itemIndex) => {
		if (!isPlainObject(item) || item.type !== "message") {
			return;
		}

		if (!Array.isArray(item.content)) {
			throw new ModelRequestError(
				`Responses API response has invalid output[${itemIndex}].content.`,
				"invalid_response",
				{
					responseField: `output[${itemIndex}].content`,
				},
			);
		}

		item.content.forEach((contentPart, contentIndex) => {
			if (!isPlainObject(contentPart)) {
				throw new ModelRequestError(
					`Responses API response has invalid output[${itemIndex}].content[${contentIndex}] structure.`,
					"invalid_response",
					{
						responseField: `output[${itemIndex}].content[${contentIndex}]`,
					},
				);
			}

			if (contentPart.type === "output_text") {
				if (typeof contentPart.text !== "string") {
					throw new ModelRequestError(
						`Responses API response has invalid output[${itemIndex}].content[${contentIndex}].text.`,
						"invalid_response",
						{
							responseField: `output[${itemIndex}].content[${contentIndex}].text`,
						},
					);
				}

				parts.push(contentPart.text);
			}
		});
	});

	return parts.length > 0 ? parts.join("") : null;
}

function mapResponsesFinishReason(
	status: unknown,
	toolCalls: ToolCall[],
	parsed: { incomplete_details?: unknown },
): string | null {
	if (status === "completed") {
		return toolCalls.length > 0 ? "tool_calls" : "stop";
	}

	if (status === "incomplete") {
		const details = parsed.incomplete_details;
		if (isPlainObject(details) && typeof details.reason === "string") {
			return details.reason;
		}

		return "incomplete";
	}

	return typeof status === "string" ? status : null;
}

import type { ModelRequest, ModelResponse } from "../types.js";

/**
 * Wire format adapter — one implementation per model API shape
 * (`chat_completions`, `responses`). An adapter is constructed with the
 * provider config (so it knows the model name and base URL); the transport
 * owns HTTP resilience and just calls these three methods.
 */
export interface WireFormatAdapter {
	/** Build the request URL for this format. */
	buildUrl(): string;
	/** Serialize a model request into this format's request body. */
	toRequestBody(request: ModelRequest): Record<string, unknown>;
	/** Parse a successful (non-streaming) JSON response body into a {@link ModelResponse}. */
	parse(data: unknown): ModelResponse;
	/**
	 * Fold one parsed SSE `data:` payload (a streaming delta) into running
	 * state. Only called on the streaming path; the transport feeds frames in
	 * order and calls {@link finalize} once the stream ends.
	 */
	accumulate(frame: unknown): void;
	/** Emit the complete {@link ModelResponse} assembled from accumulated frames. */
	finalize(): ModelResponse;
}

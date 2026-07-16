import type { ModelDelta, ModelRequest, ModelResponse } from "../types.js";

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
	/**
	 * Translate a SigPi {@link ModelRequest} into OpenAI-SDK call params for
	 * this format (`chat.completions.create` or `responses.create`): model,
	 * messages/input, tools, temperature, `max_tokens` / `max_output_tokens`,
	 * and the stream flag. This is the SDK-facing seam (ADR-0022); the old
	 * transport still uses {@link toRequestBody}. The two currently emit the
	 * same shape — the SDK client builds the request URL and HTTP envelope,
	 * so the params are exactly the body the legacy transport would POST.
	 */
	toParams(request: ModelRequest): Record<string, unknown>;
	/** Parse a successful (non-streaming) JSON response body into a {@link ModelResponse}. */
	parse(data: unknown): ModelResponse;
	/**
	 * Fold one parsed SSE `data:` payload (a streaming delta) into running
	 * state. Only called on the streaming path; the transport feeds frames in
	 * order and calls {@link finalize} once the stream ends.
	 */
	accumulate(frame: unknown): void;
	/**
	 * Derive a {@link ModelDelta} from a single accumulated frame, or `null` if
	 * the frame carries no renderable change. Called by the transport on the
	 * streaming path immediately after {@link accumulate} so the agent loop can
	 * render partial reasoning/content (spec-0020).
	 */
	onDelta(frame: unknown): ModelDelta | null;
	/**
	 * Return a best-effort partial {@link ModelResponse} reflecting the frames
	 * accumulated so far. Used to render a live preview of the in-flight
	 * response and to recover a usable answer if the stream is interrupted
	 * before it finalizes (spec-0020).
	 */
	getPartialView(): ModelResponse;
	/** Emit the complete {@link ModelResponse} assembled from accumulated frames. */
	finalize(): ModelResponse;
}

import type OpenAI from "openai";
import {
	APIConnectionError,
	APIConnectionTimeoutError,
	APIError,
	APIUserAbortError,
} from "openai";
import type { ModelConfig } from "../config.js";
import {
	estimateRecentMessagesTokens,
	estimateToolSchemaTokens,
} from "../context-window.js";
import { isTurnInterruptedError } from "../interrupt.js";
import type {
	JsonValue,
	ModelDelta,
	ModelRequest,
	ModelResponse,
	RuntimeLogger,
} from "../types.js";
import { getProxyStatus } from "./http-dispatcher.js";
import type { WireFormatAdapter } from "./wire-format.js";

export type RequestFailureKind =
	| "aborted"
	| "timeout"
	| "network_error"
	| "http_error"
	| "invalid_json"
	| "invalid_response"
	| "body_read_failed"
	| "empty_response"
	| "stream_error"
	| "truncated";

/** Error thrown for any failed model request, tagged with a failure kind. */
export class ModelRequestError extends Error {
	readonly kind: RequestFailureKind;
	readonly details: Record<string, JsonValue | undefined>;

	constructor(
		message: string,
		kind: RequestFailureKind,
		details: Record<string, JsonValue | undefined> = {},
	) {
		super(message);
		this.name = "ModelRequestError";
		this.kind = kind;
		this.details = details;
	}
}

function normalizeRequestError(error: unknown): ModelRequestError {
	if (error instanceof ModelRequestError) {
		return error;
	}

	return new ModelRequestError(
		error instanceof Error ? error.message : String(error),
		"network_error",
	);
}

function isRetryableRequestError(error: ModelRequestError): boolean {
	if (error.kind === "truncated") {
		return false;
	}

	if (error.kind === "timeout" || error.kind === "network_error") {
		return true;
	}

	if (error.kind === "stream_error") {
		return true;
	}

	if (error.kind === "body_read_failed") {
		const status = Number(error.details.httpStatus ?? 0);
		return status === 0 || status === 429 || status >= 500;
	}

	if (error.kind === "http_error") {
		const status = Number(error.details.httpStatus ?? 0);
		return status === 429 || status >= 500;
	}

	return false;
}

function computeBackoffDelayMs(baseDelayMs: number, attempt: number): number {
	const base = Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), 4_000);
	// Jitter up to 50% so retries don't all land in the same down window of a
	// flaky proxy.
	return Math.round(base + Math.random() * base * 0.5);
}

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).host;
	} catch {
		return undefined;
	}
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			const reason = signal?.reason;
			if (reason instanceof Error) {
				reject(reason);
				return;
			}
			reject(new DOMException("This operation was aborted", "AbortError"));
		};

		if (!signal) {
			return;
		}

		if (signal.aborted) {
			onAbort();
			return;
		}

		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function formatHttpErrorMessage(
	status: number,
	statusText: string,
	bodyText: string,
): string {
	return `Model request failed: ${status} ${statusText}${
		bodyText ? ` | ${truncate(bodyText, 300)}` : ""
	}`;
}

/**
 * Merge several abort signals (user/interrupt, total-request timer, idle/stall
 * timer) into one. Whichever fires first aborts the merged controller, and the
 * merged signal's `reason` is set to the firing signal's reason so callers can
 * tell a user interrupt from an idle/stall or total timeout (ADR-0024).
 */
function mergeAbortSignals(
	signals: Array<AbortSignal | undefined>,
): AbortSignal {
	const defined = signals.filter((s): s is AbortSignal => s !== undefined);
	if (defined.length === 0) {
		// No signals to merge: a controller that never fires.
		return new AbortController().signal;
	}
	if (defined.length === 1) {
		return defined[0];
	}

	const controller = new AbortController();
	const abortFrom = (signal: AbortSignal) => {
		if (controller.signal.aborted) {
			return;
		}
		controller.abort(signal.reason);
	};
	for (const signal of defined) {
		if (signal.aborted) {
			// Already fired before we could subscribe (e.g. a pre-aborted
			// user/interrupt signal) — propagate its reason immediately.
			controller.abort(signal.reason);
			break;
		}
		signal.addEventListener("abort", () => abortFrom(signal), { once: true });
	}
	return controller.signal;
}

function truncate(value: string, maxChars: number): JsonValue {
	if (value.length <= maxChars) {
		return value;
	}

	return `${value.slice(0, maxChars)}\n...[truncated]`;
}

/**
 * Headroom subtracted from the context window when capping `max_tokens`, so a
 * request is never sized right up against the model's hard limit. Kept
 * separate from `reserveTokens`, which stays the compaction headroom
 * (ADR-0021 untouched) — see issue #29.
 */
export const MAX_TOKENS_CLAMP_BUFFER_TOKENS = 4096;

/**
 * Cap the requested output-token budget so the model is never asked to
 * generate more than fits the remaining context window. Without this, an
 * absurd `max_tokens` (e.g. 100000) makes the turn generate for minutes and
 * then stop at `finish_reason: "length"` (hard truncation). The cap is
 * `hardContextLimit - estimatedInputTokens - MAX_TOKENS_CLAMP_BUFFER_TOKENS`.
 * When the caller leaves `maxTokens` unset, the cap itself is used so the
 * outbound request is always bounded by the context fit rather than left to
 * the provider default (issue #29).
 */
export function clampMaxTokens(
	request: ModelRequest,
	hardContextLimit: number,
): number {
	const estimatedInputTokens =
		estimateRecentMessagesTokens(request.messages) +
		estimateToolSchemaTokens(request.tools);
	const available =
		hardContextLimit - estimatedInputTokens - MAX_TOKENS_CLAMP_BUFFER_TOKENS;
	const requested = request.maxTokens ?? Number.POSITIVE_INFINITY;
	return Math.max(1, Math.min(requested, available));
}

const HTTP_STATUS_TEXT: Record<number, string> = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	409: "Conflict",
	422: "Unprocessable Entity",
	429: "Too Many Requests",
	500: "Internal Server Error",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
};

function statusTextFor(status: number): string {
	return HTTP_STATUS_TEXT[status] ?? "";
}

/**
 * Recover the response body text from an OpenAI SDK `APIError` for inclusion
 * in the `http_error` log message. The SDK stores a parsed JSON body on
 * `error.error`; for text bodies it surfaces the text at the start of
 * `error.message` (e.g. "502 upstream failed").
 */
function extractSdkErrorBody(error: APIError): string {
	const body = error.error as unknown;
	if (typeof body === "string") {
		return body;
	}
	if (body && typeof body === "object") {
		const obj = body as Record<string, unknown>;
		if (typeof obj.message === "string") {
			return obj.message;
		}
		if (typeof obj.error === "string") {
			return obj.error;
		}
		try {
			return JSON.stringify(obj);
		} catch {
			return "";
		}
	}
	const message = typeof error.message === "string" ? error.message : "";
	const match = message.match(/^\d+\s+(.*)$/s);
	return match ? (match[1]?.trim() ?? message) : message;
}

/**
 * Translate an OpenAI SDK error into SigPi's {@link ModelRequestError} so the
 * agent loop's retry/backoff (`isRetryableRequestError`) and log taxonomy stay
 * unchanged. The SDK error class name is captured in `details.sdkErrorType`
 * for observability.
 */
function mapSdkError(
	error: unknown,
	request: ModelRequest,
	totalController: AbortController,
	idleController: AbortController,
	mergedSignal: AbortSignal,
	timeoutMs: number,
): Error {
	if (error instanceof ModelRequestError) {
		return error;
	}

	// The SDK aborts the call when our merged signal fires. Disambiguate the
	// three abort sources by inspecting the signal's reason / which side
	// aborted, so ESC (TurnInterruptedError) re-throws without being retried
	// while a hung turn classifies as `timeout`.
	if (error instanceof APIUserAbortError) {
		const reason = mergedSignal.reason;
		if (isTurnInterruptedError(reason)) {
			return reason;
		}
		// A total or idle/stall timer firing means the turn hung, not a user
		// interrupt — classify as `timeout` (ADR-0024). The user/interrupt path
		// is handled above via the TurnInterruptedError reason.
		if (totalController.signal.aborted || idleController.signal.aborted) {
			return new ModelRequestError(
				`Model request timed out after ${timeoutMs}ms.`,
				"timeout",
				{ timeoutMs, sdkErrorType: "APIUserAbortError" },
			);
		}
		if (request.abortSignal?.aborted) {
			return new ModelRequestError(
				"Model request was cancelled by user interrupt.",
				"aborted",
				{ sdkErrorType: "APIUserAbortError" },
			);
		}
		return new ModelRequestError("Model request was cancelled.", "aborted", {
			sdkErrorType: "APIUserAbortError",
		});
	}

	if (error instanceof APIConnectionTimeoutError) {
		return new ModelRequestError(
			`Model request timed out after ${timeoutMs}ms.`,
			"timeout",
			{ timeoutMs, sdkErrorType: "APIConnectionTimeoutError" },
		);
	}

	if (error instanceof APIConnectionError) {
		const cause =
			error.cause instanceof Error ? error.cause.message : undefined;
		return new ModelRequestError(
			`Model request failed due to a network error: ${error.message}`,
			"network_error",
			{
				error: error.message,
				cause,
				sdkErrorType: "APIConnectionError",
			},
		);
	}

	if (error instanceof APIError) {
		// A streamed SSE `error` payload arrives over a 200 HTTP response, so the
		// SDK surfaces it as an `APIError` with no HTTP status. That is a
		// mid-stream failure (retryable), distinct from a real HTTP status error.
		const status = typeof error.status === "number" ? error.status : 0;
		if (status === 0) {
			return new ModelRequestError(
				`Model request failed mid-stream: ${error.message}`,
				"stream_error",
				{ sdkErrorType: error.constructor.name },
			);
		}
		const statusText = statusTextFor(status);
		const bodyText = extractSdkErrorBody(error);
		return new ModelRequestError(
			formatHttpErrorMessage(status, statusText, bodyText),
			"http_error",
			{
				httpStatus: status,
				httpStatusText: statusText,
				bodyPreview: bodyText ? truncate(bodyText, 300) : undefined,
				sdkErrorType: error.constructor.name,
			},
		);
	}

	// OpenAIError / JSON-parse failures on a 2xx body: surface as invalid_json
	// so the failure kind is preserved for the agent loop.
	const message = error instanceof Error ? error.message : String(error);
	return new ModelRequestError(
		`Model request failed: ${message}`,
		"invalid_json",
		{
			error: message,
			sdkErrorType: error instanceof Error ? error.constructor.name : "unknown",
		},
	);
}

/**
 * Model transport — owns HTTP resilience for the openai-compatible path over
 * the OpenAI SDK substrate. The SDK owns fetch, SSE framing, per-call body
 * reading, and (when configured) the total request timeout; this class owns
 * the idle/stall timeout, the retry/backoff loop, the {@link
 * RequestFailureKind} taxonomy, and the ESC-interrupt-not-retry rule. It is
 * format-agnostic: the {@link WireFormatAdapter} supplies `toParams` (SDK call
 * params) and the chunk → `ModelDelta` / `ModelResponse` mappers.
 */
export class ModelTransport {
	private readonly config: ModelConfig;
	private readonly logger?: RuntimeLogger;
	private readonly client: OpenAI;

	constructor(config: ModelConfig, client: OpenAI, logger?: RuntimeLogger) {
		this.config = config;
		this.logger = logger;
		this.client = client;
	}

	async generate(
		request: ModelRequest,
		makeAdapter: () => WireFormatAdapter,
		onDelta?: (delta: ModelDelta) => void,
	): Promise<ModelResponse> {
		const maxAttempts = this.config.maxRetries + 1;
		const startedAt = Date.now();

		// Cap the outbound `max_tokens` to the remaining context window so the
		// model never spends minutes generating then truncates at
		// `finish_reason: "length"` (issue #29). Computed once per `generate`
		// so every HTTP attempt sends the same bounded request.
		const clampedMaxTokens = clampMaxTokens(
			request,
			this.config.hardContextLimit ?? 200_000,
		);
		const clampedRequest =
			request.maxTokens === clampedMaxTokens
				? request
				: { ...request, maxTokens: clampedMaxTokens };

		this.logger?.info("model_request_started", {
			runId: request.context?.runId,
			sessionId: request.context?.sessionId,
			turnId: request.context?.turnId,
			purpose: request.context?.purpose ?? "turn",
			step: request.context?.step,
			model: this.config.name,
			messageCount: request.messages.length,
			toolCount: request.tools.length,
			timeoutMs: this.config.timeoutMs,
			maxRetries: this.config.maxRetries,
			stream: this.config.stream,
			requestedMaxTokens: request.maxTokens,
			maxTokensClamp: clampedMaxTokens,
			host: hostOf(this.config.baseURL),
			proxyActive: getProxyStatus().configured,
			proxyUrl: getProxyStatus().proxyUrl,
			fetchImpl: getProxyStatus().fetchImpl,
		});

		let lastError: ModelRequestError | null = null;

		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			try {
				const response = await this.performRequest(
					clampedRequest,
					makeAdapter(),
					onDelta,
				);

				// Backstop for a graceful stream end after the user pressed ESC:
				// some servers close the connection cleanly on abort, so the SDK
				// never throws. Re-throw the interrupt so the turn loop stops.
				if (
					request.abortSignal?.aborted &&
					isTurnInterruptedError(request.abortSignal.reason)
				) {
					throw request.abortSignal.reason;
				}

				// A hard truncation (max_tokens / content filter) is not
				// recoverable by retrying with the same limit, so surface it as
				// an error rather than returning a partial answer. The summarizer
				// and checkpoint paths handle their own truncation (purpose
				// "summary"), so leave those responses untouched.
				if (
					(response.finishReason === "length" ||
						response.finishReason === "content_filter") &&
					request.context?.purpose !== "summary"
				) {
					throw new ModelRequestError(
						`Model response was truncated (finish_reason=${response.finishReason}) and is not usable.`,
						"truncated",
						{ finishReason: response.finishReason },
					);
				}

				this.logger?.info("model_request_succeeded", {
					runId: request.context?.runId,
					sessionId: request.context?.sessionId,
					turnId: request.context?.turnId,
					purpose: request.context?.purpose ?? "turn",
					step: request.context?.step,
					model: this.config.name,
					attempt,
					elapsedMs: Date.now() - startedAt,
					finishReason: response.finishReason,
					toolCallCount: response.toolCalls.length,
					hasAssistantText: Boolean(response.assistantText),
				});
				return response;
			} catch (error) {
				if (isTurnInterruptedError(error)) {
					throw error;
				}

				// The SDK may end a stream gracefully on a mid-stream abort (no
				// throw), so a graceful completion/error surfaces as a normal
				// retryable failure here. If the abort was the user pressing ESC,
				// re-throw the interrupt so the turn loop stops and nothing is
				// retried.
				if (
					request.abortSignal?.aborted &&
					isTurnInterruptedError(request.abortSignal.reason)
				) {
					throw request.abortSignal.reason;
				}

				const normalized = normalizeRequestError(error);
				lastError = normalized;
				const retryable =
					attempt < maxAttempts && isRetryableRequestError(normalized);

				this.logger?.[retryable ? "warn" : "error"]("model_request_failed", {
					runId: request.context?.runId,
					sessionId: request.context?.sessionId,
					turnId: request.context?.turnId,
					purpose: request.context?.purpose ?? "turn",
					step: request.context?.step,
					model: this.config.name,
					attempt,
					maxAttempts,
					retryable,
					failureType: normalized.kind,
					proxyActive: getProxyStatus().configured,
					proxyUrl: getProxyStatus().proxyUrl,
					elapsedMs: Date.now() - startedAt,
					...normalized.details,
				});

				if (!retryable) {
					throw normalized;
				}

				await delay(
					computeBackoffDelayMs(this.config.retryBaseDelayMs, attempt),
					request.abortSignal,
				);
			}
		}

		throw (
			lastError ??
			new ModelRequestError(
				"Model request failed for an unknown reason.",
				"network_error",
			)
		);
	}

	private async performRequest(
		request: ModelRequest,
		adapter: WireFormatAdapter,
		onDelta?: (delta: ModelDelta) => void,
	): Promise<ModelResponse> {
		// Total request timeout (ADR-0024): bounds the whole request from start
		// to stream-end and is NOT reset on received bytes. This catches a
		// reasoning-forever model that streams thinking indefinitely (the ADR
		// 0020 accepted gap) — the idle/stall timer below is kept happy by those
		// thinking bytes, so only a byte-independent total deadline stops it.
		const totalController = new AbortController();
		const totalTimer = setTimeout(
			() => totalController.abort(new Error("model_total_timeout")),
			this.config.timeoutMs,
		);
		// Idle/stall timer: bounds silence. For streaming it resets on every
		// received chunk; for non-streaming it bounds the whole request. The
		// OpenAI SDK owns the per-byte SSE read, so this timer is our
		// dead-server / mid-stream-silence guard (ADR-0022).
		const idleController = new AbortController();
		const idleTimer = setTimeout(
			() => idleController.abort(new Error("model_idle_timeout")),
			this.config.timeoutMs,
		);
		// One merged signal: a user/ESC interrupt, the byte-independent total
		// deadline, or the idle/stall silence deadline — whichever fires first
		// aborts the SDK request (ADR-0024).
		const signal = mergeAbortSignals([
			request.abortSignal,
			totalController.signal,
			idleController.signal,
		]);
		const params = adapter.toParams(request);

		try {
			if (this.config.apiFormat === "responses") {
				const result = await this.client.responses.create(
					params as unknown as Parameters<
						typeof this.client.responses.create
					>[0],
					{ signal, maxRetries: 0 } as Parameters<
						typeof this.client.responses.create
					>[1],
				);
				if (this.config.stream) {
					return await this.readSdkStream(
						result as AsyncIterable<unknown>,
						adapter,
						totalController,
						idleController,
						idleTimer,
						onDelta,
					);
				}
				clearTimeout(totalTimer);
				clearTimeout(idleTimer);
				return adapter.parse(result);
			}

			const result = await this.client.chat.completions.create(
				params as unknown as Parameters<
					typeof this.client.chat.completions.create
				>[0],
				{ signal, maxRetries: 0 } as Parameters<
					typeof this.client.chat.completions.create
				>[1],
			);
			if (this.config.stream) {
				return await this.readSdkStream(
					result as AsyncIterable<unknown>,
					adapter,
					totalController,
					idleController,
					idleTimer,
					onDelta,
				);
			}
			clearTimeout(totalTimer);
			clearTimeout(idleTimer);
			return adapter.parse(result);
		} catch (error) {
			throw mapSdkError(
				error,
				request,
				totalController,
				idleController,
				signal,
				this.config.timeoutMs,
			);
		} finally {
			clearTimeout(totalTimer);
			clearTimeout(idleTimer);
		}
	}

	private async readSdkStream(
		stream: AsyncIterable<unknown>,
		adapter: WireFormatAdapter,
		totalController: AbortController,
		idleController: AbortController,
		idleTimer: ReturnType<typeof setTimeout>,
		onDelta?: (delta: ModelDelta) => void,
	): Promise<ModelResponse> {
		const iterator = stream[Symbol.asyncIterator]();
		const resetIdle = () => {
			clearTimeout(idleTimer);
			if (idleController.signal.aborted) {
				return;
			}
			idleTimer = setTimeout(
				() => idleController.abort(new Error("model_idle_timeout")),
				this.config.timeoutMs,
			);
		};

		try {
			while (true) {
				const { value, done } = await iterator.next();
				if (value !== undefined) {
					resetIdle();
				}
				if (done) {
					break;
				}

				// The SDK consumes the `[DONE]` sentinel internally, so every
				// yielded value is a real frame. Feed it through and let `finalize`
				// assemble; `getPartialView`/`finalize` own finish_reason detection
				// (incl. truncated).
				adapter.accumulate(value);
				const delta = adapter.onDelta(value);
				if (delta && onDelta) {
					onDelta(delta);
				}
			}

			const response = adapter.finalize();
			// If the idle/stall timer fired, the stream ended because the server
			// went quiet — classify that as a `timeout` rather than a generic
			// stream_error. Otherwise the SDK consumed the `[DONE]` sentinel, so the
			// stream reached a normal completion. Some responses-API gateways
			// stream `[DONE]` but omit the formal response.completed / status event,
			// leaving `finishReason` null — that is still a completed turn (the
			// pre-SDK transport returned finalize() on `[DONE]` regardless of
			// finish_reason). Only a stream that ended WITHOUT a completion signal
			// and produced no usable output is a genuine stream_error; the
			// adapter's isComplete() distinguishes the two.
			// If the total or idle/stall timer fired, the stream ended early —
			// classify that as a `timeout` rather than a generic stream_error.
			// The total timer (bytes-independent) catches reasoning-forever; the
			// idle timer catches a dead server / mid-stream silence (ADR-0024).
			if (totalController.signal.aborted || idleController.signal.aborted) {
				throw new ModelRequestError(
					`Model request timed out after ${this.config.timeoutMs}ms.`,
					"timeout",
					{ timeoutMs: this.config.timeoutMs },
				);
			}
			if (adapter.isComplete()) {
				return response;
			}
			if (response.finishReason != null) {
				return response;
			}
			throw new ModelRequestError(
				"Model SSE stream ended without a finish_reason; the response is incomplete.",
				"stream_error",
				{},
			);
		} finally {
			clearTimeout(idleTimer);
			try {
				await iterator.return?.(undefined);
			} catch {
				// Iterator teardown is best-effort; the SDK stream is already
				// aborting via the merged signal.
			}
		}
	}
}

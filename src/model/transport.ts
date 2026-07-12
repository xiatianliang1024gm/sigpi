import type { ModelConfig } from "../config.js";
import { isTurnInterruptedError } from "../interrupt.js";
import type {
	JsonValue,
	ModelRequest,
	ModelResponse,
	RuntimeLogger,
} from "../types.js";
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
	| "stream_error";

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
	return Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), 4_000);
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

function mergeAbortSignals(
	externalSignal: AbortSignal | undefined,
	timeoutSignal: AbortSignal,
): AbortSignal {
	if (!externalSignal) {
		return timeoutSignal;
	}

	if (externalSignal.aborted) {
		return externalSignal;
	}

	const controller = new AbortController();
	const abortFrom = (signal: AbortSignal) => {
		if (controller.signal.aborted) {
			return;
		}
		controller.abort(signal.reason);
	};
	const onExternalAbort = () => {
		externalSignal.removeEventListener("abort", onExternalAbort);
		timeoutSignal.removeEventListener("abort", onTimeoutAbort);
		abortFrom(externalSignal);
	};
	const onTimeoutAbort = () => {
		externalSignal.removeEventListener("abort", onExternalAbort);
		timeoutSignal.removeEventListener("abort", onTimeoutAbort);
		abortFrom(timeoutSignal);
	};

	externalSignal.addEventListener("abort", onExternalAbort, { once: true });
	timeoutSignal.addEventListener("abort", onTimeoutAbort, { once: true });
	return controller.signal;
}

function parseJsonResponse(
	bodyText: string,
	baseDetails: Record<string, JsonValue | undefined>,
): unknown {
	if (bodyText.trim() === "") {
		throw new ModelRequestError(
			"Model response body was empty.",
			"empty_response",
			{ ...baseDetails },
		);
	}

	try {
		return JSON.parse(bodyText) as unknown;
	} catch (error) {
		throw new ModelRequestError(
			`Model response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			"invalid_json",
			{ ...baseDetails, bodyPreview: bodyText },
		);
	}
}

type ReadBodyResult =
	| { ok: true; text: string }
	| { ok: false; readError: string };

async function safeReadResponseText(
	response: Response,
): Promise<ReadBodyResult> {
	try {
		return { ok: true, text: await response.text() };
	} catch (error) {
		return {
			ok: false,
			readError: error instanceof Error ? error.message : String(error),
		};
	}
}

function truncate(value: string, maxChars: number): JsonValue {
	if (value.length <= maxChars) {
		return value;
	}

	return `${value.slice(0, maxChars)}\n...[truncated]`;
}

/**
 * Model transport — owns HTTP resilience for every wire format: fetch,
 * timeout, abort merging, response-body reading, error classification,
 * JSON parsing, and the retry/backoff loop. It is format-agnostic; the
 * {@link WireFormatAdapter} supplies the URL, request body, and parser.
 */
export class ModelTransport {
	private readonly config: ModelConfig;
	private readonly logger?: RuntimeLogger;
	private readonly fetchImpl: typeof fetch;

	constructor(
		config: ModelConfig,
		logger?: RuntimeLogger,
		fetchImpl: typeof fetch = globalThis.fetch,
	) {
		this.config = config;
		this.logger = logger;
		this.fetchImpl = fetchImpl;
	}

	async generate(
		request: ModelRequest,
		makeAdapter: () => WireFormatAdapter,
	): Promise<ModelResponse> {
		const url = makeAdapter().buildUrl();
		const maxAttempts = this.config.maxRetries + 1;
		const startedAt = Date.now();

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
		});

		let lastError: ModelRequestError | null = null;

		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			try {
				const response = await this.performRequest(url, request, makeAdapter());
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
		url: string,
		request: ModelRequest,
		adapter: WireFormatAdapter,
	): Promise<ModelResponse> {
		const timeoutController = new AbortController();
		// Total-deadline timer. For the streaming path this is cleared once we
		// know the response is an event stream; there the idle/stall timer inside
		// readSseStream governs instead (reset on every received chunk).
		const timeout = setTimeout(
			() => timeoutController.abort(new Error("model_timeout")),
			this.config.timeoutMs,
		);
		const signal = mergeAbortSignals(
			request.abortSignal,
			timeoutController.signal,
		);

		try {
			const response = await this.fetchImpl(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${this.config.apiKey}`,
				},
				body: JSON.stringify(adapter.toRequestBody(request)),
				signal,
			});
			const baseDetails: Record<string, JsonValue | undefined> = {
				httpStatus: response.status,
				httpStatusText: response.statusText,
			};

			if (!response.ok) {
				const bodyResult = await safeReadResponseText(response);
				const preview = bodyResult.ok ? bodyResult.text : "";
				throw new ModelRequestError(
					formatHttpErrorMessage(response.status, response.statusText, preview),
					"http_error",
					{ ...baseDetails, bodyPreview: preview },
				);
			}

			const streaming =
				this.config.stream && ModelTransport.isEventStream(response);
			if (streaming) {
				clearTimeout(timeout);
				return await this.readSseStream(response, adapter, timeoutController);
			}

			// Non-streaming path: the total-deadline timer above stays armed and
			// covers the whole request (connect + body download), matching the
			// historical behaviour for stream=false or single-JSON responses.
			const bodyResult = await safeReadResponseText(response);
			baseDetails.bodyByteLength = bodyResult.ok ? bodyResult.text.length : 0;

			if (!bodyResult.ok) {
				throw new ModelRequestError(
					`Model response body could not be read: ${bodyResult.readError}`,
					"body_read_failed",
					{ ...baseDetails, bodyReadError: bodyResult.readError },
				);
			}

			const data = parseJsonResponse(bodyResult.text, baseDetails);
			return adapter.parse(data);
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				if (request.abortSignal?.aborted) {
					const reason = request.abortSignal.reason;
					if (isTurnInterruptedError(reason)) {
						throw reason;
					}
					throw new ModelRequestError(
						"Model request was cancelled by user interrupt.",
						"aborted",
					);
				}

				throw new ModelRequestError(
					`Model request timed out after ${this.config.timeoutMs}ms.`,
					"timeout",
					{
						timeoutMs: this.config.timeoutMs,
					},
				);
			}

			if (error instanceof ModelRequestError) {
				throw error;
			}

			throw new ModelRequestError(
				`Model request failed due to a network error: ${error instanceof Error ? error.message : String(error)}`,
				"network_error",
				{
					error: error instanceof Error ? error.message : String(error),
				},
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	private async readSseStream(
		response: Response,
		adapter: WireFormatAdapter,
		timeoutController: AbortController,
	): Promise<ModelResponse> {
		const reader = response.body?.getReader();
		if (!reader) {
			throw new ModelRequestError(
				"Model SSE response had no readable body stream.",
				"stream_error",
				{ httpStatus: response.status },
			);
		}

		const decoder = new TextDecoder();
		let buffer = "";
		let sawDone = false;
		let frameCount = 0;

		let idleTimer: ReturnType<typeof setTimeout> | null = setTimeout(
			() => timeoutController.abort(new Error("model_idle_timeout")),
			this.config.timeoutMs,
		);
		const resetIdle = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(
				() => timeoutController.abort(new Error("model_idle_timeout")),
				this.config.timeoutMs,
			);
		};

		try {
			while (!sawDone) {
				const { value, done } = await reader.read();
				if (value && value.byteLength > 0) {
					resetIdle();
				}
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });

				let separator = buffer.indexOf("\n\n");
				while (separator !== -1) {
					const block = buffer.slice(0, separator);
					buffer = buffer.slice(separator + 2);
					const result = this.processSseBlock(block, adapter);
					if (result === "done") {
						sawDone = true;
						break;
					}
					if (result === "frame") {
						frameCount += 1;
					}
					separator = buffer.indexOf("\n\n");
				}
			}

			if (!sawDone && buffer.trim().length > 0) {
				const result = this.processSseBlock(buffer, adapter);
				if (result === "done") {
					sawDone = true;
				} else if (result === "frame") {
					frameCount += 1;
				}
			}

			if (sawDone) {
				return adapter.finalize();
			}

			if (frameCount > 0) {
				try {
					return adapter.finalize();
				} catch (error) {
					throw new ModelRequestError(
						`Model SSE stream ended before a complete response could be assembled: ${error instanceof Error ? error.message : String(error)}`,
						"stream_error",
						{ httpStatus: response.status, frameCount },
					);
				}
			}

			throw new ModelRequestError(
				"Model SSE stream ended with no data frames.",
				"stream_error",
				{ httpStatus: response.status },
			);
		} finally {
			if (idleTimer) clearTimeout(idleTimer);
			try {
				await reader.cancel();
			} catch {
				// Reader may already be closed or errored; nothing to do.
			}
		}
	}

	private processSseBlock(
		block: string,
		adapter: WireFormatAdapter,
	): "done" | "frame" | "ignore" {
		const parsed = ModelTransport.parseSseBlock(block);
		if (!parsed) {
			return "ignore";
		}

		if (parsed.eventType === "error") {
			throw new ModelRequestError(
				`Model SSE error event: ${parsed.data}`,
				"stream_error",
				{},
			);
		}

		if (parsed.data === "[DONE]") {
			return "done";
		}

		let frame: unknown;
		try {
			frame = JSON.parse(parsed.data);
		} catch {
			throw new ModelRequestError(
				"Model SSE frame was not valid JSON.",
				"stream_error",
				{ framePreview: parsed.data.slice(0, 200) },
			);
		}

		adapter.accumulate(frame);
		return "frame";
	}

	private static parseSseBlock(
		block: string,
	): { eventType: string; data: string } | null {
		const dataParts: string[] = [];
		let eventType = "message";
		for (const line of block.split("\n")) {
			if (line === "") {
				continue;
			}
			if (line.startsWith(":")) {
				continue;
			}
			const colon = line.indexOf(":");
			if (colon === -1) {
				continue;
			}
			const field = line.slice(0, colon);
			let value = line.slice(colon + 1);
			if (value.startsWith(" ")) {
				value = value.slice(1);
			}
			if (field === "data") {
				dataParts.push(value);
			} else if (field === "event") {
				eventType = value;
			}
		}
		if (dataParts.length === 0) {
			return null;
		}
		return { eventType, data: dataParts.join("\n") };
	}

	private static isEventStream(response: Response): boolean {
		const contentType = response.headers?.get("content-type") ?? "";
		return contentType.toLowerCase().includes("text/event-stream");
	}
}

import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import OpenAI from "openai";
import type { ModelConfig } from "../../src/config.js";

export interface CapturedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

export type ResponseSpec =
	| { kind: "json"; status?: number; body: unknown; contentType?: string }
	| {
			kind: "sse";
			frames: string[];
			frameGapMs?: number;
			/** Write the first frame, then keep the connection open forever. */
			stallAfterFirstFrame?: boolean;
	  }
	| { kind: "error"; status: number; statusText?: string; body: string }
	/** 2xx with an invalid JSON body — forces the SDK's JSON.parse to throw. */
	| { kind: "invalidJson"; status?: number; body: string }
	/** Accept the connection but never respond (simulates a dead server). */
	| { kind: "hang" }
	/** Reset the TCP connection without a response (simulates a network error). */
	| { kind: "reset" };

export type RequestHandler = (
	request: CapturedRequest,
) => ResponseSpec | Promise<ResponseSpec>;

export interface LocalModelServer {
	/** OpenAI SDK base URL (ends at /v1). */
	baseURL: string;
	/** Config pointing at this server (use to construct ModelTransport directly). */
	config: ModelConfig;
	/** An OpenAI client pointed at this server. */
	client: OpenAI;
	/** Every request the server received, in order. */
	captured: CapturedRequest[];
	close: () => Promise<void>;
}

/**
 * A minimal OpenAI-SDK-compatible local server used to drive the model
 * transport end-to-end without external network access. It records each
 * request (URL, headers, parsed JSON body) and replies with a scripted
 * response: a single JSON object (non-streaming), a sequence of SSE `data:`
 * frames (streaming), a raw error status, or a silent hang.
 */
export async function startLocalModelServer(
	handler: RequestHandler,
	configOverrides: Partial<ModelConfig> = {},
): Promise<LocalModelServer> {
	const captured: CapturedRequest[] = [];
	// Track every accepted socket so close() can forcibly destroy them and
	// let the test process exit (keep-alive connections otherwise linger).
	const sockets = new Set<Socket>();

	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", async () => {
			const rawBody = Buffer.concat(chunks).toString("utf8");
			let body: unknown;
			try {
				body = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
			} catch {
				body = rawBody;
			}
			const headers: Record<string, string> = {};
			for (const [key, value] of Object.entries(req.headers)) {
				headers[key] = Array.isArray(value) ? value.join(",") : (value ?? "");
			}
			const capturedRequest: CapturedRequest = {
				url: req.url ?? "",
				method: req.method ?? "POST",
				headers,
				body,
			};
			captured.push(capturedRequest);

			let spec: ResponseSpec;
			try {
				spec = await handler(capturedRequest);
			} catch (error) {
				res.statusCode = 500;
				res.end(
					`handler error: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}

			writeSpec(res, spec);
		});
	});

	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	const baseURL = `http://127.0.0.1:${address.port}/v1`;

	const fullConfig: ModelConfig = {
		baseURL,
		apiKey: "test-key",
		name: "test-model",
		apiFormat: "chat_completions",
		stream: true,
		timeoutMs: 60_000,
		maxRetries: 0,
		retryBaseDelayMs: 1,
		...configOverrides,
	};

	return {
		baseURL,
		// The provider builds its own client; this one lets transport tests
		// drive ModelTransport directly with a stable config.
		config: fullConfig,
		client: new OpenAI({
			apiKey: "test-key",
			baseURL,
			maxRetries: 0,
			fetch: (input: RequestInfo | URL, init?: RequestInit) =>
				globalThis.fetch(input, init),
		}),
		captured,
		close: () => {
			// Destroy every accepted socket so the server doesn't wait on a
			// keep-alive connection, then unref the server so its (async) close
			// can't keep the test process alive.
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			server.closeAllConnections?.();
			server.close(() => {});
			server.unref?.();
			return Promise.resolve();
		},
	};
}

function writeSpec(res: http.ServerResponse, spec: ResponseSpec): void {
	switch (spec.kind) {
		case "json": {
			res.statusCode = spec.status ?? 200;
			res.setHeader("content-type", spec.contentType ?? "application/json");
			res.end(JSON.stringify(spec.body));
			return;
		}
		case "error": {
			res.statusCode = spec.status;
			if (spec.statusText) res.statusMessage = spec.statusText;
			res.setHeader("content-type", "text/plain");
			res.end(spec.body);
			return;
		}
		case "hang": {
			// Intentionally never respond; the client's idle/stall timer fires.
			return;
		}
		case "reset": {
			// Abruptly tear down the connection to simulate a network error.
			res.destroy();
			return;
		}
		case "invalidJson": {
			// 2xx + application/json + deliberately malformed body, so the
			// OpenAI SDK's JSON.parse throws (exercised as invalid_json).
			res.statusCode = spec.status ?? 200;
			res.setHeader("content-type", "application/json");
			res.end(spec.body);
			return;
		}
		case "sse": {
			res.statusCode = 200;
			res.setHeader("content-type", "text/event-stream");
			res.setHeader("cache-control", "no-cache");
			const frames = spec.frames;
			const writeFrame = (index: number) => {
				if (index >= frames.length) {
					res.end();
					return;
				}
				res.write(frames[index]);
				if (spec.stallAfterFirstFrame && index === 0) {
					// Keep the connection open; the idle timer must abort.
					return;
				}
				if (spec.frameGapMs && spec.frameGapMs > 0) {
					setTimeout(() => writeFrame(index + 1), spec.frameGapMs);
				} else {
					writeFrame(index + 1);
				}
			};
			writeFrame(0);
			return;
		}
	}
}

/** Build a chat-completions SSE frame for a single delta choice. */
export function chatFrame(
	delta: Record<string, unknown>,
	finishReason?: string,
	index?: number,
): string {
	const choice: Record<string, unknown> = { delta };
	if (index !== undefined) choice.index = index;
	if (finishReason !== undefined) choice.finish_reason = finishReason;
	return `data: ${JSON.stringify({ choices: [choice] })}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

/** Build a responses-API SSE event frame. */
export function responsesFrame(event: Record<string, unknown>): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

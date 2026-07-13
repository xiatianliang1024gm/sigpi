import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfig } from "../src/config.js";
import { ChatCompletionsAdapter } from "../src/model/chat-completions-adapter.js";
import { ResponsesAdapter } from "../src/model/responses-adapter.js";
import { ModelRequestError, ModelTransport } from "../src/model/transport.js";
import type { ModelRequest } from "../src/types.js";

function config(overrides: Partial<ModelConfig> = {}): ModelConfig {
	return {
		baseURL: "https://example.test/v1",
		apiKey: "secret",
		name: "demo",
		apiFormat: "chat_completions",
		stream: true,
		timeoutMs: 100,
		maxRetries: 0,
		retryBaseDelayMs: 1,
		...overrides,
	};
}

function request(
	messages: ModelRequest["messages"] = [{ role: "user", content: "hi" }],
): ModelRequest {
	return { messages, tools: [] };
}

function jsonResponse(
	body: unknown,
	contentType = "application/json",
): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": contentType },
	});
}

function sseResponse(frames: string[]): Response {
	const enc = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const frame of frames) {
				controller.enqueue(enc.encode(frame));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

// Enqueues frames spaced `gapMs` apart so the total wall-clock exceeds
// timeoutMs while each inter-frame gap stays under it.
function slowSseResponse(frames: string[], gapMs: number): Response {
	const enc = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const frame of frames) {
				controller.enqueue(enc.encode(frame));
				await new Promise((resolve) => setTimeout(resolve, gapMs));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

// Enqueues one frame then stalls forever; aborts the stream controller when the
// (merged) signal aborts, so the stalled read surfaces the idle timeout.
function stallingSseResponse(
	firstFrame: string,
	signal?: AbortSignal | null,
): Response {
	const enc = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(enc.encode(firstFrame));
			const onAbort = () => {
				try {
					controller.error(new DOMException("aborted", "AbortError"));
				} catch {
					// already closed
				}
			};
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const fetchImpl = (impl: (input: string, init?: RequestInit) => Response) =>
	impl as unknown as typeof fetch;

test("idle/stall timeout lets a slow-but-steady SSE stream succeed (total deadline would have killed it)", async () => {
	const frames = [
		'data: {"choices":[{"delta":{"role":"assistant","content":"hel"}}]}\n\n',
		'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
		'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
		"data: [DONE]\n\n",
	];
	const transport = new ModelTransport(
		config({ timeoutMs: 50, maxRetries: 0 }),
		undefined,
		fetchImpl(() => slowSseResponse(frames, 30)),
	);
	const result = await transport.generate(
		request(),
		() => new ChatCompletionsAdapter(config()),
	);
	assert.equal(result.assistantText, "hello");
	assert.equal(result.finishReason, "stop");
	// Total wall-clock (~150ms) far exceeds timeoutMs (50ms) but the stream
	// succeeds because the idle timer resets on every received frame.
});

test("mid-stream stall beyond the idle timeout fails with timeout and does not hang", async () => {
	const firstFrame = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n';
	const transport = new ModelTransport(
		config({ timeoutMs: 50, maxRetries: 0 }),
		undefined,
		fetchImpl(
			(_input, init) =>
				stallingSseResponse(firstFrame, init?.signal) as Response,
		),
	);
	await assert.rejects(
		() =>
			transport.generate(request(), () => new ChatCompletionsAdapter(config())),
		(error) =>
			error instanceof ModelRequestError &&
			error.kind === "timeout" &&
			/timed out after 50ms/.test(error.message),
	);
});

test("stream=false keeps the legacy single-JSON path unchanged", async () => {
	const transport = new ModelTransport(
		config({ stream: false, timeoutMs: 50 }),
		undefined,
		fetchImpl(() =>
			jsonResponse({
				choices: [{ message: { role: "assistant", content: "legacy" } }],
			}),
		),
	);
	const result = await transport.generate(
		request(),
		() => new ChatCompletionsAdapter(config({ stream: false })),
	);
	assert.equal(result.assistantText, "legacy");
});

test("ignore-type provider (stream requested, single JSON returned) falls back via tolerant parser", async () => {
	const transport = new ModelTransport(
		config({ timeoutMs: 50 }),
		undefined,
		fetchImpl(() =>
			jsonResponse({
				choices: [{ message: { role: "assistant", content: "ignored" } }],
			}),
		),
	);
	const result = await transport.generate(
		request(),
		() => new ChatCompletionsAdapter(config()),
	);
	assert.equal(result.assistantText, "ignored");
});

test("chat completions streams and stitches tool_call arguments by index", async () => {
	const frames = [
		'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
		'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"glob"}}]},"index":0}]}\n\n',
		'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]},"index":0}]}\n\n',
		'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"x\\"}"}}]},"index":0}]}\n\n',
		'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}\n\n',
		"data: [DONE]\n\n",
	];
	const transport = new ModelTransport(
		config({ timeoutMs: 50 }),
		undefined,
		fetchImpl(() => sseResponse(frames)),
	);
	const result = await transport.generate(
		request(),
		() => new ChatCompletionsAdapter(config()),
	);
	assert.equal(result.finishReason, "tool_calls");
	assert.equal(result.toolCalls[0]?.name, "glob");
	assert.deepEqual(result.toolCalls[0]?.arguments, { path: "x" });
});

test("responses streams and folds message text deltas", async () => {
	const frames = [
		'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n',
		'data: {"type":"response.output_item.delta","item_id":"msg_1","delta":{"type":"text_delta","text":"hel"}}\n\n',
		'data: {"type":"response.output_item.delta","item_id":"msg_1","delta":{"type":"text_delta","text":"lo"}}\n\n',
		'data: {"type":"response.completed","status":"completed","output_text":null,"output":[]}\n\n',
		"data: [DONE]\n\n",
	];
	const transport = new ModelTransport(
		config({ apiFormat: "responses", timeoutMs: 50 }),
		undefined,
		fetchImpl(() => sseResponse(frames)),
	);
	const result = await transport.generate(
		request(),
		() => new ResponsesAdapter(config({ apiFormat: "responses" })),
	);
	assert.equal(result.assistantText, "hello");
	assert.equal(result.finishReason, "stop");
});

test("responses streams and folds function_call argument deltas (real OpenAI string-delta shape)", async () => {
	const frames = [
		'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"glob","arguments":""}}\n\n',
		'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"pa"}\n\n',
		'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"th\\":\\"x\\"}"}\n\n',
		'data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"glob","arguments":"{\\"path\\":\\"x\\"}"}}\n\n',
		'data: {"type":"response.completed","status":"completed","output_text":null,"output":[]}\n\n',
		"data: [DONE]\n\n",
	];
	const transport = new ModelTransport(
		config({ apiFormat: "responses", timeoutMs: 50 }),
		undefined,
		fetchImpl(() => sseResponse(frames)),
	);
	const result = await transport.generate(
		request(),
		() => new ResponsesAdapter(config({ apiFormat: "responses" })),
	);
	assert.equal(result.finishReason, "tool_calls");
	assert.equal(result.toolCalls[0]?.name, "glob");
	assert.deepEqual(result.toolCalls[0]?.arguments, { path: "x" });
});

test("responses uses output_item.done full arguments when no deltas are streamed (regression: empty-args crash)", async () => {
	const frames = [
		'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"glob","arguments":""}}\n\n',
		'data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"glob","arguments":"{\\"pattern\\":\\"*\\"}"}}\n\n',
		'data: {"type":"response.completed","status":"completed","output_text":null,"output":[]}\n\n',
		"data: [DONE]\n\n",
	];
	const transport = new ModelTransport(
		config({ apiFormat: "responses", timeoutMs: 50 }),
		undefined,
		fetchImpl(() => sseResponse(frames)),
	);
	const result = await transport.generate(
		request(),
		() => new ResponsesAdapter(config({ apiFormat: "responses" })),
	);
	assert.equal(result.toolCalls[0]?.name, "glob");
	assert.deepEqual(result.toolCalls[0]?.arguments, { pattern: "*" });
	assert.equal(result.toolCalls[0]?.argumentParseError, undefined);
});

test("SSE error event is surfaced as a retryable stream_error", async () => {
	const frames = [
		'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
		'event: error\ndata: {"message":"rate limited"}\n\n',
	];
	const transport = new ModelTransport(
		config({ timeoutMs: 50, maxRetries: 0 }),
		undefined,
		fetchImpl(() => sseResponse(frames)),
	);
	await assert.rejects(
		() =>
			transport.generate(request(), () => new ChatCompletionsAdapter(config())),
		(error) =>
			error instanceof ModelRequestError && error.kind === "stream_error",
	);
});

test("stream ends after data frames but before [DONE] is a stream_error, not partial text", async () => {
	// A connection that delivers a content frame then closes without the
	// [DONE] sentinel must be a failed (retryable) stream. Otherwise the
	// partial text is silently accepted as a completed turn and the agent
	// stops mid-answer with no error surfaced.
	const frames = ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'];
	const transport = new ModelTransport(
		config({ timeoutMs: 50, maxRetries: 0 }),
		undefined,
		fetchImpl(() => sseResponse(frames)),
	);
	await assert.rejects(
		() =>
			transport.generate(request(), () => new ChatCompletionsAdapter(config())),
		(error) =>
			error instanceof ModelRequestError && error.kind === "stream_error",
	);
});

test("finish_reason length on a turn response is surfaced as a truncated error", async () => {
	const frames = [
		'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
		'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
		'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
		"data: [DONE]\n\n",
	];
	const transport = new ModelTransport(
		config({ timeoutMs: 50, maxRetries: 0 }),
		undefined,
		fetchImpl(() => sseResponse(frames)),
	);
	await assert.rejects(
		() =>
			transport.generate(
				{ ...request(), context: { purpose: "turn" } },
				() => new ChatCompletionsAdapter(config()),
			),
		(error) => error instanceof ModelRequestError && error.kind === "truncated",
	);
});

test("finish_reason length on a summary response is left for the caller to handle", async () => {
	const frames = [
		'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
		'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
		"data: [DONE]\n\n",
	];
	const transport = new ModelTransport(
		config({ timeoutMs: 50, maxRetries: 0 }),
		undefined,
		fetchImpl(() => sseResponse(frames)),
	);
	const result = await transport.generate(
		{ ...request(), context: { purpose: "summary" } },
		() => new ChatCompletionsAdapter(config()),
	);
	assert.equal(result.assistantText, "hel");
	assert.equal(result.finishReason, "length");
});

test("premature EOF with no data frames is a stream_error", async () => {
	const empty = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		},
	});
	const transport = new ModelTransport(
		config({ timeoutMs: 50, maxRetries: 0 }),
		undefined,
		fetchImpl(
			() =>
				new Response(empty, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		),
	);
	await assert.rejects(
		() =>
			transport.generate(request(), () => new ChatCompletionsAdapter(config())),
		(error) =>
			error instanceof ModelRequestError && error.kind === "stream_error",
	);
});

test("multi-line data fields are concatenated per the SSE spec", async () => {
	const frames = [
		'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
		'data: {"choices":\n',
		'data: [{"delta":{"content":"b"}}]}\n\n',
		'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
		"data: [DONE]\n\n",
	];
	const transport = new ModelTransport(
		config({ timeoutMs: 50 }),
		undefined,
		fetchImpl(() => sseResponse(frames)),
	);
	const result = await transport.generate(
		request(),
		() => new ChatCompletionsAdapter(config()),
	);
	assert.equal(result.assistantText, "ab");
});

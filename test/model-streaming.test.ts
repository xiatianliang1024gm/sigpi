import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { ModelConfig } from "../src/config.js";
import { ChatCompletionsAdapter } from "../src/model/chat-completions-adapter.js";
import { ResponsesAdapter } from "../src/model/responses-adapter.js";
import { ModelRequestError, ModelTransport } from "../src/model/transport.js";
import type { ModelRequest } from "../src/types.js";
import {
	chatFrame,
	type LocalModelServer,
	type ResponseSpec,
	responsesFrame,
	SSE_DONE,
	startLocalModelServer,
} from "./helpers/model-server.js";

function request(
	messages: ModelRequest["messages"] = [{ role: "user", content: "hi" }],
): ModelRequest {
	return { messages, tools: [] };
}

async function withServer(
	configOverrides: Partial<ModelConfig>,
	handler: (
		captured: LocalModelServer["captured"],
	) => ResponseSpec | Promise<ResponseSpec>,
	fn: (server: LocalModelServer) => Promise<void>,
): Promise<void> {
	const seen: LocalModelServer["captured"] = [];
	const server = await startLocalModelServer((req) => {
		seen.push(req);
		return handler(seen);
	}, configOverrides);
	try {
		await fn(server);
	} finally {
		await server.close();
	}
}

const chatAdapter = (config: LocalModelServer["config"]) => () =>
	new ChatCompletionsAdapter(config);
const responsesAdapter = (config: LocalModelServer["config"]) => () =>
	new ResponsesAdapter(config);

test("idle/stall timeout lets a slow-but-steady SSE stream succeed (total deadline would have killed it)", async () => {
	const frames = [
		chatFrame({ content: "a" }),
		chatFrame({ content: "b" }),
		chatFrame({ content: "c" }),
		chatFrame({}, "stop"),
		SSE_DONE,
	];
	await withServer(
		{ timeoutMs: 300 },
		() => ({ kind: "sse", frames, frameGapMs: 100 }),
		async (server) => {
			const transport = new ModelTransport(server.config, server.client);
			const result = await transport.generate(
				request(),
				chatAdapter(server.config),
			);
			assert.equal(result.assistantText, "abc");
			assert.equal(result.finishReason, "stop");
			// Total wall-clock (~460ms) exceeds timeoutMs (300ms) but the stream
			// succeeds because the idle timer resets on every received frame.
		},
	);
});

test("mid-stream stall beyond the idle timeout fails with timeout and does not hang", async () => {
	const firstFrame = chatFrame({ content: "x" });
	await withServer(
		{ timeoutMs: 200 },
		() => ({ kind: "sse", frames: [firstFrame], stallAfterFirstFrame: true }),
		async (server) => {
			const transport = new ModelTransport(server.config, server.client);
			await assert.rejects(
				() => transport.generate(request(), chatAdapter(server.config)),
				(error) =>
					error instanceof ModelRequestError &&
					error.kind === "timeout" &&
					/timed out after 200ms/.test(error.message),
			);
		},
	);
});

test("stream=false returns the single-JSON response unchanged", async () => {
	await withServer(
		{ stream: false, timeoutMs: 200 },
		() => ({
			kind: "json",
			body: {
				choices: [{ message: { role: "assistant", content: "legacy" } }],
			},
		}),
		async (server) => {
			const transport = new ModelTransport(server.config, server.client);
			const result = await transport.generate(
				request(),
				chatAdapter(server.config),
			);
			assert.equal(result.assistantText, "legacy");
		},
	);
});

test("chat completions streams and stitches tool_call arguments by index", async () => {
	const argStart = '{"pa';
	const argEnd = 'th":"x"}';
	const frames = [
		chatFrame({ role: "assistant" }, undefined, 0),
		chatFrame(
			{
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "glob" },
					},
				],
			},
			undefined,
			0,
		),
		chatFrame(
			{ tool_calls: [{ index: 0, function: { arguments: argStart } }] },
			undefined,
			0,
		),
		chatFrame(
			{ tool_calls: [{ index: 0, function: { arguments: argEnd } }] },
			undefined,
			0,
		),
		chatFrame({}, "tool_calls", 0),
		SSE_DONE,
	];
	await withServer(
		{ timeoutMs: 200 },
		() => ({ kind: "sse", frames }),
		async (server) => {
			const transport = new ModelTransport(server.config, server.client);
			const result = await transport.generate(
				request(),
				chatAdapter(server.config),
			);
			assert.equal(result.finishReason, "tool_calls");
			assert.equal(result.toolCalls[0]?.name, "glob");
			assert.deepEqual(result.toolCalls[0]?.arguments, { path: "x" });
		},
	);
});

test("responses streams and folds message text deltas", async () => {
	const frames = [
		responsesFrame({
			type: "response.output_item.added",
			item: { id: "msg_1", type: "message", role: "assistant", content: [] },
		}),
		responsesFrame({
			type: "response.output_item.delta",
			item_id: "msg_1",
			delta: { type: "text_delta", text: "hel" },
		}),
		responsesFrame({
			type: "response.output_item.delta",
			item_id: "msg_1",
			delta: { type: "text_delta", text: "lo" },
		}),
		responsesFrame({
			type: "response.completed",
			status: "completed",
			output_text: null,
			output: [],
		}),
		SSE_DONE,
	];
	await withServer(
		{ apiFormat: "responses", timeoutMs: 200 },
		() => ({ kind: "sse", frames }),
		async (server) => {
			const transport = new ModelTransport(server.config, server.client);
			const result = await transport.generate(
				request(),
				responsesAdapter(server.config),
			);
			assert.equal(result.assistantText, "hello");
			assert.equal(result.finishReason, "stop");
		},
	);
});

test("responses streams and folds function_call argument deltas (real OpenAI string-delta shape)", async () => {
	const frames = [
		responsesFrame({
			type: "response.output_item.added",
			item: {
				id: "fc_1",
				type: "function_call",
				call_id: "call_1",
				name: "glob",
				arguments: "",
			},
		}),
		responsesFrame({
			type: "response.function_call_arguments.delta",
			item_id: "fc_1",
			delta: '{"pa',
		}),
		responsesFrame({
			type: "response.function_call_arguments.delta",
			item_id: "fc_1",
			delta: 'th":"x"}',
		}),
		responsesFrame({
			type: "response.output_item.done",
			item: {
				id: "fc_1",
				type: "function_call",
				call_id: "call_1",
				name: "glob",
				arguments: '{"path":"x"}',
			},
		}),
		responsesFrame({
			type: "response.completed",
			status: "completed",
			output_text: null,
			output: [],
		}),
		SSE_DONE,
	];
	await withServer(
		{ apiFormat: "responses", timeoutMs: 200 },
		() => ({ kind: "sse", frames }),
		async (server) => {
			const transport = new ModelTransport(server.config, server.client);
			const result = await transport.generate(
				request(),
				responsesAdapter(server.config),
			);
			assert.equal(result.finishReason, "tool_calls");
			assert.equal(result.toolCalls[0]?.name, "glob");
			assert.deepEqual(result.toolCalls[0]?.arguments, { path: "x" });
		},
	);
});

test("responses uses output_item.done full arguments when no deltas are streamed (regression: empty-args crash)", async () => {
	const frames = [
		responsesFrame({
			type: "response.output_item.added",
			item: {
				id: "fc_1",
				type: "function_call",
				call_id: "call_1",
				name: "glob",
				arguments: "",
			},
		}),
		responsesFrame({
			type: "response.output_item.done",
			item: {
				id: "fc_1",
				type: "function_call",
				call_id: "call_1",
				name: "glob",
				arguments: '{"pattern":"*"}',
			},
		}),
		responsesFrame({
			type: "response.completed",
			status: "completed",
			output_text: null,
			output: [],
		}),
		SSE_DONE,
	];
	await withServer(
		{ apiFormat: "responses", timeoutMs: 200 },
		() => ({ kind: "sse", frames }),
		async (server) => {
			const transport = new ModelTransport(server.config, server.client);
			const result = await transport.generate(
				request(),
				responsesAdapter(server.config),
			);
			assert.equal(result.toolCalls[0]?.name, "glob");
			assert.deepEqual(result.toolCalls[0]?.arguments, { pattern: "*" });
			assert.equal(result.toolCalls[0]?.argumentParseError, undefined);
		},
	);
});

test("SSE error payload is surfaced as a retryable stream_error", async () => {
	const frames = [
		chatFrame({ content: "partial" }),
		'data: {"error":{"message":"rate limited"}}\n\n',
		SSE_DONE,
	];
	await withServer(
		{ timeoutMs: 200, maxRetries: 0 },
		() => ({ kind: "sse", frames }),
		async (server) => {
			const transport = new ModelTransport(server.config, server.client);
			await assert.rejects(
				() => transport.generate(request(), chatAdapter(server.config)),
				(error) =>
					error instanceof ModelRequestError && error.kind === "stream_error",
			);
		},
	);
});

test("stream ends after data frames but before [DONE] is a stream_error, not partial text", async () => {
	// A connection that delivers a content frame then closes without the
	// [DONE] sentinel (and without a finish_reason) must be a failed (retryable)
	// stream. Otherwise the partial text is silently accepted as a completed
	// turn and the agent stops mid-answer with no error surfaced.
	const frames = [chatFrame({ content: "partial" })];
	await withServer(
		{ timeoutMs: 200, maxRetries: 0 },
		() => ({ kind: "sse", frames }),
		async (server) => {
			const transport = new ModelTransport(server.config, server.client);
			await assert.rejects(
				() => transport.generate(request(), chatAdapter(server.config)),
				(error) =>
					error instanceof ModelRequestError && error.kind === "stream_error",
			);
		},
	);
});

test("finish_reason length on a turn response is surfaced as a truncated error", async () => {
	const frames = [
		chatFrame({ content: "hel" }),
		chatFrame({ content: "lo" }),
		chatFrame({}, "length"),
		SSE_DONE,
	];
	await withServer(
		{ timeoutMs: 200, maxRetries: 0 },
		() => ({ kind: "sse", frames }),
		async (server) => {
			const transport = new ModelTransport(server.config, server.client);
			await assert.rejects(
				() =>
					transport.generate(
						{ ...request(), context: { purpose: "turn" } },
						chatAdapter(server.config),
					),
				(error) =>
					error instanceof ModelRequestError && error.kind === "truncated",
			);
		},
	);
});

test("finish_reason length on a summary response is left for the caller to handle", async () => {
	const frames = [
		chatFrame({ content: "hel" }),
		chatFrame({}, "length"),
		SSE_DONE,
	];
	await withServer(
		{ timeoutMs: 200, maxRetries: 0 },
		() => ({ kind: "sse", frames }),
		async (server) => {
			const transport = new ModelTransport(server.config, server.client);
			const result = await transport.generate(
				{ ...request(), context: { purpose: "summary" } },
				chatAdapter(server.config),
			);
			assert.equal(result.assistantText, "hel");
			assert.equal(result.finishReason, "length");
		},
	);
});

test("premature EOF with no data frames is a stream_error", async () => {
	await withServer(
		{ timeoutMs: 200, maxRetries: 0 },
		() => ({ kind: "sse", frames: [] }),
		async (server) => {
			const transport = new ModelTransport(server.config, server.client);
			await assert.rejects(
				() => transport.generate(request(), chatAdapter(server.config)),
				(error) =>
					error instanceof ModelRequestError && error.kind === "stream_error",
			);
		},
	);
});

test("onDelta surfaces chat-completions reasoning + content deltas in order (spec-0020)", async () => {
	const frames = [
		chatFrame({ reasoning_content: "let me " }),
		chatFrame({ reasoning_content: "think" }),
		chatFrame({ content: "hel" }),
		chatFrame({ content: "lo" }),
		chatFrame({}, "stop"),
		SSE_DONE,
	];
	await withServer(
		{ timeoutMs: 200 },
		() => ({ kind: "sse", frames }),
		async (server) => {
			const transport = new ModelTransport(server.config, server.client);
			const deltas: string[] = [];
			await transport.generate(
				request(),
				chatAdapter(server.config),
				(delta) => {
					if (delta.reasoningDelta) deltas.push(`r:${delta.reasoningDelta}`);
					if (delta.contentDelta) deltas.push(`c:${delta.contentDelta}`);
				},
			);
			assert.deepEqual(deltas, ["r:let me ", "r:think", "c:hel", "c:lo"]);
		},
	);
});

test("onDelta surfaces responses reasoning + content deltas (spec-0020)", async () => {
	const frames = [
		responsesFrame({
			type: "response.reasoning.delta",
			delta: { text: "hmm" },
		}),
		responsesFrame({
			type: "response.output_text.delta",
			item_id: "i1",
			delta: "hel",
		}),
		responsesFrame({
			type: "response.output_text.delta",
			item_id: "i1",
			delta: "lo",
		}),
		responsesFrame({
			type: "response.completed",
			status: "completed",
			output_text: "hello",
			output: [],
		}),
		SSE_DONE,
	];
	await withServer(
		{ apiFormat: "responses", timeoutMs: 200 },
		() => ({ kind: "sse", frames }),
		async (server) => {
			const transport = new ModelTransport(server.config, server.client);
			const deltas: string[] = [];
			await transport.generate(
				request(),
				responsesAdapter(server.config),
				(delta) => {
					if (delta.reasoningDelta) deltas.push(`r:${delta.reasoningDelta}`);
					if (delta.contentDelta) deltas.push(`c:${delta.contentDelta}`);
				},
			);
			assert.deepEqual(deltas, ["r:hmm", "c:hel", "c:lo"]);
		},
	);
});

test("getPartialView returns accumulated text before finalize (spec-0020)", async () => {
	const adapter = new ChatCompletionsAdapter(
		(await startLocalModelServer((): ResponseSpec => ({ kind: "hang" })))
			.config,
	);
	adapter.accumulate(JSON.parse('{"choices":[{"delta":{"content":"hel"}}]}'));
	adapter.accumulate(JSON.parse('{"choices":[{"delta":{"content":"lo"}}]}'));
	const partial = adapter.getPartialView();
	assert.equal(partial.assistantText, "hello");
	assert.equal(partial.finishReason, null);
});

test("interrupt aborts the stream and surfaces TurnInterruptedError (spec-0020)", async () => {
	const { TurnInterruptedError } = await import("../src/interrupt.js");
	const firstFrame = chatFrame({ content: "x" });
	const controller = new AbortController();
	await withServer(
		{ timeoutMs: 5000, maxRetries: 0 },
		() => ({ kind: "sse", frames: [firstFrame], stallAfterFirstFrame: true }),
		async (server) => {
			const transport = new ModelTransport(server.config, server.client);
			const run = transport.generate(
				{ ...request(), abortSignal: controller.signal },
				chatAdapter(server.config),
			);
			setTimeout(
				() =>
					controller.abort(new TurnInterruptedError("user_escape", "model")),
				120,
			);
			await assert.rejects(
				() => run,
				(error) => error instanceof TurnInterruptedError,
			);
		},
	);
});

// The OpenAI SDK (v6) leaves the undici client socket busy after an aborted
// streaming response, so node --test's event loop never drains and the run
// hangs. Test files run in isolated processes, so force-exit once our tests
// have completed.
after(() => {
	process.exit(0);
});

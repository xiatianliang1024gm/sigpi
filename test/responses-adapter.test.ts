import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfig } from "../src/config.js";
import { ResponsesAdapter } from "../src/model/responses-adapter.js";
import { ModelRequestError } from "../src/model/transport.js";
import type { ModelRequest } from "../src/types.js";

function config(): ModelConfig {
	return {
		baseURL: "https://example.test/v1",
		apiKey: "secret",
		name: "demo",
		apiFormat: "responses",
		stream: true,
		timeoutMs: 100,
		maxRetries: 0,
		retryBaseDelayMs: 1,
	};
}

test("toParams emits SDK-shaped responses params", () => {
	const adapter = new ResponsesAdapter(config());
	const req: ModelRequest = {
		messages: [{ role: "user", content: "hi" }],
		tools: [],
		temperature: 0.3,
		maxTokens: 1024,
	};
	const params = adapter.toParams(req) as {
		model: string;
		input: unknown[];
		tools?: unknown;
		temperature: number;
		max_output_tokens: number;
		stream: boolean;
	};
	assert.equal(params.model, "demo");
	assert.deepEqual(params.input, [
		{ type: "message", role: "user", content: "hi" },
	]);
	assert.equal(params.tools, undefined);
	assert.equal(params.temperature, 0.3);
	assert.equal(params.max_output_tokens, 1024);
	assert.equal(params.stream, true);
});

test("toParams omits stream when the adapter is not streaming", () => {
	const adapter = new ResponsesAdapter({ ...config(), stream: false });
	const req: ModelRequest = {
		messages: [{ role: "user", content: "hi" }],
		tools: [],
	};
	const params = adapter.toParams(req) as { stream?: boolean };
	assert.equal(params.stream, undefined);
});

test("toParams emits SDK-shaped params for the responses schema (issue #26)", () => {
	const adapter = new ResponsesAdapter(config());
	const request_: ModelRequest = {
		messages: [{ role: "user", content: "hi" }],
		tools: [],
		temperature: 0.5,
		maxTokens: 768,
	};
	assert.deepEqual(adapter.toParams(request_), {
		model: "demo",
		input: [{ type: "message", role: "user", content: "hi" }],
		tools: undefined,
		temperature: 0.5,
		max_output_tokens: 768,
		stream: true,
	});
});

test("parse extracts assistant text from output_text and resolves finish reason", () => {
	const adapter = new ResponsesAdapter(config());
	const response = adapter.parse({
		status: "completed",
		output_text: "done",
		output: [
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "done" }],
			},
		],
		usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
	});

	assert.equal(response.assistantText, "done");
	assert.equal(response.finishReason, "stop");
	assert.equal(response.toolCalls.length, 0);
	assert.deepEqual(response.usage, {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 3,
	});
});

test("parse extracts tool calls from function_call outputs", () => {
	const adapter = new ResponsesAdapter(config());
	const response = adapter.parse({
		status: "completed",
		output: [
			{
				type: "function_call",
				call_id: "c1",
				name: "grep",
				arguments: '{"q":"x"}',
			},
		],
	});

	assert.equal(response.finishReason, "tool_calls");
	assert.equal(response.toolCalls.length, 1);
	assert.equal(response.toolCalls[0]?.name, "grep");
	assert.equal(response.toolCalls[0]?.arguments?.q, "x");
});

test("parse throws ModelRequestError when output is missing", () => {
	const adapter = new ResponsesAdapter(config());
	assert.throws(
		() => adapter.parse({ status: "completed" }),
		(error) =>
			error instanceof ModelRequestError && error.kind === "invalid_response",
	);
});

test("finalize accumulates reasoning from response.reasoning.delta frames", () => {
	const adapter = new ResponsesAdapter(config());
	for (const frame of [
		{
			type: "response.reasoning.delta",
			delta: { text: "let me " },
		},
		{
			type: "response.reasoning.delta",
			delta: { text: "think" },
		},
		{
			type: "response.output_item.added",
			item: {
				id: "msg1",
				type: "message",
				role: "assistant",
				content: [],
			},
		},
		{
			type: "response.output_text.delta",
			item_id: "msg1",
			delta: "done",
		},
		{
			type: "response.completed",
			status: "completed",
		},
	]) {
		adapter.accumulate(frame);
	}
	const response = adapter.finalize();
	assert.equal(response.reasoning, "let me think");
	assert.equal(response.assistantText, "done");
});

test("finalize accumulates reasoning_summary deltas", () => {
	const adapter = new ResponsesAdapter(config());
	for (const frame of [
		{
			type: "response.reasoning_summary.delta",
			delta: { text: "plan: " },
		},
		{
			type: "response.reasoning_summary.delta",
			delta: { text: "call read" },
		},
		{
			type: "response.output_item.added",
			item: {
				id: "msg1",
				type: "message",
				role: "assistant",
				content: [],
			},
		},
		{
			type: "response.output_text.delta",
			item_id: "msg1",
			delta: "ok",
		},
		{
			type: "response.completed",
			status: "completed",
		},
	]) {
		adapter.accumulate(frame);
	}
	const response = adapter.finalize();
	assert.equal(response.reasoning, "plan: call read");
	assert.equal(response.assistantText, "ok");
});

test("finalize prefers the terminal reasoning_summary_text.done text when longer", () => {
	const adapter = new ResponsesAdapter(config());
	for (const frame of [
		{
			type: "response.reasoning_summary.delta",
			delta: { text: "partial " },
		},
		{
			type: "response.reasoning_summary_text.done",
			text: "full final reasoning text",
		},
		{
			type: "response.output_item.added",
			item: {
				id: "msg1",
				type: "message",
				role: "assistant",
				content: [],
			},
		},
		{
			type: "response.output_text.delta",
			item_id: "msg1",
			delta: "answer",
		},
		{
			type: "response.completed",
			status: "completed",
		},
	]) {
		adapter.accumulate(frame);
	}
	const response = adapter.finalize();
	assert.equal(response.reasoning, "full final reasoning text");
});

test("finalize returns null reasoning when none was streamed", () => {
	const adapter = new ResponsesAdapter(config());
	for (const frame of [
		{
			type: "response.output_item.added",
			item: {
				id: "msg1",
				type: "message",
				role: "assistant",
				content: [],
			},
		},
		{
			type: "response.output_text.delta",
			item_id: "msg1",
			delta: "just the answer",
		},
		{
			type: "response.completed",
			status: "completed",
		},
	]) {
		adapter.accumulate(frame);
	}
	const response = adapter.finalize();
	assert.equal(response.reasoning, null);
});

test("parse (non-streaming) extracts reasoning from a reasoning output item", () => {
	const adapter = new ResponsesAdapter(config());
	const response = adapter.parse({
		status: "completed",
		output: [
			{
				type: "reasoning",
				summary: [
					{ type: "summary_text", text: "hidden " },
					{ type: "summary_text", text: "plan" },
				],
			},
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "answer" }],
			},
		],
	});
	assert.equal(response.reasoning, "hidden plan");
	assert.equal(response.assistantText, "answer");
});

test("finalize accumulates reasoning from response.reasoning_text.delta (DeepSeek shape)", () => {
	const adapter = new ResponsesAdapter(config());
	for (const frame of [
		{ type: "response.reasoning_text.delta", delta: "We " },
		{ type: "response.reasoning_text.delta", delta: "need answer." },
		{
			type: "response.output_item.added",
			item: {
				id: "msg1",
				type: "message",
				role: "assistant",
				content: [],
			},
		},
		{ type: "response.output_text.delta", item_id: "msg1", delta: "done" },
		{ type: "response.completed", status: "completed" },
	]) {
		adapter.accumulate(frame);
	}
	const response = adapter.finalize();
	assert.equal(response.reasoning, "We need answer.");
	assert.equal(response.assistantText, "done");
});

test("finalize reads usage and status from the nested response object in response.completed (DeepSeek responses API)", () => {
	// DeepSeek (and OpenAI) stream the finished response object NESTED under
	// `response`: `{"type":"response.completed","response":{...,"status":
	// "completed","usage":{...}}}`. The adapter must read usage/status from
	// there so the status bar can show billed tokens in responses mode.
	const adapter = new ResponsesAdapter(config());
	for (const frame of [
		{
			type: "response.output_item.added",
			item: {
				id: "msg1",
				type: "message",
				role: "assistant",
				content: [],
			},
		},
		{ type: "response.output_text.delta", item_id: "msg1", delta: "ok" },
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage: {
					input_tokens: 87,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 21,
					output_tokens_details: { reasoning_tokens: 18 },
					total_tokens: 108,
				},
			},
		},
	]) {
		adapter.accumulate(frame);
	}
	const response = adapter.finalize();
	assert.equal(response.assistantText, "ok");
	assert.equal(response.finishReason, "stop");
	assert.deepEqual(response.usage, {
		input: 87,
		output: 21,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 108,
	});
});

test("onDelta surfaces finishReason from the nested response object in response.completed", () => {
	const adapter = new ResponsesAdapter(config());
	const delta = adapter.onDelta({
		type: "response.completed",
		response: { status: "completed" },
	});
	assert.deepEqual(delta, { finishReason: "completed" });
});

test("finalize accumulates reasoning from response.reasoning_summary_text.delta", () => {
	const adapter = new ResponsesAdapter(config());
	for (const frame of [
		{ type: "response.reasoning_summary_text.delta", delta: "sum " },
		{ type: "response.reasoning_summary_text.delta", delta: "mary" },
		{
			type: "response.output_item.added",
			item: {
				id: "msg1",
				type: "message",
				role: "assistant",
				content: [],
			},
		},
		{ type: "response.output_text.delta", item_id: "msg1", delta: "ok" },
		{ type: "response.completed", status: "completed" },
	]) {
		adapter.accumulate(frame);
	}
	const response = adapter.finalize();
	assert.equal(response.reasoning, "sum mary");
});

test("finalize accumulates reasoning from response.reasoning_text.done (DeepSeek terminal frame)", () => {
	const adapter = new ResponsesAdapter(config());
	for (const frame of [
		{
			type: "response.reasoning_text.done",
			text: "full hidden reasoning",
		},
		{
			type: "response.output_item.added",
			item: {
				id: "msg1",
				type: "message",
				role: "assistant",
				content: [],
			},
		},
		{ type: "response.output_text.delta", item_id: "msg1", delta: "answer" },
		{ type: "response.completed", status: "completed" },
	]) {
		adapter.accumulate(frame);
	}
	const response = adapter.finalize();
	assert.equal(response.reasoning, "full hidden reasoning");
});

test("onDelta surfaces reasoningDelta from response.reasoning_text.delta (DeepSeek shape)", () => {
	const adapter = new ResponsesAdapter(config());
	const delta = adapter.onDelta({
		type: "response.reasoning_text.delta",
		delta: "think",
	});
	assert.deepEqual(delta, { reasoningDelta: "think" });
});

test("parse (non-streaming) extracts DeepSeek reasoning content parts", () => {
	const adapter = new ResponsesAdapter(config());
	const response = adapter.parse({
		status: "completed",
		output: [
			{
				type: "reasoning",
				content: [
					{
						type: "reasoning_text",
						text: "DeepSeek hidden chain",
					},
				],
			},
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "answer" }],
			},
		],
	});
	assert.equal(response.reasoning, "DeepSeek hidden chain");
	assert.equal(response.assistantText, "answer");
});

test("finalize assembles DeepSeek reasoning from output_item.done content parts", () => {
	const adapter = new ResponsesAdapter(config());
	for (const frame of [
		{
			type: "response.output_item.added",
			item: {
				id: "r1",
				type: "reasoning",
				status: "in_progress",
				content: [],
			},
		},
		{
			type: "response.output_item.done",
			item: {
				id: "r1",
				type: "reasoning",
				status: "completed",
				content: [{ type: "reasoning_text", text: "assembled reasoning" }],
			},
		},
		{
			type: "response.output_item.added",
			item: {
				id: "msg1",
				type: "message",
				role: "assistant",
				content: [],
			},
		},
		{ type: "response.output_text.delta", item_id: "msg1", delta: "answer" },
		{ type: "response.completed", status: "completed" },
	]) {
		adapter.accumulate(frame);
	}
	const response = adapter.finalize();
	assert.equal(response.reasoning, "assembled reasoning");
	assert.equal(response.assistantText, "answer");
});

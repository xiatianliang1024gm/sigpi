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

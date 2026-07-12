import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfig } from "../src/config.js";
import { ChatCompletionsAdapter } from "../src/model/chat-completions-adapter.js";
import { ModelRequestError } from "../src/model/transport.js";
import type { ModelRequest } from "../src/types.js";

function config(): ModelConfig {
	return {
		baseURL: "https://example.test/v1",
		apiKey: "secret",
		name: "demo",
		apiFormat: "chat_completions",
		stream: true,
		timeoutMs: 100,
		maxRetries: 0,
		retryBaseDelayMs: 1,
	};
}

function request(messages: ModelRequest["messages"]): ModelRequest {
	return { messages, tools: [] };
}

test("buildUrl appends the chat completions path", () => {
	const adapter = new ChatCompletionsAdapter(config());
	assert.equal(adapter.buildUrl(), "https://example.test/v1/chat/completions");
});

test("buildUrl keeps an explicit chat/completions base URL", () => {
	const adapter = new ChatCompletionsAdapter({
		...config(),
		baseURL: "https://example.test/chat/completions",
	});
	assert.equal(adapter.buildUrl(), "https://example.test/chat/completions");
});

test("toRequestBody serializes messages and the model name", () => {
	const adapter = new ChatCompletionsAdapter(config());
	const body = adapter.toRequestBody(
		request([{ role: "user", content: "hi" }]),
	) as { model: string; messages: unknown[]; tools?: unknown };
	assert.equal(body.model, "demo");
	assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
	assert.equal(body.tools, undefined);
});

test("parse extracts assistant text, tool calls, and usage", () => {
	const adapter = new ChatCompletionsAdapter(config());
	const response = adapter.parse({
		choices: [
			{
				message: {
					role: "assistant",
					content: "hi",
					tool_calls: [
						{
							id: "1",
							type: "function",
							function: { name: "grep", arguments: '{"q":"x"}' },
						},
					],
				},
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
	});

	assert.equal(response.assistantText, "hi");
	assert.equal(response.toolCalls.length, 1);
	assert.equal(response.toolCalls[0]?.name, "grep");
	assert.equal(response.toolCalls[0]?.arguments?.q, "x");
	assert.equal(response.finishReason, null);
	assert.deepEqual(response.usage, {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 3,
	});
});

test("parse throws ModelRequestError on a malformed response", () => {
	const adapter = new ChatCompletionsAdapter(config());
	assert.throws(
		() => adapter.parse({ choices: [] }),
		(error) =>
			error instanceof ModelRequestError && error.kind === "invalid_response",
	);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfig } from "../src/config.js";
import { ChatCompletionsAdapter } from "../src/model/chat-completions-adapter.js";
import { ModelRequestError } from "../src/model/transport.js";
import { sanitizeToolArguments } from "../src/model/util.js";
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

test("toParams emits SDK-shaped chat.completions params", () => {
	const adapter = new ChatCompletionsAdapter(config());
	const req: ModelRequest = {
		messages: [{ role: "user", content: "hi" }],
		tools: [],
		temperature: 0.2,
		maxTokens: 512,
	};
	const params = adapter.toParams(req) as {
		model: string;
		messages: unknown[];
		tools?: unknown;
		temperature: number;
		max_tokens: number;
		stream: boolean;
	};
	assert.equal(params.model, "demo");
	assert.deepEqual(params.messages, [{ role: "user", content: "hi" }]);
	assert.equal(params.tools, undefined);
	assert.equal(params.temperature, 0.2);
	assert.equal(params.max_tokens, 512);
	assert.equal(params.stream, true);
});

test("toParams omits stream when the adapter is not streaming", () => {
	const adapter = new ChatCompletionsAdapter({ ...config(), stream: false });
	const req: ModelRequest = {
		messages: [{ role: "user", content: "hi" }],
		tools: [],
	};
	const params = adapter.toParams(req) as { stream?: boolean };
	assert.equal(params.stream, undefined);
});

test("toParams emits SDK-shaped params for the chat.completions schema (issue #26)", () => {
	const adapter = new ChatCompletionsAdapter(config());
	const request_: ModelRequest = {
		messages: [{ role: "user", content: "hi" }],
		tools: [],
		temperature: 0.4,
		maxTokens: 256,
	};
	assert.deepEqual(adapter.toParams(request_), {
		model: "demo",
		messages: [{ role: "user", content: "hi" }],
		tools: undefined,
		temperature: 0.4,
		max_tokens: 256,
		stream: true,
	});
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

test("sanitizeToolArguments makes a tool-call arguments string a valid JSON object (issue #66)", () => {
	// A raw ESC (0x1B) plus an invalid `\\x` escape inside the arguments
	// JSON: invalid JSON, but some models emit it and providers reject the
	// whole request with HTTP 400.
	const raw = '{"content": "regex /\\x1B/' + "\u001b" + ' here"}';
	const out = sanitizeToolArguments(raw);
	// Always a valid JSON string that parses to an object.
	assert.doesNotThrow(() => JSON.parse(out));
	assert.equal(typeof JSON.parse(out), "object");
	// Never carries a raw control character (the actual 400 trigger).
	assert.equal(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(out), false);

	// Empty / whitespace-only input becomes a valid empty object.
	assert.equal(sanitizeToolArguments(""), "{}");

	// Already-valid JSON (incl. escaped sequences) is returned unchanged.
	const valid = '{"a": 1, "b": "x\\ny"}';
	assert.equal(sanitizeToolArguments(valid), valid);

	// Unrecoverable fragment still yields a valid JSON object string.
	const junk = "not json \u0001";
	const j = sanitizeToolArguments(junk);
	assert.doesNotThrow(() => JSON.parse(j));
	assert.equal(typeof JSON.parse(j), "object");
});

test("toParams sanitizes a tool-call arguments string that contains a raw control character (issue #66)", () => {
	const adapter = new ChatCompletionsAdapter(config());
	const req: ModelRequest = {
		messages: [
			{
				role: "assistant",
				content: "writing file",
				toolCalls: [
					{
						id: "c1",
						name: "write",
						arguments: {},
						rawArguments: '{"content": "regex /\\x1B/\x1b"}',
						argumentParseError: "Model returned invalid tool arguments",
					},
				],
			},
			{
				role: "tool",
				name: "write",
				toolCallId: "c1",
				content: "TOOL write STATUS error",
			},
		],
		tools: [],
	};
	const params = adapter.toParams(req) as {
		messages: Array<{
			role: string;
			tool_calls?: Array<{ function: { arguments: string } }>;
		}>;
	};
	const sentArgs = params.messages[0]?.tool_calls?.[0]?.function.arguments;
	assert.ok(sentArgs !== undefined, "tool call arguments should be present");
	assert.doesNotThrow(
		() => JSON.parse(sentArgs as string),
		"forwarded arguments must be valid JSON (no raw control char)",
	);
	assert.equal(
		/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(sentArgs as string),
		false,
		"forwarded arguments must not contain a raw control character",
	);
});

test("parse throws ModelRequestError on a malformed response", () => {
	const adapter = new ChatCompletionsAdapter(config());
	assert.throws(
		() => adapter.parse({ choices: [] }),
		(error) =>
			error instanceof ModelRequestError && error.kind === "invalid_response",
	);
});

test("onDelta routes tagged <mm:think> content to reasoningDelta and clean contentDelta", () => {
	const adapter = new ChatCompletionsAdapter(config());
	const deltas: string[] = [];
	for (const frame of [
		{ choices: [{ delta: { content: "<mm:think>let me " } }] },
		{ choices: [{ delta: { content: "think</mm:think>hel" } }] },
		{ choices: [{ delta: { content: "lo" } }] },
		{ choices: [{ delta: {}, finish_reason: "stop" }] },
	]) {
		const delta = adapter.onDelta(frame);
		if (delta?.reasoningDelta) deltas.push(`r:${delta.reasoningDelta}`);
		if (delta?.contentDelta) deltas.push(`c:${delta.contentDelta}`);
	}
	assert.deepEqual(deltas, ["r:let me ", "r:think", "c:hel", "c:lo"]);
});

test("finalize strips tagged thinking from assistantText", () => {
	const adapter = new ChatCompletionsAdapter(config());
	for (const frame of [
		{
			choices: [
				{ delta: { content: "<mm:think>hidden</mm:think>the answer" } },
			],
		},
		{ choices: [{ delta: {}, finish_reason: "stop" }] },
	]) {
		adapter.accumulate(frame);
	}
	assert.equal(adapter.finalize().assistantText, "the answer");
});

test("onDelta leaves plain content untouched", () => {
	const adapter = new ChatCompletionsAdapter(config());
	const delta = adapter.onDelta({ choices: [{ delta: { content: "plain" } }] });
	assert.equal(delta?.contentDelta, "plain");
	assert.equal(delta?.reasoningDelta, undefined);
});

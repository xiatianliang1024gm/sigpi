import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfig } from "../src/config.js";
import { OpenAICompatibleProvider } from "../src/model/openai-compatible.js";
import { clampMaxTokens } from "../src/model/transport.js";
import type { ModelRequest } from "../src/types.js";
import {
	chatFrame,
	type LocalModelServer,
	type ResponseSpec,
	responsesFrame,
	SSE_DONE,
	startLocalModelServer,
} from "./helpers/model-server.js";
import { MemoryLogger } from "./helpers.js";

type Overrides = Partial<ModelConfig>;

function createProvider(
	server: LocalModelServer,
	overrides: Overrides = {},
	logger = new MemoryLogger(),
): OpenAICompatibleProvider {
	return new OpenAICompatibleProvider(
		{ ...server.config, ...overrides },
		logger,
	);
}

async function withServer(
	configOverrides: Overrides,
	handler: (
		captured: LocalModelServer["captured"],
	) => ResponseSpec | Promise<ResponseSpec>,
	fn: (server: LocalModelServer) => Promise<void>,
): Promise<void> {
	// Capture each request as it arrives so the handler can branch on attempt
	// count (e.g. fail-then-succeed retry scenarios).
	const seen: LocalModelServer["captured"] = [];
	const server = await startLocalModelServer(async (req) => {
		seen.push(req);
		return handler(seen);
	}, configOverrides);
	try {
		await fn(server);
	} finally {
		await server.close();
	}
}

function chatJson(body: unknown): ResponseSpec {
	return { kind: "json", body };
}

function responsesJson(body: unknown): ResponseSpec {
	return { kind: "json", body };
}

test("provider posts to the chat completions path and parses the response", async () => {
	await withServer(
		{ stream: false },
		() =>
			chatJson({
				choices: [{ message: { role: "assistant", content: "ok" } }],
			}),
		async (server) => {
			const provider = createProvider(server, { stream: false });
			const response = await provider.generate({
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			});
			assert.equal(response.assistantText, "ok");
			assert.equal(server.captured[0]?.url, "/v1/chat/completions");
			const body = server.captured[0]?.body as Record<string, unknown>;
			assert.equal(body.model, server.config.name);
			assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
			assert.equal(body.stream, undefined);
		},
	);
});

test("provider posts to the responses path and parses output_text", async () => {
	await withServer(
		{ apiFormat: "responses", stream: false },
		() => responsesJson({ status: "completed", output_text: "ok", output: [] }),
		async (server) => {
			const provider = createProvider(server, {
				apiFormat: "responses",
				stream: false,
			});
			const response = await provider.generate({
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			});
			assert.equal(response.assistantText, "ok");
			assert.equal(response.finishReason, "stop");
			assert.equal(server.captured[0]?.url, "/v1/responses");
			const body = server.captured[0]?.body as Record<string, unknown>;
			assert.equal(body.model, server.config.name);
			assert.deepEqual(body.input, [
				{ type: "message", role: "user", content: "hi" },
			]);
			assert.equal(body.stream, undefined);
		},
	);
});

test("provider returns a direct assistant response on 2xx JSON (chat)", async () => {
	await withServer(
		{ stream: false },
		() =>
			chatJson({
				choices: [
					{
						finish_reason: "stop",
						message: { role: "assistant", content: "done" },
					},
				],
			}),
		async (server) => {
			const provider = createProvider(server, { stream: false });
			const response = await provider.generate({
				messages: [{ role: "user", content: "ping" }],
				tools: [],
			});
			assert.equal(response.assistantText, "done");
			assert.equal(response.finishReason, "stop");
			assert.deepEqual(response.toolCalls, []);
		},
	);
});

test("provider parses Responses API output_text", async () => {
	await withServer(
		{ apiFormat: "responses", stream: false },
		() =>
			responsesJson({ status: "completed", output_text: "done", output: [] }),
		async (server) => {
			const provider = createProvider(server, {
				apiFormat: "responses",
				stream: false,
			});
			const response = await provider.generate({
				messages: [{ role: "user", content: "ping" }],
				tools: [],
			});
			assert.equal(response.assistantText, "done");
			assert.equal(response.finishReason, "stop");
			assert.deepEqual(response.toolCalls, []);
		},
	);
});

test("provider parses Responses API text from output message content", async () => {
	await withServer(
		{ apiFormat: "responses", stream: false },
		() =>
			responsesJson({
				status: "completed",
				output_text: null,
				output: [
					{
						type: "message",
						role: "assistant",
						content: [
							{ type: "output_text", text: "one" },
							{ type: "output_text", text: " two" },
						],
					},
				],
			}),
		async (server) => {
			const provider = createProvider(server, {
				apiFormat: "responses",
				stream: false,
			});
			const response = await provider.generate({
				messages: [{ role: "user", content: "ping" }],
				tools: [],
			});
			assert.equal(response.assistantText, "one two");
			assert.equal(response.finishReason, "stop");
		},
	);
});

test("provider parses tool calls from a valid model response (chat)", async () => {
	await withServer(
		{ stream: false },
		() =>
			chatJson({
				choices: [
					{
						finish_reason: "tool_calls",
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: {
										name: "glob",
										arguments: '{"glob":"src/**/*.ts"}',
									},
								},
							],
						},
					},
				],
			}),
		async (server) => {
			const provider = createProvider(server, { stream: false });
			const response = await provider.generate({
				messages: [{ role: "user", content: "calc" }],
				tools: [],
			});
			assert.equal(response.toolCalls[0]?.name, "glob");
			assert.deepEqual(response.toolCalls[0]?.arguments, {
				glob: "src/**/*.ts",
			});
		},
	);
});

test("provider parses Responses API function calls from output", async () => {
	await withServer(
		{ apiFormat: "responses", stream: false },
		() =>
			responsesJson({
				status: "completed",
				output: [
					{
						type: "function_call",
						id: "fc_1",
						call_id: "call_1",
						name: "glob",
						arguments: '{"glob":"src/**/*.ts"}',
					},
				],
			}),
		async (server) => {
			const provider = createProvider(server, {
				apiFormat: "responses",
				stream: false,
			});
			const response = await provider.generate({
				messages: [{ role: "user", content: "calc" }],
				tools: [],
			});
			assert.equal(response.finishReason, "tool_calls");
			assert.equal(response.toolCalls[0]?.id, "call_1");
			assert.equal(response.toolCalls[0]?.name, "glob");
			assert.deepEqual(response.toolCalls[0]?.arguments, {
				glob: "src/**/*.ts",
			});
		},
	);
});

test("provider sends tool results as Responses API function_call_output items", async () => {
	await withServer(
		{ apiFormat: "responses", stream: false },
		() =>
			responsesJson({ status: "completed", output_text: "done", output: [] }),
		async (server) => {
			const provider = createProvider(server, {
				apiFormat: "responses",
				stream: false,
			});
			await provider.generate({
				messages: [
					{
						role: "assistant",
						content: null,
						toolCalls: [
							{
								id: "call_1",
								name: "glob",
								rawArguments: '{"glob":"src/**/*.ts"}',
								arguments: { glob: "src/**/*.ts" },
							},
						],
					},
					{
						role: "tool",
						name: "glob",
						toolCallId: "call_1",
						content: "src/index.ts",
					},
				],
				tools: [],
			});
			const body = server.captured[0]?.body as Record<string, unknown>;
			assert.deepEqual(body.input, [
				{
					type: "function_call",
					call_id: "call_1",
					name: "glob",
					arguments: '{"glob":"src/**/*.ts"}',
				},
				{
					type: "function_call_output",
					call_id: "call_1",
					output: "src/index.ts",
				},
			]);
		},
	);
});

test("provider converts function tools for Responses API requests", async () => {
	await withServer(
		{ apiFormat: "responses", stream: false },
		() =>
			responsesJson({ status: "completed", output_text: "done", output: [] }),
		async (server) => {
			const provider = createProvider(server, {
				apiFormat: "responses",
				stream: false,
			});
			await provider.generate({
				messages: [{ role: "user", content: "find" }],
				tools: [
					{
						type: "function",
						function: {
							name: "glob",
							description: "Find files",
							parameters: {
								type: "object",
								properties: { glob: { type: "string" } },
								required: ["glob"],
							},
						},
					},
				],
			});
			const body = server.captured[0]?.body as Record<string, unknown>;
			assert.deepEqual(body.tools, [
				{
					type: "function",
					name: "glob",
					description: "Find files",
					parameters: {
						type: "object",
						properties: { glob: { type: "string" } },
						required: ["glob"],
					},
				},
			]);
		},
	);
});

test("provider accepts tool call responses that omit message content", async () => {
	await withServer(
		{ stream: false },
		() =>
			chatJson({
				choices: [
					{
						finish_reason: "tool_calls",
						message: {
							role: "assistant",
							reasoning_content: "Need to inspect files first.",
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: {
										name: "glob",
										arguments: '{"path":"","maxResults":50,"glob":"**/*"}',
									},
								},
							],
						},
					},
				],
			}),
		async (server) => {
			const provider = createProvider(server, { stream: false });
			const response = await provider.generate({
				messages: [{ role: "user", content: "inspect" }],
				tools: [],
			});
			assert.equal(response.assistantText, null);
			assert.equal(response.finishReason, "tool_calls");
			assert.equal(response.toolCalls[0]?.name, "glob");
			assert.deepEqual(response.toolCalls[0]?.arguments, {
				path: "",
				maxResults: 50,
				glob: "**/*",
			});
		},
	);
});

test("provider preserves invalid tool arguments for downstream tool failure", async () => {
	await withServer(
		{ stream: false },
		() =>
			chatJson({
				choices: [
					{
						finish_reason: "tool_calls",
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: { name: "bash", arguments: '"not-an-object"' },
								},
							],
						},
					},
				],
			}),
		async (server) => {
			const provider = createProvider(server, { stream: false });
			const response = await provider.generate({
				messages: [{ role: "user", content: "bad args" }],
				tools: [],
			});
			assert.equal(response.toolCalls[0]?.rawArguments, '"not-an-object"');
			assert.match(
				response.toolCalls[0]?.argumentParseError ?? "",
				/Model returned invalid tool arguments/,
			);
		},
	);
});

test("provider surfaces non-2xx errors with status and body preview", async () => {
	await withServer(
		{ stream: false },
		() => ({
			kind: "error",
			status: 502,
			statusText: "Bad Gateway",
			body: "upstream failed",
		}),
		async (server) => {
			const provider = createProvider(server, { stream: false, maxRetries: 0 });
			await assert.rejects(
				() =>
					provider.generate({
						messages: [{ role: "user", content: "fail" }],
						tools: [],
					}),
				/error: Model request failed: 502 Bad Gateway \| upstream failed/i,
			);
		},
	);
});

test("provider times out a hung server via the idle/stall timer", async () => {
	await withServer(
		{ stream: false, timeoutMs: 200 },
		() => ({ kind: "hang" }),
		async (server) => {
			const provider = createProvider(server, {
				stream: false,
				timeoutMs: 200,
			});
			await assert.rejects(
				() =>
					provider.generate({
						messages: [{ role: "user", content: "wait" }],
						tools: [],
					}),
				/timed out after 200ms/,
			);
		},
	);
});

test("provider retries timeout failures up to maxRetries and then succeeds", async () => {
	await withServer(
		{ stream: false, timeoutMs: 20, maxRetries: 2 },
		(seen) => {
			if (seen.length < 3) {
				return { kind: "hang" };
			}
			return chatJson({
				choices: [{ message: { role: "assistant", content: "ok" } }],
			});
		},
		async (server) => {
			const provider = createProvider(server, {
				stream: false,
				timeoutMs: 20,
				maxRetries: 2,
			});
			const response = await provider.generate({
				messages: [{ role: "user", content: "retry timeout" }],
				tools: [],
			});
			assert.equal(response.assistantText, "ok");
			assert.equal(server.captured.length, 3);
		},
	);
});

test("provider rejects empty choices responses", async () => {
	await withServer(
		{ stream: false },
		() => chatJson({ choices: [] }),
		async (server) => {
			const provider = createProvider(server, { stream: false });
			await assert.rejects(
				() =>
					provider.generate({
						messages: [{ role: "user", content: "empty" }],
						tools: [],
					}),
				/choices array is empty/,
			);
		},
	);
});

test("provider rejects missing choices[0].message", async () => {
	await withServer(
		{ stream: false },
		() => chatJson({ choices: [{}] }),
		async (server) => {
			const provider = createProvider(server, { stream: false });
			await assert.rejects(
				() =>
					provider.generate({
						messages: [{ role: "user", content: "missing message" }],
						tools: [],
					}),
				/missing choices\[0\]\.message/,
			);
		},
	);
});

test("provider surfaces chat completions usage when the API reports it", async () => {
	await withServer(
		{ stream: false },
		() =>
			chatJson({
				choices: [
					{
						finish_reason: "stop",
						message: { role: "assistant", content: "done" },
					},
				],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 25,
					total_tokens: 125,
					prompt_tokens_details: { cached_tokens: 40 },
				},
			}),
		async (server) => {
			const provider = createProvider(server, { stream: false });
			const response = await provider.generate({
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			});
			assert.deepEqual(response.usage, {
				input: 100,
				output: 25,
				cacheRead: 40,
				cacheWrite: 0,
				totalTokens: 125,
			});
		},
	);
});

test("provider surfaces Responses API usage when the API reports it", async () => {
	await withServer(
		{ apiFormat: "responses", stream: false },
		() =>
			responsesJson({
				status: "completed",
				output_text: "ok",
				output: [],
				usage: {
					input_tokens: 200,
					output_tokens: 30,
					total_tokens: 230,
					input_tokens_details: { cached_tokens: 75 },
				},
			}),
		async (server) => {
			const provider = createProvider(server, {
				apiFormat: "responses",
				stream: false,
			});
			const response = await provider.generate({
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			});
			assert.deepEqual(response.usage, {
				input: 200,
				output: 30,
				cacheRead: 75,
				cacheWrite: 0,
				totalTokens: 230,
			});
		},
	);
});

test("provider returns no usage when the API omits the usage field", async () => {
	await withServer(
		{ stream: false },
		() =>
			chatJson({
				choices: [
					{
						finish_reason: "stop",
						message: { role: "assistant", content: "ok" },
					},
				],
			}),
		async (server) => {
			const provider = createProvider(server, { stream: false });
			const response = await provider.generate({
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			});
			assert.equal(response.usage, undefined);
		},
	);
});

test("provider ignores non-finite usage numbers without throwing", async () => {
	await withServer(
		{ stream: false },
		() =>
			chatJson({
				choices: [
					{
						finish_reason: "stop",
						message: { role: "assistant", content: "ok" },
					},
				],
				usage: {
					prompt_tokens: "lots",
					completion_tokens: -1,
					total_tokens: NaN,
				},
			}),
		async (server) => {
			const provider = createProvider(server, { stream: false });
			const response = await provider.generate({
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			});
			assert.equal(response.usage, undefined);
		},
	);
});

test("provider logs terminal failures as model_request_failed with failureType", async () => {
	await withServer(
		{ stream: false },
		() => ({
			kind: "error",
			status: 429,
			body: JSON.stringify({ error: { message: "Too many requests" } }),
		}),
		async (server) => {
			const logger = new MemoryLogger();
			const provider = createProvider(
				server,
				{ stream: false, maxRetries: 0 },
				logger,
			);
			await assert.rejects(
				() =>
					provider.generate({
						messages: [{ role: "user", content: "retry" }],
						tools: [],
						context: { runId: "run-1", turnId: "turn-1", purpose: "turn" },
					}),
				/429 Too Many Requests/,
			);
			const failed = logger.entries.find(
				(entry) => entry.event === "model_request_failed",
			);
			assert.ok(failed, "model_request_failed was logged");
			assert.equal(failed?.fields?.failureType, "http_error");
			assert.equal(failed?.fields?.httpStatus, 429);
			assert.equal(failed?.fields?.sdkErrorType, "RateLimitError");
		},
	);
});

test("provider streams chat completions through the SDK and emits turn progress + deltas", async () => {
	const frames = [
		chatFrame({ content: "hel" }),
		chatFrame({ content: "lo" }),
		chatFrame({}, "stop"),
		SSE_DONE,
	];
	await withServer(
		{ timeoutMs: 2000 },
		() => ({ kind: "sse", frames }),
		async (server) => {
			const logger = new MemoryLogger();
			const provider = createProvider(server, {}, logger);
			const deltas: string[] = [];
			const response = await provider.generate(
				{ messages: [{ role: "user", content: "hi" }], tools: [] },
				(delta) => {
					if (delta.contentDelta) deltas.push(delta.contentDelta);
				},
			);
			assert.equal(response.assistantText, "hello");
			assert.equal(response.finishReason, "stop");
			assert.deepEqual(deltas, ["hel", "lo"]);
			assert.ok(
				logger.entries.some((e) => e.event === "model_request_started"),
				"model_request_started fired",
			);
			assert.ok(
				logger.entries.some((e) => e.event === "model_request_succeeded"),
				"model_request_succeeded fired",
			);
			assert.equal(server.captured[0]?.url, "/v1/chat/completions");
		},
	);
});

test("provider streams Responses API through the SDK", async () => {
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
		{ apiFormat: "responses", timeoutMs: 2000 },
		() => ({ kind: "sse", frames }),
		async (server) => {
			const provider = createProvider(server, { apiFormat: "responses" });
			const response = await provider.generate({
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			});
			assert.equal(response.assistantText, "hello");
			assert.equal(response.finishReason, "stop");
			assert.equal(server.captured[0]?.url, "/v1/responses");
		},
	);
});

test("ESC during a hung turn re-throws TurnInterruptedError and is not retried", async () => {
	const { TurnInterruptedError } = await import("../src/interrupt.js");
	const firstFrame = chatFrame({ content: "x" });
	const controller = new AbortController();
	await withServer(
		{ timeoutMs: 5000, maxRetries: 2 },
		() => ({
			kind: "sse",
			frames: [firstFrame],
			stallAfterFirstFrame: true,
		}),
		async (server) => {
			const provider = createProvider(server, {
				timeoutMs: 5000,
				maxRetries: 2,
			});
			const run = provider.generate({
				messages: [{ role: "user", content: "hang" }],
				tools: [],
				abortSignal: controller.signal,
			});
			setTimeout(
				() =>
					controller.abort(new TurnInterruptedError("user_escape", "model")),
				10,
			);
			await assert.rejects(
				() => run,
				(error) => error instanceof TurnInterruptedError,
			);
			// The interrupt must not be retried.
			assert.equal(server.captured.length, 1);
		},
	);
});

test("provider clamps an oversized max_tokens to the remaining context fit (chat)", async () => {
	await withServer(
		{ stream: false, hardContextLimit: 8192 },
		() =>
			chatJson({
				choices: [{ message: { role: "assistant", content: "ok" } }],
			}),
		async (server) => {
			const provider = createProvider(server, {
				stream: false,
				hardContextLimit: 8192,
			});
			const request: ModelRequest = {
				messages: [{ role: "user", content: "hi" }],
				tools: [],
				maxTokens: 100_000,
			};
			await provider.generate(request);
			const body = server.captured[0]?.body as Record<string, unknown>;
			assert.equal(body.max_tokens, clampMaxTokens(request, 8192));
			assert.ok(
				(body.max_tokens as number) < 100_000,
				"oversized max_tokens is clamped below the request",
			);
		},
	);
});

test("provider bounds max_tokens to the context fit when max_tokens is unset (chat)", async () => {
	await withServer(
		{ stream: false, hardContextLimit: 8192 },
		() =>
			chatJson({
				choices: [{ message: { role: "assistant", content: "ok" } }],
			}),
		async (server) => {
			const provider = createProvider(server, {
				stream: false,
				hardContextLimit: 8192,
			});
			const request: ModelRequest = {
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			};
			await provider.generate(request);
			const body = server.captured[0]?.body as Record<string, unknown>;
			// Outbound max_tokens is always set (never undefined) and equals the
			// remaining-context cap.
			assert.equal(body.max_tokens, clampMaxTokens(request, 8192));
			assert.ok(Number.isFinite(body.max_tokens as number));
		},
	);
});

test("provider clamps an oversized max_tokens on the responses API (max_output_tokens)", async () => {
	await withServer(
		{ apiFormat: "responses", stream: false, hardContextLimit: 8192 },
		() => responsesJson({ status: "completed", output_text: "ok", output: [] }),
		async (server) => {
			const provider = createProvider(server, {
				apiFormat: "responses",
				stream: false,
				hardContextLimit: 8192,
			});
			const request: ModelRequest = {
				messages: [{ role: "user", content: "hi" }],
				tools: [],
				maxTokens: 100_000,
			};
			await provider.generate(request);
			const body = server.captured[0]?.body as Record<string, unknown>;
			assert.equal(body.max_output_tokens, clampMaxTokens(request, 8192));
			assert.ok(
				(body.max_output_tokens as number) < 100_000,
				"oversized max_output_tokens is clamped below the request",
			);
		},
	);
});

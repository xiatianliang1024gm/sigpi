import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfig } from "../src/config.js";
import { OpenAICompatibleProvider } from "../src/model/openai-compatible.js";
import { MemoryLogger } from "./helpers.js";

test("provider appends chat completions path when base URL ends at /v1", async () => {
	await withMockFetch(
		async (input) => {
			assert.equal(input, "https://example.test/v1/chat/completions");
			return jsonResponse({
				choices: [{ message: { role: "assistant", content: "ok" } }],
			});
		},
		async () => {
			const provider = new OpenAICompatibleProvider({
				baseURL: "https://example.test/v1",
				apiKey: "secret",
				name: "demo",
				apiFormat: "chat_completions",
				stream: true,
				timeoutMs: 100,
				maxRetries: 0,
				retryBaseDelayMs: 1,
			});
			const response = await provider.generate({
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			});
			assert.equal(response.assistantText, "ok");
		},
	);
});

test("provider appends responses path when configured for Responses API", async () => {
	await withMockFetch(
		async (input, init) => {
			assert.equal(input, "https://example.test/v1/responses");
			assert.deepEqual(parseRequestBody(init), {
				model: "demo",
				stream: true,
				input: [
					{
						type: "message",
						role: "user",
						content: "hi",
					},
				],
			});
			return jsonResponse({
				status: "completed",
				output_text: "ok",
				output: [],
			});
		},
		async () => {
			const provider = new OpenAICompatibleProvider({
				baseURL: "https://example.test/v1",
				apiKey: "secret",
				name: "demo",
				apiFormat: "responses",
				stream: true,
				timeoutMs: 100,
				maxRetries: 0,
				retryBaseDelayMs: 1,
			});
			const response = await provider.generate({
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			});
			assert.equal(response.assistantText, "ok");
			assert.equal(response.finishReason, "stop");
		},
	);
});

test("provider returns a direct assistant response on 2xx JSON", async () => {
	await withMockFetch(
		async () =>
			jsonResponse({
				choices: [
					{
						finish_reason: "stop",
						message: { role: "assistant", content: "done" },
					},
				],
			}),
		async () => {
			const provider = createProvider();
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
	await withMockFetch(
		async () =>
			jsonResponse({
				status: "completed",
				output_text: "done",
				output: [],
			}),
		async () => {
			const response = await createProvider({
				apiFormat: "responses",
			}).generate({
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
	await withMockFetch(
		async () =>
			jsonResponse({
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
		async () => {
			const response = await createProvider({
				apiFormat: "responses",
			}).generate({
				messages: [{ role: "user", content: "ping" }],
				tools: [],
			});
			assert.equal(response.assistantText, "one two");
			assert.equal(response.finishReason, "stop");
		},
	);
});

test("provider parses tool calls from a valid model response", async () => {
	await withMockFetch(
		async () =>
			jsonResponse({
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
		async () => {
			const response = await createProvider().generate({
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
	await withMockFetch(
		async () =>
			jsonResponse({
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
		async () => {
			const response = await createProvider({
				apiFormat: "responses",
			}).generate({
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
	await withMockFetch(
		async (_input, init) => {
			assert.deepEqual(parseRequestBody(init).input, [
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
			return jsonResponse({
				status: "completed",
				output_text: "done",
				output: [],
			});
		},
		async () => {
			await createProvider({
				apiFormat: "responses",
			}).generate({
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
		},
	);
});

test("provider converts function tools for Responses API requests without strict by default", async () => {
	await withMockFetch(
		async (_input, init) => {
			assert.deepEqual(parseRequestBody(init).tools, [
				{
					type: "function",
					name: "glob",
					description: "Find files",
					parameters: {
						type: "object",
						properties: {
							glob: { type: "string" },
						},
						required: ["glob"],
					},
				},
			]);
			return jsonResponse({
				status: "completed",
				output_text: "done",
				output: [],
			});
		},
		async () => {
			await createProvider({
				apiFormat: "responses",
			}).generate({
				messages: [{ role: "user", content: "find" }],
				tools: [
					{
						type: "function",
						function: {
							name: "glob",
							description: "Find files",
							parameters: {
								type: "object",
								properties: {
									glob: { type: "string" },
								},
								required: ["glob"],
							},
						},
					},
				],
			});
		},
	);
});

test("provider accepts tool call responses that omit message content", async () => {
	await withMockFetch(
		async () =>
			jsonResponse({
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
		async () => {
			const response = await createProvider().generate({
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
	await withMockFetch(
		async () =>
			jsonResponse({
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
										name: "bash",
										arguments: '"not-an-object"',
									},
								},
							],
						},
					},
				],
			}),
		async () => {
			const response = await createProvider().generate({
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
	await withMockFetch(
		async () =>
			new Response("upstream failed", {
				status: 502,
				statusText: "Bad Gateway",
			}),
		async () => {
			await assert.rejects(
				() =>
					createProvider().generate({
						messages: [{ role: "user", content: "fail" }],
						tools: [],
					}),
				/error: Model request failed: 502 Bad Gateway \| upstream failed/i,
			);
		},
	);
});

test("provider times out aborted fetch requests", async () => {
	await withMockFetch(
		(_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("This operation was aborted", "AbortError"));
				});
			}),
		async () => {
			const provider = createProvider({ timeoutMs: 5 });
			await assert.rejects(
				() =>
					provider.generate({
						messages: [{ role: "user", content: "wait" }],
						tools: [],
					}),
				/timed out after 5ms/,
			);
		},
	);
});

test("provider retries timeout failures up to maxRetries and then succeeds", async () => {
	let attempts = 0;

	await withMockFetch(
		async (_input, init) => {
			attempts += 1;

			if (attempts < 3) {
				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(
							new DOMException("This operation was aborted", "AbortError"),
						);
					});
				});
			}

			return jsonResponse({
				choices: [{ message: { role: "assistant", content: "ok" } }],
			});
		},
		async () => {
			const provider = createProvider({
				timeoutMs: 5,
				maxRetries: 2,
				retryBaseDelayMs: 1,
			});
			const response = await provider.generate({
				messages: [{ role: "user", content: "retry timeout" }],
				tools: [],
			});

			assert.equal(response.assistantText, "ok");
			assert.equal(attempts, 3);
		},
	);
});

test("provider rejects empty choices responses", async () => {
	await withMockFetch(
		async () => jsonResponse({ choices: [] }),
		async () => {
			await assert.rejects(
				() =>
					createProvider().generate({
						messages: [{ role: "user", content: "empty" }],
						tools: [],
					}),
				/choices array is empty/,
			);
		},
	);
});

test("provider rejects missing choices[0].message", async () => {
	await withMockFetch(
		async () => jsonResponse({ choices: [{}] }),
		async () => {
			await assert.rejects(
				() =>
					createProvider().generate({
						messages: [{ role: "user", content: "missing message" }],
						tools: [],
					}),
				/missing choices\[0\]\.message/,
			);
		},
	);
});

test("provider rejects non-JSON response bodies", async () => {
	await withMockFetch(
		async () =>
			new Response("<html>nope</html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		async () => {
			await assert.rejects(
				() =>
					createProvider().generate({
						messages: [{ role: "user", content: "html" }],
						tools: [],
					}),
				/not valid JSON/,
			);
		},
	);
});

test("provider logs terminal failures as model_request_failed", async () => {
	await withMockFetch(
		async () =>
			new Response("rate limited", {
				status: 429,
				statusText: "Too Many Requests",
			}),
		async () => {
			const logger = new MemoryLogger();
			const provider = createProvider({ maxRetries: 0 }, logger);
			await assert.rejects(
				() =>
					provider.generate({
						messages: [{ role: "user", content: "retry" }],
						tools: [],
						context: { runId: "run-1", turnId: "turn-1", purpose: "turn" },
					}),
				/429 Too Many Requests/,
			);
			assert.equal(
				logger.entries.some((entry) => entry.event === "model_request_failed"),
				true,
			);
		},
	);
});

test("provider reports body_read_failed when the response body cannot be read (non-retryable on 2xx)", async () => {
	let calls = 0;
	await withMockFetch(
		async () => {
			calls += 1;
			return {
				status: 200,
				statusText: "OK",
				ok: true,
				text: async () => {
					throw new Error("stream broke");
				},
			} as unknown as Response;
		},
		async () => {
			const logger = new MemoryLogger();
			const provider = createProvider({ maxRetries: 2 }, logger);
			await assert.rejects(
				() =>
					provider.generate({
						messages: [{ role: "user", content: "x" }],
						tools: [],
					}),
				/could not be read/,
			);
			assert.equal(calls, 1);
			const failed = logger.entries.find(
				(entry) => entry.event === "model_request_failed",
			);
			assert.ok(failed);
			assert.equal(failed?.fields?.failureType, "body_read_failed");
			assert.equal(failed?.fields?.httpStatus, 200);
			assert.equal(failed?.fields?.bodyByteLength, 0);
			assert.match(String(failed?.fields?.bodyReadError), /stream broke/);
		},
	);
});

test("provider retries body_read_failed on 5xx and then succeeds", async () => {
	let calls = 0;
	await withMockFetch(
		async () => {
			calls += 1;
			if (calls < 2) {
				return {
					status: 502,
					statusText: "Bad Gateway",
					ok: false,
					text: async () => {
						throw new Error("stream broke");
					},
				} as unknown as Response;
			}

			return jsonResponse({
				choices: [{ message: { role: "assistant", content: "ok" } }],
			});
		},
		async () => {
			const provider = createProvider({ maxRetries: 2, retryBaseDelayMs: 1 });
			const response = await provider.generate({
				messages: [{ role: "user", content: "x" }],
				tools: [],
			});
			assert.equal(response.assistantText, "ok");
			assert.equal(calls, 2);
		},
	);
});

test("provider reports empty_response for an empty 200 body (non-retryable)", async () => {
	let calls = 0;
	await withMockFetch(
		async () => {
			calls += 1;
			return new Response("", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
		async () => {
			const logger = new MemoryLogger();
			const provider = createProvider({ maxRetries: 2 }, logger);
			await assert.rejects(
				() =>
					provider.generate({
						messages: [{ role: "user", content: "x" }],
						tools: [],
					}),
				/body was empty/,
			);
			assert.equal(calls, 1);
			const failed = logger.entries.find(
				(entry) => entry.event === "model_request_failed",
			);
			assert.equal(failed?.fields?.failureType, "empty_response");
			assert.equal(failed?.fields?.bodyByteLength, 0);
		},
	);
});

test("provider reports invalid_json with a body preview for malformed bodies", async () => {
	let calls = 0;
	await withMockFetch(
		async () => {
			calls += 1;
			return new Response("<html>nope</html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		},
		async () => {
			const logger = new MemoryLogger();
			const provider = createProvider({ maxRetries: 2 }, logger);
			await assert.rejects(
				() =>
					provider.generate({
						messages: [{ role: "user", content: "x" }],
						tools: [],
					}),
				/not valid JSON/,
			);
			assert.equal(calls, 1);
			const failed = logger.entries.find(
				(entry) => entry.event === "model_request_failed",
			);
			assert.equal(failed?.fields?.failureType, "invalid_json");
			assert.equal(failed?.fields?.bodyByteLength, "<html>nope</html>".length);
			assert.equal(failed?.fields?.bodyPreview, "<html>nope</html>");
		},
	);
});

function createProvider(
	overrides: Partial<
		ConstructorParameters<typeof OpenAICompatibleProvider>[0]
	> = {},
	logger = new MemoryLogger(),
): OpenAICompatibleProvider {
	return new OpenAICompatibleProvider(
		{
			baseURL: "https://example.test",
			apiKey: "secret",
			name: "demo-model",
			apiFormat: "chat_completions",
			stream: true,
			timeoutMs: 25,
			maxRetries: 0,
			retryBaseDelayMs: 1,
			...overrides,
		} as ModelConfig,
		logger,
	);
}

async function withMockFetch(
	mock: typeof fetch,
	callback: () => Promise<void>,
): Promise<void> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = mock;
	try {
		await callback();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

function parseRequestBody(
	init: RequestInit | undefined,
): Record<string, unknown> {
	const body = init?.body;
	if (typeof body !== "string") {
		throw new TypeError("Expected JSON request body string.");
	}
	return JSON.parse(body) as Record<string, unknown>;
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: {
			"content-type": "application/json",
		},
	});
}

test("provider surfaces chat completions usage when the API reports it", async () => {
	await withMockFetch(
		async () =>
			jsonResponse({
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
		async () => {
			const provider = createProvider();
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
	await withMockFetch(
		async () =>
			jsonResponse({
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
		async () => {
			const provider = createProvider({ apiFormat: "responses" });
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
	await withMockFetch(
		async () =>
			jsonResponse({
				choices: [
					{
						finish_reason: "stop",
						message: { role: "assistant", content: "ok" },
					},
				],
			}),
		async () => {
			const provider = createProvider();
			const response = await provider.generate({
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			});
			assert.equal(response.usage, undefined);
		},
	);
});

test("provider ignores non-finite usage numbers without throwing", async () => {
	await withMockFetch(
		async () =>
			jsonResponse({
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
		async () => {
			const provider = createProvider();
			const response = await provider.generate({
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			});
			assert.equal(response.usage, undefined);
		},
	);
});

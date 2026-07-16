import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfig } from "../src/config.js";
import { ModelRequestError, ModelTransport } from "../src/model/transport.js";
import type { ModelRequest } from "../src/types.js";
import {
	type LocalModelServer,
	startLocalModelServer,
} from "./helpers/model-server.js";

function request(
	messages: ModelRequest["messages"] = [{ role: "user", content: "hi" }],
): ModelRequest {
	return { messages, tools: [] };
}

async function withServer(
	configOverrides: Partial<ModelConfig>,
	handler: Parameters<typeof startLocalModelServer>[0],
	fn: (server: LocalModelServer) => Promise<void>,
): Promise<void> {
	const server = await startLocalModelServer(handler, configOverrides);
	try {
		await fn(server);
	} finally {
		await server.close();
	}
}

const nullAdapter = (model = "test-model") => ({
	toParams: (req: ModelRequest) => ({ model, messages: req.messages }),
	parse: (data: unknown) => {
		const choices = (
			data as { choices?: Array<{ message?: { content?: string | null } }> }
		).choices;
		const assistantText = choices?.[0]?.message?.content ?? null;
		return {
			assistantText,
			toolCalls: [],
			finishReason: null,
			usage: undefined,
			rawResponse: data,
		};
	},
	accumulate: () => {},
	onDelta: () => null,
	getPartialView: () => ({
		assistantText: null,
		toolCalls: [],
		finishReason: null,
		usage: undefined,
		rawResponse: undefined,
	}),
	finalize: () => ({
		assistantText: null,
		toolCalls: [],
		finishReason: null,
		usage: undefined,
		rawResponse: undefined,
	}),
});

test("transport returns the parsed response on first success", async () => {
	await withServer(
		{ stream: false },
		() => ({
			kind: "json",
			body: { choices: [{ message: { role: "assistant", content: "ok" } }] },
		}),
		async (server) => {
			const transport = new ModelTransport(server.config, server.client);
			const result = await transport.generate(request(), nullAdapter);
			assert.equal(result.assistantText, "ok");
			assert.equal(server.captured.length, 1);
		},
	);
});

test("transport retries retryable 5xx errors then succeeds", async () => {
	let attempts = 0;
	await withServer(
		{ stream: false },
		() => {
			attempts += 1;
			if (attempts < 2) {
				return { kind: "error", status: 500, body: "boom" };
			}
			return {
				kind: "json",
				body: { choices: [{ message: { role: "assistant", content: "ok" } }] },
			};
		},
		async (server) => {
			const transport = new ModelTransport(
				{ ...server.config, maxRetries: 1 },
				server.client,
			);
			const result = await transport.generate(request(), nullAdapter);
			assert.equal(result.assistantText, "ok");
			assert.equal(attempts, 2);
		},
	);
});

test("transport does not retry non-retryable http errors", async () => {
	await withServer(
		{ stream: false },
		() => ({ kind: "error", status: 400, body: "bad" }),
		async (server) => {
			await assert.rejects(
				() =>
					new ModelTransport(
						{ ...server.config, maxRetries: 3 },
						server.client,
					).generate(request(), nullAdapter),
				(error) =>
					error instanceof ModelRequestError && error.kind === "http_error",
			);
			assert.equal(server.captured.length, 1);
		},
	);
});

test("transport classifies a network failure and retries it", async () => {
	await withServer(
		{ stream: false },
		() => ({ kind: "reset" }),
		async (server) => {
			await assert.rejects(
				() =>
					new ModelTransport(
						{ ...server.config, maxRetries: 1, timeoutMs: 2000 },
						server.client,
					).generate(request(), nullAdapter),
				(error) =>
					error instanceof ModelRequestError && error.kind === "network_error",
			);
			assert.equal(server.captured.length, 2);
		},
	);
});

test("transport classifies an unparseable body as invalid_json without retrying", async () => {
	await withServer(
		{ stream: false },
		() => ({
			kind: "invalidJson",
			status: 200,
			body: "<html>nope</html>",
		}),
		async (server) => {
			await assert.rejects(
				() =>
					new ModelTransport(
						{ ...server.config, maxRetries: 3 },
						server.client,
					).generate(request(), nullAdapter),
				(error) =>
					error instanceof ModelRequestError && error.kind === "invalid_json",
			);
			assert.equal(server.captured.length, 1);
		},
	);
});

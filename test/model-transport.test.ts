import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfig } from "../src/config.js";
import { ModelRequestError, ModelTransport } from "../src/model/transport.js";
import type { WireFormatAdapter } from "../src/model/wire-format.js";
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

const adapter: WireFormatAdapter = {
	buildUrl: () => "https://example.test/v1/chat/completions",
	toRequestBody: (req) => ({ model: "demo", messages: req.messages }),
	parse: (data) => ({
		assistantText: (data as { text?: string }).text ?? null,
		toolCalls: [],
		finishReason: null,
		usage: undefined,
		rawResponse: data,
	}),
	accumulate: () => {},
	finalize: () => ({
		assistantText: null,
		toolCalls: [],
		finishReason: null,
		usage: undefined,
		rawResponse: undefined,
	}),
};

function mockFetch(
	handler: (input: string, init?: { body?: string }) => Promise<Response>,
) {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async (input: unknown, init?: unknown) => {
		calls += 1;
		return handler(input as string, init as { body?: string });
	}) as typeof fetch;
	return {
		get calls() {
			return calls;
		},
		restore() {
			globalThis.fetch = original;
		},
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

test("transport returns the parsed response on first success", async () => {
	const m = mockFetch(async () => jsonResponse({ text: "ok" }));
	try {
		const result = await new ModelTransport(config()).generate(
			request(),
			() => adapter,
		);
		assert.equal(result.assistantText, "ok");
		assert.equal(m.calls, 1);
	} finally {
		m.restore();
	}
});

test("transport retries retryable 5xx errors then succeeds", async () => {
	const m = mockFetch(async () => {
		if (m.calls < 2) {
			return new Response("boom", { status: 500 });
		}
		return jsonResponse({ text: "ok" });
	});
	try {
		const result = await new ModelTransport(config({ maxRetries: 1 })).generate(
			request(),
			() => adapter,
		);
		assert.equal(result.assistantText, "ok");
		assert.equal(m.calls, 2);
	} finally {
		m.restore();
	}
});

test("transport does not retry non-retryable http errors", async () => {
	const m = mockFetch(async () => new Response("bad", { status: 400 }));
	try {
		await assert.rejects(
			() =>
				new ModelTransport(config({ maxRetries: 3 })).generate(
					request(),
					() => adapter,
				),
			(error) =>
				error instanceof ModelRequestError && error.kind === "http_error",
		);
		assert.equal(m.calls, 1);
	} finally {
		m.restore();
	}
});

test("transport classifies a network failure and retries it", async () => {
	const m = mockFetch(async () => {
		throw new Error("connection reset");
	});
	try {
		await assert.rejects(
			() =>
				new ModelTransport(config({ maxRetries: 1 })).generate(
					request(),
					() => adapter,
				),
			(error) =>
				error instanceof ModelRequestError && error.kind === "network_error",
		);
		assert.equal(m.calls, 2);
	} finally {
		m.restore();
	}
});

test("transport classifies an empty body as empty_response without retrying", async () => {
	const m = mockFetch(async () => new Response("", { status: 200 }));
	try {
		await assert.rejects(
			() =>
				new ModelTransport(config({ maxRetries: 3 })).generate(
					request(),
					() => adapter,
				),
			(error) =>
				error instanceof ModelRequestError && error.kind === "empty_response",
		);
		assert.equal(m.calls, 1);
	} finally {
		m.restore();
	}
});

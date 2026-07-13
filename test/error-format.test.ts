import assert from "node:assert/strict";
import test from "node:test";
import { formatModelErrorMessage } from "../src/model/error-format.js";
import { ModelRequestError } from "../src/model/transport.js";

test("network_error maps to an actionable retry message", () => {
	const msg = formatModelErrorMessage(
		new ModelRequestError("x", "network_error"),
	);
	assert.match(msg, /network error/i);
	assert.match(msg, /retry/i);
});

test("stream_error maps to a retry/continue message", () => {
	const msg = formatModelErrorMessage(
		new ModelRequestError("x", "stream_error"),
	);
	assert.match(msg, /stream/i);
	assert.match(msg, /continue/i);
});

test("timeout includes the configured limit", () => {
	const msg = formatModelErrorMessage(
		new ModelRequestError("x", "timeout", { timeoutMs: 60000 }),
	);
	assert.match(msg, /60000/);
});

test("http_error maps by status code", () => {
	assert.match(
		formatModelErrorMessage(
			new ModelRequestError("x", "http_error", { httpStatus: 401 }),
		),
		/Authentication failed/,
	);
	assert.match(
		formatModelErrorMessage(
			new ModelRequestError("x", "http_error", { httpStatus: 429 }),
		),
		/Rate limited/,
	);
	assert.match(
		formatModelErrorMessage(
			new ModelRequestError("x", "http_error", { httpStatus: 503 }),
		),
		/server error/,
	);
});

test("truncated points at the max_tokens limit", () => {
	assert.match(
		formatModelErrorMessage(
			new ModelRequestError("x", "truncated", { finishReason: "length" }),
		),
		/max_tokens/,
	);
});

test("non-ModelRequestError falls back to a generic message", () => {
	assert.match(
		formatModelErrorMessage(new Error("boom")),
		/Request failed: boom/,
	);
	assert.match(formatModelErrorMessage("weird"), /Request failed/);
});

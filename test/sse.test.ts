import assert from "node:assert/strict";
import test from "node:test";
import { encodeSseComment, encodeSseEvent } from "../src/server/sse.js";

test("encodeSseEvent frames a JSON payload as a named SSE event", () => {
	const frame = encodeSseEvent("message", { type: "step_started", step: 2 });
	assert.equal(
		frame,
		'event: message\ndata: {"type":"step_started","step":2}\n\n',
	);
});

test("encodeSseEvent passes string payloads through unchanged", () => {
	assert.equal(encodeSseEvent("ping", "pong"), "event: ping\ndata: pong\n\n");
});

test("encodeSseEvent splits multi-line payloads into data: lines", () => {
	const frame = encodeSseEvent("message", { note: "a\nb" });
	// The literal newline in the JSON must be escaped by JSON.stringify, so the
	// only newline splitting we exercise is a pre-serialized multi-line string.
	const multiline = encodeSseEvent("log", "line1\nline2");
	assert.equal(multiline, "event: log\ndata: line1\ndata: line2\n\n");
	assert.ok(frame.endsWith("\n\n"));
});

test("encodeSseComment emits a comment frame", () => {
	assert.equal(encodeSseComment("connected"), ": connected\n\n");
});

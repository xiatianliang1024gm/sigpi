import assert from "node:assert/strict";
import test from "node:test";
import { parseServeArgs } from "../src/server/serve.js";

test("parseServeArgs defaults to loopback on 7878", () => {
	assert.deepEqual(parseServeArgs([]), { host: "127.0.0.1", port: 7878 });
});

test("parseServeArgs reads host, port, ttl, and max-sessions", () => {
	assert.deepEqual(
		parseServeArgs([
			"--host",
			"0.0.0.0",
			"--port",
			"9000",
			"--idle-ttl",
			"60000",
			"--max-sessions",
			"8",
		]),
		{
			host: "0.0.0.0",
			port: 9000,
			idleTtlMs: 60000,
			maxSessions: 8,
		},
	);
});

test("parseServeArgs rejects invalid numbers and unknown flags", () => {
	assert.throws(() => parseServeArgs(["--port", "nope"]), /--port expects/);
	assert.throws(() => parseServeArgs(["--port", "70000"]), /--port expects/);
	assert.throws(() => parseServeArgs(["--bogus"]), /Unknown serve option/);
});

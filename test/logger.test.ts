import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { resolveDatedLogFilePath, StructuredLogger } from "../src/logger.js";
import { createTempDir } from "./helpers.js";

test("structured logger writes local timestamps with timezone offset", async () => {
	const cwd = await createTempDir("sigpi-logger-");
	const baseLogPath = path.join(cwd, "agent.log");
	const now = new Date(2026, 4, 27, 12, 0, 0);
	const logger = new StructuredLogger({
		level: "info",
		filePath: baseLogPath,
		consoleEnabled: false,
		now: () => now,
	});

	logger.info("demo_event", { value: 1 });

	const logPath = resolveDatedLogFilePath(baseLogPath, now);
	const line = (await readFile(logPath, "utf8")).trim();
	const record = JSON.parse(line) as {
		ts: string;
		event: string;
		value: number;
	};

	assert.equal(record.event, "demo_event");
	assert.equal(record.value, 1);
	assert.match(
		record.ts,
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/,
	);
	assert.equal(record.ts.endsWith("Z"), false);
});

test("structured logger rolls over to a new file when the date changes", async () => {
	const cwd = await createTempDir("sigpi-logger-rollover-");
	const baseLogPath = path.join(cwd, "agent.log");
	let now = new Date(2026, 4, 27, 12, 0, 0);
	const logger = new StructuredLogger({
		level: "info",
		filePath: baseLogPath,
		consoleEnabled: false,
		now: () => now,
	});

	logger.info("day_one");
	now = new Date(2026, 4, 28, 12, 0, 0);
	logger.info("day_two");

	const firstDay = await readFile(
		resolveDatedLogFilePath(baseLogPath, new Date(2026, 4, 27, 12, 0, 0)),
		"utf8",
	);
	const secondDay = await readFile(
		resolveDatedLogFilePath(baseLogPath, new Date(2026, 4, 28, 12, 0, 0)),
		"utf8",
	);

	assert.match(firstDay, /"event":"day_one"/);
	assert.doesNotMatch(firstDay, /"event":"day_two"/);
	assert.match(secondDay, /"event":"day_two"/);
	assert.doesNotMatch(secondDay, /"event":"day_one"/);
});

test("structured logger redacts sensitive fields recursively", async () => {
	const cwd = await createTempDir("sigpi-logger-redact-");
	const baseLogPath = path.join(cwd, "agent.log");
	const now = new Date(2026, 4, 27, 12, 0, 0);
	const logger = new StructuredLogger({
		level: "info",
		filePath: baseLogPath,
		consoleEnabled: false,
		now: () => now,
	});

	logger.info("secret_event", {
		apiKey: "sk-test-secret",
		nested: {
			authorization: "Bearer raw-token",
			message: "token=inline-secret",
		},
	});

	const logPath = resolveDatedLogFilePath(baseLogPath, now);
	const line = (await readFile(logPath, "utf8")).trim();
	const record = JSON.parse(line) as {
		apiKey: string;
		nested: { authorization: string; message: string };
	};

	assert.equal(record.apiKey, "[REDACTED]");
	assert.equal(record.nested.authorization, "[REDACTED]");
	assert.doesNotMatch(line, /sk-test-secret|raw-token|inline-secret/);
});

test("structured logger truncates bodyPreview differently for file vs console", async () => {
	const cwd = await createTempDir("sigpi-logger-preview-");
	const baseLogPath = path.join(cwd, "agent.log");
	const now = new Date(2026, 4, 27, 12, 0, 0);
	const longBody = "x".repeat(1000);
	const consoleLines: string[] = [];
	const originalError = console.error;
	console.error = (line: string) => {
		consoleLines.push(String(line));
	};

	try {
		const logger = new StructuredLogger({
			level: "info",
			filePath: baseLogPath,
			consoleEnabled: true,
			now: () => now,
			maxBodyPreviewChars: 16_000,
			maxConsoleBodyPreviewChars: 50,
		});
		logger.error("model_request_failed", {
			failureType: "invalid_json",
			bodyPreview: longBody,
		});
	} finally {
		console.error = originalError;
	}

	const logPath = resolveDatedLogFilePath(baseLogPath, now);
	const fileLine = (await readFile(logPath, "utf8")).trim();
	const fileRecord = JSON.parse(fileLine) as { bodyPreview: string };
	assert.equal(fileRecord.bodyPreview.length, 1000);

	assert.equal(consoleLines.length, 1);
	const consoleRecord = JSON.parse(
		consoleLines[0].replace("[error] model_request_failed ", ""),
	) as { bodyPreview: string };
	assert.ok(consoleRecord.bodyPreview.length < 1000);
	assert.match(consoleRecord.bodyPreview, /\.\.\.\[truncated\]$/);
});

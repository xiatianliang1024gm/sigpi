import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
	type ChatCommandDefinition,
	createChatCommandDefinitions,
} from "../src/chat-commands.js";
import {
	attachSessionById,
	formatStatusBar,
	formatStatusBarForEvent,
	getResumeAvailability,
	runtimeToChatReplState,
} from "../src/chat-repl.js";
import { createCliProgressReporter, runChatReplLoop } from "../src/cli.js";
import { InputHistory } from "../src/input-history.js";
import { getCurrentPlan, setCurrentPlan } from "../src/plan-tracker.js";
import { createAgentRuntime } from "../src/runtime.js";
import { stripAnsi } from "../src/tui/index.js";
import type { TurnProgressEvent } from "../src/types.js";
import {
	createTempDir,
	createTestSessionStore,
	stripMessageIds,
	writeTestConfig,
} from "./helpers.js";

class FakeInput extends PassThrough {
	public isTTY = true;
	public isRaw = false;
	public paused = false;

	setRawMode(value: boolean): this {
		this.isRaw = value;
		return this;
	}

	override pause(): this {
		this.paused = true;
		return super.pause() as this;
	}

	override resume(): this {
		this.paused = false;
		return super.resume() as this;
	}
}

class FakeOutput extends PassThrough {
	public isTTY = true;
	public columns = 80;
	public rows = 24;
}

function collectOutput(stream: PassThrough): Promise<string> {
	return new Promise((resolve) => {
		let data = "";
		stream.on("data", (chunk) => {
			data += chunk.toString("utf8");
		});
		stream.on("end", () => resolve(data));
	});
}

function getVisibleOutput(output: string): string {
	return stripAnsi(
		output.replace(/\x1B_sigpi:c\x07|\x1B\[\?2004[hl]|\x1B\[\?25h|\n/gu, ""),
	);
}

function setTestHome(homeDir: string): () => void {
	const previousHome = process.env.HOME;
	process.env.HOME = homeDir;

	return () => {
		if (previousHome === undefined) {
			delete process.env.HOME;
			return;
		}

		process.env.HOME = previousHome;
	};
}

function captureConsoleLog(operation: () => void): string[] {
	const originalConsoleLog = console.log;
	const lines: string[] = [];
	console.log = (...values: unknown[]) => {
		lines.push(values.join(" "));
	};
	try {
		operation();
	} finally {
		console.log = originalConsoleLog;
	}
	return lines;
}

test("createCliProgressReporter clear mode prints readable process output", () => {
	const longResult = [
		"TOOL: bash",
		"STATUS: ok",
		"RESULT:",
		"Command: pwd",
		"Mode: workspace_write",
		"Shell: zsh on linux",
		"Command succeeded: yes",
		"Exit code: 0",
		"Signal: (none)",
		"Timed out: no",
		"STDOUT:",
		"=== CONTENT START ===",
		"x".repeat(2400),
		"=== CONTENT END ===",
		"STDERR: (empty)",
	].join("\n");
	const reporter = createCliProgressReporter("detailed");

	const lines = captureConsoleLog(() => {
		reporter({
			type: "turn_started",
			userInput: "inspect the repo",
		});
		reporter({
			type: "assistant_message",
			assistantText: "I will inspect the files first.",
		});
		reporter({
			type: "tool_execution_started",
			toolName: "bash",
			message: "shell pwd",
		});
		reporter({
			type: "tool_execution_finished",
			toolName: "bash",
			toolOk: true,
			toolResult: longResult,
		});
		reporter({
			type: "turn_finished",
			elapsedMs: 1234,
		});
	});
	const visibleLines = lines.map((line) => stripAnsi(line));

	assert.equal(visibleLines[0], "> inspect the repo");
	assert.equal(visibleLines[1], "• Assistant: I will inspect the files first.");
	assert.equal(visibleLines[2], "• Ran shell pwd");
	assert.equal(visibleLines.includes("  TOOL: bash"), false);
	assert.equal(visibleLines.includes("  Command: pwd"), false);
	assert.equal(
		lines.some((line) => line.includes("\x1B[")),
		true,
	);
	assert.equal(
		visibleLines.some((line) => line.includes("[tool result truncated]")),
		true,
	);
	assert.equal(visibleLines.at(-1), "• Done (1234ms)");
});

test("createCliProgressReporter quiet mode preserves minimal agent output", () => {
	const reporter = createCliProgressReporter("compact");

	const lines = captureConsoleLog(() => {
		reporter({
			type: "turn_started",
			userInput: "inspect the repo",
		});
		reporter({
			type: "tool_execution_started",
			toolName: "bash",
			message: "shell pwd",
		});
		reporter({
			type: "tool_execution_finished",
			toolName: "bash",
			toolOk: true,
			toolResult: "TOOL: bash\nSTATUS: ok\nRESULT:\nhello",
		});
		reporter({
			type: "turn_finished",
			elapsedMs: 1234,
		});
	});

	assert.deepEqual(lines, [
		"> inspect the repo",
		"\u23FA\uFE0E Shell pwd",
		"  \u23BF\uFE0E hello",
		"\u2714\uFE0E Done (1.2s)",
	]);
});

test("createCliProgressReporter compact mode groups parallel tool calls from one model response", () => {
	const reporter = createCliProgressReporter("compact");

	const lines = captureConsoleLog(() => {
		reporter({ type: "turn_started", userInput: "check the repo" });
		reporter({
			type: "assistant_message",
			assistantText: "I will inspect a few files first.",
		});
		reporter({ type: "tool_calls_received", toolCallCount: 3 });
		reporter({
			type: "tool_execution_started",
			toolName: "bash",
			message: "shell pwd",
		});
		reporter({
			type: "tool_execution_finished",
			toolName: "bash",
			toolOk: true,
			toolResult: "TOOL: bash\nSTATUS: ok\nRESULT:\nhello1",
		});
		reporter({
			type: "tool_execution_started",
			toolName: "grep",
			message: "grep x",
		});
		reporter({
			type: "tool_execution_finished",
			toolName: "grep",
			toolOk: true,
			toolResult: "RESULT:\nhello2",
		});
		reporter({
			type: "tool_execution_started",
			toolName: "read",
			message: "read f",
		});
		reporter({
			type: "tool_execution_finished",
			toolName: "read",
			toolOk: true,
			toolResult: "RESULT:\nhello3",
		});
		reporter({ type: "turn_finished", elapsedMs: 1234 });
	});
	const visibleLines = lines.map((line) => stripAnsi(line));

	assert.equal(visibleLines[0], "> check the repo");
	assert.ok(
		visibleLines.some((line) =>
			line.includes("I will inspect a few files first."),
		),
		"compact shows the assistant thinking note",
	);
	const shellLine = visibleLines.find((line) => line.includes("Shell pwd"));
	assert.ok(
		shellLine?.startsWith("  "),
		"grouped tool start is indented two spaces",
	);
	assert.ok(
		!shellLine?.startsWith("    "),
		"grouped tool start is not indented four spaces",
	);
	const hello1 = visibleLines.find((line) => line.includes("hello1"));
	assert.ok(
		hello1?.startsWith("    "),
		"grouped tool result is indented four spaces",
	);
	const doneLine = visibleLines.at(-1);
	assert.ok(doneLine?.includes("Done"), "turn still ends with Done");
});

test("createCliProgressReporter clear mode renders file edit diffs from structured results", () => {
	const reporter = createCliProgressReporter("detailed");

	const lines = captureConsoleLog(() => {
		reporter({
			type: "tool_execution_started",
			toolName: "edit",
			message: "edit `.gitignore`",
		});
		reporter({
			type: "tool_execution_finished",
			toolName: "edit",
			toolOk: true,
			toolResult: [
				"TOOL: edit",
				"STATUS: ok",
				"RESULT:",
				"Path: .gitignore",
				"Replacements: 1",
				"Replace all: false",
				"- 1",
			].join("\n"),
			toolResultData: {
				path: ".gitignore",
				replacements: 1,
				editSummary: {
					kind: "file_edit",
					path: ".gitignore",
					paths: [".gitignore"],
					additions: 1,
					deletions: 1,
					preview: [
						{ kind: "remove", lineNumber: 1, text: "old.log" },
						{ kind: "add", lineNumber: 1, text: "new.log" },
					],
					truncated: false,
				},
			},
		});
	});
	const visibleLines = lines.map((line) => stripAnsi(line));

	assert.equal(visibleLines[0], "• Ran edit `.gitignore`");
	assert.equal(visibleLines.includes("  - Edited .gitignore (+1 -1)"), true);
	assert.equal(visibleLines.includes("    1 - old.log"), true);
	assert.equal(visibleLines.includes("    1 + new.log"), true);
	assert.equal(
		visibleLines.some((line) => line.includes("Blocks applied")),
		false,
	);
	assert.equal(
		lines.some((line) => line.includes("\x1B[41m")),
		true,
	);
	assert.equal(
		lines.some((line) => line.includes("\x1B[97m")),
		true,
	);
	assert.equal(
		lines.some((line) => line.includes("\x1B[42m")),
		true,
	);
	assert.equal(
		lines.some((line) => line.includes("\x1B[30m")),
		true,
	);
});

test("createCliProgressReporter clear mode separates tool calls and model runs", () => {
	const reporter = createCliProgressReporter("detailed");

	const lines = captureConsoleLog(() => {
		reporter({
			type: "turn_started",
			userInput: "first request",
		});
		reporter({
			type: "model_request_started",
			step: 1,
		});
		reporter({
			type: "tool_execution_started",
			toolName: "bash",
			message: "shell pwd",
		});
		reporter({
			type: "tool_execution_finished",
			toolName: "bash",
			toolOk: true,
			toolResult:
				"TOOL: bash\nSTATUS: ok\nRESULT:\nSTDOUT: (empty)\nSTDERR: (empty)",
		});
		reporter({
			type: "tool_execution_started",
			toolName: "read",
			message: "read `src/cli.ts`",
		});
		reporter({
			type: "model_request_started",
			step: 2,
		});
	});
	const visibleLines = lines.map((line) => stripAnsi(line));
	const firstToolIndex = visibleLines.indexOf("• Ran shell pwd");
	const secondToolIndex = visibleLines.indexOf("• Ran read `src/cli.ts`");
	const modelDividerIndex = visibleLines.findIndex((line) =>
		line.includes("model run 2"),
	);

	assert.equal(visibleLines[secondToolIndex - 1], "");
	assert.ok(firstToolIndex >= 0);
	assert.ok(secondToolIndex > firstToolIndex);
	assert.ok(modelDividerIndex > secondToolIndex);
	assert.equal(visibleLines[modelDividerIndex]?.length, 80);
});

test("createCliProgressReporter clear mode does not duplicate update_plan content", () => {
	const reporter = createCliProgressReporter("detailed");
	const planDetail = [
		"1. ✅ 运行 pnpm run release:check（lint + 测试 + 打包冒烟测试）",
		"2. ✅ 运行 bash scripts/release.sh 发布新版本",
	].join("\n");
	const planResult = [
		"TOOL: update_plan",
		"STATUS: ok",
		"RESULT:",
		"Plan:",
		"1. ✅ 运行 pnpm run release:check（lint + 测试 + 打包冒烟测试）",
		"2. ✅ 运行 bash scripts/release.sh 发布新版本",
	].join("\n");

	const lines = captureConsoleLog(() => {
		reporter({
			type: "tool_execution_started",
			toolName: "update_plan",
			message: "plan",
			detail: planDetail,
		});
		reporter({
			type: "tool_execution_finished",
			toolName: "update_plan",
			toolOk: true,
			toolResult: planResult,
		});
	});
	const visibleLines = lines.map((line) => stripAnsi(line));

	assert.equal(visibleLines[0], "• Ran plan");
	assert.equal(visibleLines[1], `  ${planDetail.split("\n")[0]}`);
	assert.equal(visibleLines[2], `  ${planDetail.split("\n")[1]}`);
	// The plan content should not be duplicated in tool_execution_finished.
	assert.equal(
		visibleLines.some((line) => line.includes("Plan:")),
		false,
	);
});

test("createCliProgressReporter clears a completed plan at turn start", () => {
	const reporter = createCliProgressReporter("detailed");
	setCurrentPlan({
		explanation: null,
		items: [
			{ step: "Done one", status: "completed" },
			{ step: "Done two", status: "completed" },
		],
		updatedAt: new Date().toISOString(),
	});

	try {
		const lines = captureConsoleLog(() => {
			reporter({ type: "turn_started" });
		});
		const visibleLines = lines.map((line) => stripAnsi(line));

		assert.equal(getCurrentPlan(), null);
		assert.equal(
			visibleLines.some((line) => line.includes("Plan")),
			false,
		);
		assert.equal(
			visibleLines.some((line) => line.includes("Done one")),
			false,
		);
	} finally {
		setCurrentPlan(null);
	}
});

test("runtimeToChatReplState clears a plan left over from a previous session", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-plan-clear-"),
	);
	const previousCwd = process.cwd();
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		setCurrentPlan({
			explanation: null,
			items: [{ step: "Old step", status: "in_progress" }],
			updatedAt: new Date().toISOString(),
		});
		assert.ok(getCurrentPlan());

		const runtime = await createAgentRuntime({ createSession: true });
		runtimeToChatReplState(runtime);

		assert.equal(getCurrentPlan(), null);
	} finally {
		setCurrentPlan(null);
		process.chdir(previousCwd);
	}
});

test("formatStatusBar includes model, chars, and cwd", async () => {
	const cwd = await realpath(await createTempDir("sigpi-chat-repl-status-"));
	const homeDir = await createTempDir("sigpi-chat-repl-status-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);
		const status = formatStatusBar(state);

		assert.match(status, new RegExp(`model ${runtime.config.model.name}`));
		assert.match(
			status,
			/(?:chars|tokens) \d+(?:\.\d+)?[KMB]?\/(?:~)?\d+(?:\.\d+)?[KMB]? \(\d+%\)/,
		);
		assert.match(status, /\| .*sigpi-chat-repl-status-/);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBarForEvent appends progress state", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-event-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-status-event-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);
		const status = formatStatusBarForEvent(state, {
			type: "model_request_started",
			step: 2,
		});

		assert.match(status, /thinking$/);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBarForEvent uses live context token estimate (default unit)", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-live-tokens-"),
	);
	const homeDir = await createTempDir(
		"sigpi-chat-repl-status-live-tokens-home-",
	);
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);
		const status = formatStatusBarForEvent(state, {
			type: "model_request_finished",
			estimatedContextTokens: 12_345,
		});

		assert.match(status, /tokens 12\.3K\//);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBar shows tokens and (contextWindow-reserveTokens) limit", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-tokens-mode-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-tokens-mode-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);
		const status = formatStatusBar(state);
		assert.match(status, /tokens \d+(?:\.\d+)?[KMB]?\/183\.6K \(\d+%\)/);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBarForEvent uses event token estimate when available", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-event-tokens-"),
	);
	const homeDir = await createTempDir(
		"sigpi-chat-repl-status-event-tokens-home-",
	);
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);
		const status = formatStatusBarForEvent(state, {
			type: "model_request_finished",
			estimatedContextTokens: 12_345,
		});

		assert.match(status, /tokens 12\.3K\//);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBarForEvent recomputes from state when event has no token estimate", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-event-fallback-"),
	);
	const homeDir = await createTempDir(
		"sigpi-chat-repl-status-event-fallback-home-",
	);
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);
		const status = formatStatusBarForEvent(state, {
			type: "turn_started",
			userInput: "hi",
		});
		// Falls back to recomputing from state via estimateContextTokens.
		assert.match(status, /^model /);
		assert.match(
			status,
			/tokens \d+(?:\.\d+)?[KMB]?\/\d+(?:\.\d+)?[KMB]? \(\d+%\)/,
		);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("attachSessionById hydrates context from the selected session snapshot", async () => {
	const cwd = await realpath(await createTempDir("sigpi-chat-repl-"));
	const homeDir = await createTempDir("sigpi-chat-repl-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const bootstrapRuntime = await createAgentRuntime();
		const store = createTestSessionStore({ cwd, homeDir });
		const session = await store.createSession({
			cwd,
			systemPromptFingerprint: bootstrapRuntime.systemPromptFingerprint,
			loadedSkillNames: [],
			skillsFingerprint: null,
		});

		await store.markTurnStarted({
			sessionId: session.sessionId,
			userInput: "inspect repo",
		});
		await store.markTurnCompleted({
			sessionId: session.sessionId,
			userInput: "inspect repo",
			assistantOutput: "done",
			steps: 1,
			toolExecutions: [],
			contextState: {
				summary: "conversation summary",
				recentMessages: [
					{ role: "user", content: "inspect repo" },
					{ role: "assistant", content: "done" },
				],
			},
		});

		const attached = await attachSessionById(session.sessionId);

		assert.equal(
			attached.updatedState.runtime.turn.getCurrentSession().sessionId,
			session.sessionId,
		);
		assert.equal(
			attached.updatedState.runtime.context.getSummary(),
			"conversation summary",
		);
		assert.deepEqual(
			stripMessageIds(
				attached.updatedState.runtime.context.getRecentMessages(),
			),
			[
				{ role: "user", content: "inspect repo" },
				{ role: "assistant", content: "done" },
			],
		);
		assert.deepEqual(attached.warnings, []);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("attachSessionById returns interrupted and system prompt warnings from session restore", async () => {
	const cwd = await realpath(await createTempDir("sigpi-chat-repl-warnings-"));
	const homeDir = await createTempDir("sigpi-chat-repl-warnings-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const store = createTestSessionStore({ cwd, homeDir });
		const session = await store.createSession({
			cwd,
			systemPromptFingerprint: "older-system-prompt-fingerprint",
			loadedSkillNames: [],
			skillsFingerprint: null,
		});

		await store.markTurnStarted({
			sessionId: session.sessionId,
			userInput: "unfinished task",
		});

		const attached = await attachSessionById(session.sessionId);

		assert.equal(
			attached.updatedState.runtime.turn.getCurrentSession().status,
			"interrupted",
		);
		assert.equal(attached.warnings.length, 2);
		assert.match(
			attached.warnings[0] ?? "",
			/restored the last completed turn only/i,
		);
		assert.match(attached.warnings[1] ?? "", /System prompt has changed/i);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("resume remains available when chat is already attached to a session", async () => {
	const cwd = await realpath(await createTempDir("sigpi-chat-repl-blocked-"));
	const homeDir = await createTempDir("sigpi-chat-repl-blocked-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const bootstrapRuntime = await createAgentRuntime();
		const store = createTestSessionStore({ cwd, homeDir });
		const session = await store.createSession({
			cwd,
			systemPromptFingerprint: bootstrapRuntime.systemPromptFingerprint,
			loadedSkillNames: [],
			skillsFingerprint: null,
		});

		const runtime = await createAgentRuntime({
			sessionId: session.sessionId,
		});
		const availability = getResumeAvailability(runtimeToChatReplState(runtime));

		assert.deepEqual(availability, { ok: true });
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("createAgentRuntime creates a session when requested without a session id", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-default-session-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-default-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({
			createSession: true,
		});

		assert.ok(runtime.sessionRuntime);
		assert.ok(runtime.session);
		assert.equal(runtime.session?.turnCount, 0);
		assert.equal(
			runtime.sessionRuntime?.getCurrentSession().sessionId,
			runtime.session?.sessionId,
		);

		const sessions = await runtime.store.listSessions();
		assert.equal(sessions.length, 1);
		assert.equal(sessions[0]?.sessionId, runtime.session?.sessionId);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("attachSessionById can switch from one bound session to another", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-switch-session-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-switch-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const bootstrapRuntime = await createAgentRuntime();
		const store = createTestSessionStore({ cwd, homeDir });
		const first = await store.createSession({
			cwd,
			systemPromptFingerprint: bootstrapRuntime.systemPromptFingerprint,
			title: "first session",
		});
		const second = await store.createSession({
			cwd,
			systemPromptFingerprint: bootstrapRuntime.systemPromptFingerprint,
			title: "second session",
		});

		await store.markTurnStarted({
			sessionId: second.sessionId,
			userInput: "switch here",
		});
		await store.markTurnCompleted({
			sessionId: second.sessionId,
			userInput: "switch here",
			assistantOutput: "done",
			steps: 1,
			toolExecutions: [],
			contextState: {
				summary: "second session summary",
				recentMessages: [
					{ role: "user", content: "switch here" },
					{ role: "assistant", content: "done" },
				],
			},
		});

		const initial = await createAgentRuntime({
			sessionId: first.sessionId,
		});
		const switched = await attachSessionById(second.sessionId);

		assert.equal(
			initial.sessionRuntime?.getCurrentSession().sessionId,
			first.sessionId,
		);
		assert.equal(
			switched.updatedState.runtime.turn.getCurrentSession().sessionId,
			second.sessionId,
		);
		assert.equal(
			switched.updatedState.runtime.context.getSummary(),
			"second session summary",
		);
		assert.deepEqual(
			stripMessageIds(
				switched.updatedState.runtime.context.getRecentMessages(),
			),
			[
				{ role: "user", content: "switch here" },
				{ role: "assistant", content: "done" },
			],
		);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("runChatReplLoop handles slash commands and ignores legacy command forms", async () => {
	const cwd = await realpath(await createTempDir("sigpi-chat-repl-commands-"));
	const homeDir = await createTempDir("sigpi-chat-repl-commands-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const outputs: string[] = [];
		const errors: string[] = [];
		const prompts = [
			"/summary",
			"/compact",
			"/session",
			":summary",
			"/unknown",
			"/exit",
		];
		let promptIndex = 0;
		const executedLines: string[] = [];

		await runChatReplLoop(
			{
				state: runtimeToChatReplState(runtime),
				store: runtime.store,
			},
			{
				readChatInput: async () => prompts[promptIndex++] ?? null,
				executeTurn: async (_runner, line) => {
					executedLines.push(line);
					return {
						ok: true,
						completionStatus: "completed",
						outputText: `echo:${line}`,
						toolExecutions: [],
					};
				},
				writeLine: (line) => outputs.push(line),
				writeError: (line) => errors.push(line),
			},
		);

		assert.match(outputs[0] ?? "", /Context window:/);
		assert.equal(outputs[1], "Nothing to compact.");
		assert.match(
			outputs[2] ?? "",
			/Recent messages: \d+\. Summary chars: \d+\. Estimated context size: \d+ (?:chars|tokens)\./,
		);
		assert.match(outputs[3] ?? "", /"sessionId":/);
		assert.equal(outputs.includes("Unknown command: /unknown"), true);
		assert.deepEqual(executedLines, [":summary"]);
		assert.equal(errors.length, 0);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("runChatReplLoop exits on legacy exit alias without calling the model", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-legacy-exit-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-legacy-exit-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const executedLines: string[] = [];
		let promptIndex = 0;

		await runChatReplLoop(
			{
				state: runtimeToChatReplState(runtime),
				store: runtime.store,
			},
			{
				readChatInput: async () =>
					["exit", "should-not-run"][promptIndex++] ?? null,
				executeTurn: async (_runner, line) => {
					executedLines.push(line);
					return {
						ok: true,
						completionStatus: "completed",
						outputText: `echo:${line}`,
						toolExecutions: [],
					};
				},
			},
		);

		assert.deepEqual(executedLines, []);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("runChatReplLoop /resume refreshes state through the command layer", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-resume-command-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-resume-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const outputs: string[] = [];
		const updatedState = {
			...runtimeToChatReplState(runtime),
			runtime: {
				...runtime,
				sessionWarnings: ["restored warning"],
			},
		};
		const commands = createChatCommandDefinitions({
			attachSessionFromSelector: async () => ({
				updatedState,
				selectedSessionId: "session-2",
				warnings: ["restored warning"],
			}),
		});
		let promptIndex = 0;

		const finalState = await runChatReplLoop(
			{
				state: runtimeToChatReplState(runtime),
				store: runtime.store,
			},
			{
				commands,
				readChatInput: async () => ["/resume", "/exit"][promptIndex++] ?? null,
				executeTurn: async () => {
					throw new Error("should not execute chat turn");
				},
				writeLine: (line) => outputs.push(line),
			},
		);

		assert.equal(finalState.runtime.sessionWarnings[0], "restored warning");
		assert.equal(outputs[0], "Attached session: session-2");
		assert.equal(outputs[1], "[session-warning] restored warning");
		assert.match(outputs[2] ?? "", /^Exiting session: [0-9a-f-]{36}$/);
		assert.equal(outputs.length, 3);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("runChatReplLoop /resume reports empty session list before selector", async () => {
	const outputs: string[] = [];
	const state = {
		context: {
			getSummary: () => null,
			getLastUsage: () => null,
			getRecentMessages: () => [],
		},
		systemPromptSections: [],
		toolSchemas: [],
		modelName: "test-model",
		workingDirectory: "/tmp/test",
		runtime: {
			context: {
				getContextBudget: () => ({
					hardContextLimit: 200_000,
					reserveTokens: 0,
					keepRecentTokens: 20_000,
				}),
				getLastUsage: () => null,
				getSummary: () => "",
				getRecentMessages: () => [],
			},
			systemPromptSections: [],
			toolSchemas: [],
			turn: { getCurrentSession: () => null },
			workingDirectory: "/tmp/test",
		} as never,
	} as never;
	let promptIndex = 0;
	const commands: readonly ChatCommandDefinition[] =
		createChatCommandDefinitions({
			attachSessionFromSelector: async () => {
				throw new Error("selector should not run when no sessions exist");
			},
		});

	await runChatReplLoop(
		{
			state,
			store: {
				listSessions: async () => [],
			} as never,
		},
		{
			commands,
			readChatInput: async () => ["/resume", "/exit"][promptIndex++] ?? null,
			executeTurn: async () => {
				throw new Error("should not execute chat turn");
			},
			writeLine: (line) => outputs.push(line),
		},
	);

	assert.equal(outputs[0], "No saved sessions available to resume.");
	assert.match(outputs[1] ?? "", /^Exiting chat \(no active session\)\.$/);
	assert.equal(outputs.length, 2);
});

test("runChatReplLoop prints the turn divider after the final answer", async () => {
	const cwd = await realpath(await createTempDir("sigpi-chat-repl-divider-"));
	const homeDir = await createTempDir("sigpi-chat-repl-divider-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const outputs: string[] = [];
		let promptIndex = 0;

		await runChatReplLoop(
			{
				state: runtimeToChatReplState(runtime),
				store: runtime.store,
				progressReporter: () => {},
				processOutputMode: "detailed",
			},
			{
				readChatInput: async () =>
					["explain hooks", "/exit"][promptIndex++] ?? null,
				executeTurn: async () => ({
					ok: true,
					completionStatus: "completed",
					outputText: "Answer.",
					toolExecutions: [],
				}),
				writeLine: (line) => outputs.push(line),
			},
		);

		const visible = outputs.map((line) => stripAnsi(line));
		const answerIndex = visible.indexOf("Answer.");
		const dividerIndex = visible.findIndex((line) => /━.*turn 1.*━/.test(line));

		assert.ok(answerIndex >= 0);
		assert.equal(visible[answerIndex + 1], visible[dividerIndex]);
		assert.ok(visible[dividerIndex]?.includes("turn 1"));
		assert.equal(visible[dividerIndex]?.length, 80);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("runChatReplLoop prints file edit summaries in clear mode", async () => {
	const cwd = await realpath(await createTempDir("sigpi-chat-repl-edits-"));
	const homeDir = await createTempDir("sigpi-chat-repl-edits-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const outputs: string[] = [];
		let promptIndex = 0;

		await runChatReplLoop(
			{
				state: runtimeToChatReplState(runtime),
				store: runtime.store,
			},
			{
				readChatInput: async () =>
					["update docs", "/exit"][promptIndex++] ?? null,
				executeTurn: async () => ({
					ok: true,
					completionStatus: "completed",
					outputText: "Done.",
					toolExecutions: [
						{
							toolCall: {
								id: "call_patch_1",
								name: "edit",
								arguments: {
									path: "README.md",
									patch: [
										"--- old",
										"- TUI implementation guidance: `docs/tui-development.md`",
										"--- new",
										"- TUI implementation guidance: `src/tui/README.md`",
										"--- end",
									].join("\n"),
								},
								rawArguments: "{}",
							},
							result: {
								ok: true,
								data: {
									path: "README.md",
									replacements: 1,
									editSummary: {
										kind: "file_edit",
										path: "README.md",
										paths: ["README.md"],
										additions: 1,
										deletions: 1,
										preview: [
											{
												kind: "remove",
												lineNumber: 264,
												text: "- TUI implementation guidance: `docs/tui-development.md`",
											},
											{
												kind: "add",
												lineNumber: 264,
												text: "- TUI implementation guidance: `src/tui/README.md`",
											},
										],
										truncated: false,
									},
								},
							},
						},
					],
				}),
				writeLine: (line) => outputs.push(line),
			},
		);

		const visible = outputs.map((line) => stripAnsi(line));
		assert.equal(visible[0], "");
		assert.equal(visible[1], "- Edited README.md (+1 -1)");
		assert.equal(
			visible[2],
			"  264 - - TUI implementation guidance: `docs/tui-development.md`",
		);
		assert.equal(
			visible[3],
			"  264 + - TUI implementation guidance: `src/tui/README.md`",
		);
		assert.equal(visible[4], "Done.");
		assert.match(visible[5] ?? "", /^Exiting session: [0-9a-f-]{36}$/);
		assert.equal(visible.length, 6);
		assert.equal(
			outputs.some((line) => line.includes("\x1B[41m")),
			true,
		);
		assert.equal(
			outputs.some((line) => line.includes("\x1B[97m")),
			true,
		);
		assert.equal(
			outputs.some((line) => line.includes("\x1B[42m")),
			true,
		);
		assert.equal(
			outputs.some((line) => line.includes("\x1B[30m")),
			true,
		);
		assert.equal(
			outputs.some((line) => line.includes("[tool-result]")),
			false,
		);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("runChatReplLoop prints full file edit content for review", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-full-edits-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-full-edits-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const outputs: string[] = [];
		const longLine =
			"const longValue = " +
			'"abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";';
		let promptIndex = 0;

		await runChatReplLoop(
			{
				state: runtimeToChatReplState(runtime),
				store: runtime.store,
			},
			{
				readChatInput: async () =>
					["review full edit", "/exit"][promptIndex++] ?? null,
				executeTurn: async () => ({
					ok: true,
					completionStatus: "completed",
					outputText: "Done.",
					toolExecutions: [
						{
							toolCall: {
								id: "call_patch_full_1",
								name: "edit",
								arguments: {
									patch: [
										"diff --git a/src/demo.ts b/src/demo.ts",
										"--- a/src/demo.ts",
										"+++ b/src/demo.ts",
										"@@ -10,10 +10,10 @@",
										"-old line 1",
										"-old line 2",
										"-old line 3",
										"-old line 4",
										"-old line 5",
										"+new line 1",
										"+new line 2",
										"+new line 3",
										"+new line 4",
										"+new line 5",
										`+${longLine}`,
									].join("\n"),
								},
								rawArguments: "{}",
							},
							result: {
								ok: true,
								data: {
									checkOnly: false,
									paths: ["src/demo.ts"],
									replacements: 6,
									editSummary: {
										kind: "file_edit",
										path: "src/demo.ts",
										paths: ["src/demo.ts"],
										additions: 6,
										deletions: 5,
										preview: [
											{ kind: "remove", lineNumber: 10, text: "old line 1" },
											{ kind: "remove", lineNumber: 11, text: "old line 2" },
											{ kind: "remove", lineNumber: 12, text: "old line 3" },
											{ kind: "remove", lineNumber: 13, text: "old line 4" },
											{ kind: "remove", lineNumber: 14, text: "old line 5" },
											{ kind: "add", lineNumber: 10, text: "new line 1" },
											{ kind: "add", lineNumber: 11, text: "new line 2" },
											{ kind: "add", lineNumber: 12, text: "new line 3" },
											{ kind: "add", lineNumber: 13, text: "new line 4" },
											{ kind: "add", lineNumber: 14, text: "new line 5" },
											{ kind: "add", lineNumber: 15, text: longLine },
										],
										truncated: false,
									},
								},
							},
						},
					],
				}),
				writeLine: (line) => outputs.push(line),
			},
		);

		const visible = outputs.map((line) => stripAnsi(line));
		assert.equal(visible.includes("  14 - old line 5"), true);
		assert.equal(visible.includes("  14 + new line 5"), true);
		assert.equal(visible.includes(`  15 + ${longLine}`), true);
		assert.equal(
			visible.some((line) => line.includes("...")),
			false,
		);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("runChatReplLoop does not print edit summaries for patch validation", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-edit-check-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-edit-check-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const outputs: string[] = [];
		let promptIndex = 0;

		await runChatReplLoop(
			{
				state: runtimeToChatReplState(runtime),
				store: runtime.store,
			},
			{
				readChatInput: async () =>
					["validate patch", "/exit"][promptIndex++] ?? null,
				executeTurn: async () => ({
					ok: true,
					completionStatus: "completed",
					outputText: "Patch validates.",
					toolExecutions: [
						{
							toolCall: {
								id: "call_patch_check_1",
								name: "edit",
								arguments: {
									checkOnly: true,
									patch: [
										"diff --git a/demo.txt b/demo.txt",
										"--- a/demo.txt",
										"+++ b/demo.txt",
										"@@ -1 +1 @@",
										"-old",
										"+new",
									].join("\n"),
								},
								rawArguments: "{}",
							},
							result: {
								ok: true,
								data: {
									checkOnly: true,
									paths: ["demo.txt"],
									applied: false,
								},
							},
						},
					],
				}),
				writeLine: (line) => outputs.push(line),
			},
		);

		assert.equal(outputs[0], "");
		assert.equal(outputs[1], "Patch validates.");
		assert.match(outputs[2] ?? "", /^Exiting session: [0-9a-f-]{36}$/);
		assert.equal(outputs.length, 3);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("runChatReplLoop listens for Esc while a turn is running", async () => {
	const cwd = await realpath(await createTempDir("sigpi-chat-repl-esc-"));
	const homeDir = await createTempDir("sigpi-chat-repl-esc-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const input = new FakeInput();
		const output = new FakeOutput();
		const outputs: string[] = [];
		let promptIndex = 0;

		await runChatReplLoop(
			{
				state: runtimeToChatReplState(runtime),
				store: runtime.store,
				input: input as never,
				output: output as never,
			},
			{
				readChatInput: async () =>
					["inspect repo", "/exit"][promptIndex++] ?? null,
				executeTurn: async (_runner, _line, _logger, interruptController) => {
					interruptController?.beginTurn();
					interruptController?.enterModel();
					setTimeout(() => {
						input.write("\x1B");
					}, 10);

					return await new Promise((resolve) => {
						const interval = setInterval(() => {
							if (!interruptController?.isInterruptRequested()) {
								return;
							}
							clearInterval(interval);
							interruptController.leaveActiveStage();
							resolve({
								ok: true as const,
								completionStatus: "interrupted" as const,
								outputText: null,
								toolExecutions: [],
							});
						}, 5);
					});
				},
				writeLine: (line) => outputs.push(line),
			},
		);

		assert.equal(outputs[0], "[agent] cancelling current model request");
		assert.equal(outputs[1], "");
		assert.match(outputs[2] ?? "", /^Exiting session: [0-9a-f-]{36}$/);
		assert.equal(outputs.length, 3);
		assert.equal(input.isRaw, false);
		assert.equal(input.paused, true);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("runChatReplLoop queues visible input typed while a turn is running", async () => {
	const cwd = await realpath(await createTempDir("sigpi-chat-repl-queued-"));
	const homeDir = await createTempDir("sigpi-chat-repl-queued-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const input = new FakeInput();
		const output = new FakeOutput();
		let promptIndex = 0;
		const executedLines: string[] = [];

		await runChatReplLoop(
			{
				state: runtimeToChatReplState(runtime),
				store: runtime.store,
				input: input as never,
				output: output as never,
			},
			{
				readChatInput: async () =>
					["first request", "/exit"][promptIndex++] ?? null,
				executeTurn: async (_runner, line) => {
					executedLines.push(line);
					if (line === "first request") {
						input.write("second request");
						input.write("\r");
					}
					return {
						ok: true,
						completionStatus: "completed",
						outputText: `echo:${line}`,
						toolExecutions: [],
					};
				},
			},
		);

		assert.deepEqual(executedLines, ["first request", "second request"]);
		assert.equal(input.isRaw, false);
		assert.equal(input.paused, true);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("runChatReplLoop preserves draft input across progress output", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-progress-input-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-progress-input-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	const originalConsoleLog = console.log;
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const input = new FakeInput();
		const output = new FakeOutput();
		const outputText = collectOutput(output);
		const progressReporter = createCliProgressReporter();
		let promptIndex = 0;
		const executedLines: string[] = [];
		console.log = (...values: unknown[]) => {
			output.write(`${values.join(" ")}\n`);
		};

		await runChatReplLoop(
			{
				state: runtimeToChatReplState(runtime),
				store: runtime.store,
				progressReporter,
				input: input as never,
				output: output as never,
			},
			{
				readChatInput: async () =>
					["first request", "/exit"][promptIndex++] ?? null,
				executeTurn: async (_runner, line) => {
					executedLines.push(line);
					if (line === "first request") {
						input.write("second request");
						progressReporter({
							type: "tool_execution_started",
							step: 1,
							toolName: "read",
							message: "read `src/cli.ts`",
						} satisfies TurnProgressEvent);
						input.write("\r");
					}
					return {
						ok: true,
						completionStatus: "completed",
						outputText: `echo:${line}`,
						toolExecutions: [],
					};
				},
			},
		);
		output.end();

		const visible = getVisibleOutput(await outputText);
		assert.deepEqual(executedLines, ["first request", "second request"]);
		assert.match(visible, /• Ran read `src\/cli\.ts`/);
		assert.match(visible, /> second request/);
		assert.ok((visible.match(/> first request/g)?.length ?? 0) <= 1);
		assert.ok(
			visible.indexOf("• Ran read `src/cli.ts`") <
				visible.lastIndexOf("> second request"),
		);
		assert.ok(
			visible.lastIndexOf("> second request") <
				visible.indexOf("echo:second request"),
		);
	} finally {
		console.log = originalConsoleLog;
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("createCliProgressReporter skips assistant_message when text is only whitespace", () => {
	const reporter = createCliProgressReporter("detailed");

	const lines = captureConsoleLog(() => {
		reporter({ type: "turn_started", userInput: "hi" });
		reporter({ type: "assistant_message", assistantText: "   \n\t  " });
		reporter({ type: "turn_finished", elapsedMs: 10 });
	});
	const visibleLines = lines.map((line) => stripAnsi(line));

	assert.equal(
		visibleLines.some((line) => line.startsWith("• Assistant:")),
		false,
	);
	assert.equal(visibleLines.at(-1), "• Done (10ms)");
});

test("createCliProgressReporter filters minimax-style end-of-thinking markers", () => {
	const reporter = createCliProgressReporter("detailed");

	const lines = captureConsoleLog(() => {
		reporter({ type: "turn_started", userInput: "hi" });
		reporter({ type: "assistant_message", assistantText: "]<]minimax[>" });
		reporter({
			type: "assistant_message",
			assistantText: "Real answer follows.",
		});
		reporter({ type: "turn_finished", elapsedMs: 10 });
	});
	const visibleLines = lines.map((line) => stripAnsi(line));

	assert.equal(
		visibleLines.some((line) => line.includes("minimax")),
		false,
	);
	assert.equal(
		visibleLines.includes("• Assistant: Real answer follows."),
		true,
	);
});

test("createCliProgressReporter filters bare XML-ish tags from assistant_message", () => {
	const reporter = createCliProgressReporter("detailed");

	const lines = captureConsoleLog(() => {
		reporter({ type: "turn_started", userInput: "hi" });
		reporter({ type: "assistant_message", assistantText: "<system>" });
		reporter({ type: "assistant_message", assistantText: "<think>" });
		reporter({ type: "assistant_message", assistantText: "actual reply" });
		reporter({ type: "turn_finished", elapsedMs: 10 });
	});
	const visibleLines = lines.map((line) => stripAnsi(line));

	assert.equal(
		visibleLines.some((line) => line.includes("<system>")),
		false,
	);
	assert.equal(
		visibleLines.some((line) => line.includes("<think>")),
		false,
	);
	assert.equal(visibleLines.includes("• Assistant: actual reply"), true);
});

test("createCliProgressReporter still prints assistant_message with real content", () => {
	const reporter = createCliProgressReporter("detailed");

	const lines = captureConsoleLog(() => {
		reporter({ type: "turn_started", userInput: "hi" });
		reporter({
			type: "assistant_message",
			assistantText: "Here is the answer you asked for.",
		});
		reporter({ type: "turn_finished", elapsedMs: 10 });
	});
	const visibleLines = lines.map((line) => stripAnsi(line));

	assert.equal(
		visibleLines.includes("• Assistant: Here is the answer you asked for."),
		true,
	);
});

test("runChatReplLoop records only model-reaching inputs in input history", async () => {
	const cwd = await realpath(await createTempDir("sigpi-chat-repl-hist-"));
	const homeDir = await createTempDir("sigpi-chat-repl-hist-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const input = new FakeInput();
		const output = new FakeOutput();
		const inputHistory = new InputHistory();
		let promptIndex = 0;

		const commands: ChatCommandDefinition[] = [
			{
				name: "/local",
				description: "A local-only command that does not reach the model",
				handler: () => ({ action: "continue" }),
			},
			{
				name: "/drive",
				description: "A command that drives a model turn",
				handler: (_ctx, args) => ({
					action: "run-turn",
					input: `expanded:${args.join(" ")}`,
				}),
			},
		];

		await runChatReplLoop(
			{
				state: runtimeToChatReplState(runtime),
				store: runtime.store,
				input: input as never,
				output: output as never,
				inputHistory,
			},
			{
				commands,
				readChatInput: async () =>
					[
						"natural prompt",
						"/local",
						"/drive raw args",
						"/unknowncmd",
						"/exit",
					][promptIndex++] ?? null,
				executeTurn: async (_runner, line) => ({
					ok: true,
					completionStatus: "completed",
					outputText: `echo:${line}`,
					toolExecutions: [],
				}),
			},
		);

		// Only the prompt and the /drive command reach the model; the local
		// command and the unknown command are not recorded.
		assert.equal(inputHistory.size, 2);
		assert.equal(inputHistory.prev(), "/drive raw args");
		assert.equal(inputHistory.prev(), "natural prompt");
		assert.equal(inputHistory.prev(), null);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("runChatReplLoop records the original line, not the expanded /skill form", async () => {
	const cwd = await realpath(await createTempDir("sigpi-chat-repl-hist-raw-"));
	const homeDir = await createTempDir("sigpi-chat-repl-hist-raw-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const input = new FakeInput();
		const output = new FakeOutput();
		const inputHistory = new InputHistory();
		let promptIndex = 0;

		const commands: ChatCommandDefinition[] = [
			{
				name: "/drive",
				description: "A command that drives a model turn",
				handler: (_ctx, args) => ({
					action: "run-turn",
					input: `expanded:${args.join(" ")}`,
				}),
			},
		];

		await runChatReplLoop(
			{
				state: runtimeToChatReplState(runtime),
				store: runtime.store,
				input: input as never,
				output: output as never,
				inputHistory,
			},
			{
				commands,
				readChatInput: async () =>
					["/drive original line", "/exit"][promptIndex++] ?? null,
				executeTurn: async (_runner, line) => ({
					ok: true,
					completionStatus: "completed",
					outputText: `echo:${line}`,
					toolExecutions: [],
				}),
			},
		);

		assert.equal(inputHistory.size, 1);
		assert.equal(inputHistory.prev(), "/drive original line");
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

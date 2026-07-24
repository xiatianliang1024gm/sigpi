import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import test from "node:test";

import {
	attachSessionById,
	formatStatusBar,
	formatStatusBarForEvent,
	getResumeAvailability,
	runtimeToChatReplState,
} from "../src/chat-repl.js";
import { getCurrentPlan, setCurrentPlan } from "../src/plan-tracker.js";
import { createAgentRuntime } from "../src/runtime.js";
import {
	composeStatusBar,
	type StatusBarModel,
} from "../src/tui/status-bar.js";
import {
	createTempDir,
	createTestSessionStore,
	gitIn,
	MockProvider,
	stripMessageIds,
	writeTestConfig,
} from "./helpers.js";

/**
 * Compose a status bar model into a single line so assertions match the
 * composed ADR 0022 string.
 */
function statusLine(model: StatusBarModel): string {
	return composeStatusBar(model);
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

test("runtimeToChatReplState clears a plan left over from a previous session", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-plan-clear-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-plan-clear-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
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
		restoreHome();
	}
});

test("formatStatusBar includes tokens and cwd", async () => {
	const cwd = await realpath(await createTempDir("sigpi-chat-repl-status-"));
	const homeDir = await createTempDir("sigpi-chat-repl-status-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);
		const status = statusLine(await formatStatusBar(state));

		assert.match(status, /^test-model /);
		// Before the first response there is no provider-reported usage, so
		// the token count is an honest `?` rather than a drift-prone estimate.
		assert.match(status, /\?\//);
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
		const status = statusLine(
			await formatStatusBarForEvent(state, {
				type: "model_request_started",
				step: 2,
			}),
		);

		assert.match(status, /thinking/);
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
		const status = statusLine(
			await formatStatusBarForEvent(state, {
				type: "model_request_finished",
				estimatedContextTokens: 12_345,
			}),
		);

		assert.match(status, /12\.3K\//);
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
		const status = statusLine(await formatStatusBar(state));
		assert.match(status, /\?\/183\.6K/);
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
		const status = statusLine(
			await formatStatusBarForEvent(state, {
				type: "model_request_finished",
				estimatedContextTokens: 12_345,
			}),
		);

		assert.match(status, /12\.3K\//);
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
		const status = statusLine(
			await formatStatusBarForEvent(state, {
				type: "turn_started",
				userInput: "hi",
			}),
		);
		// Falls back to recomputing from state via ground-truth usage, which is
		// `?` before the first response.
		assert.match(status, /^test-model /);
		assert.match(status, /\?\//);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBar appends git branch when cwd is a repo", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-git-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-status-git-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		gitIn(cwd, "init -q -b main");
		gitIn(cwd, "config user.email test@test.local");
		gitIn(cwd, "config user.name Test");
		gitIn(cwd, "commit --allow-empty -q -m initial");

		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);
		const status = statusLine(await formatStatusBar(state));

		assert.match(status, /\(main\)/);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBar omits git branch when cwd is not a repo", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-nogit-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-status-nogit-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);
		const status = statusLine(await formatStatusBar(state));

		assert.doesNotMatch(status, /\([a-z0-9_-]+\)$/);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBar appends cache hit rate when lastUsage is available", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-cache-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-status-cache-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);

		// Seed lastUsage via the context so the status bar can read it.
		const provider = new MockProvider(() => ({
			assistantText: "hi",
			toolCalls: [],
			finishReason: "stop",
		}));
		await state.runtime.context.appendMessages(
			[
				{ role: "user", content: "u" },
				{ role: "assistant", content: "a" },
			],
			provider,
			"You are a test agent.",
			[],
			undefined,
			{
				usage: {
					input: 200,
					output: 50,
					cacheRead: 800,
					cacheWrite: 0,
					totalTokens: 1_050,
				},
			},
		);

		const status = statusLine(await formatStatusBar(state));
		// 800 / (200 + 800) = 80.0%
		assert.match(status, /Hit\(80\.0%\)/);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBar omits cache hit rate when no usage has been recorded", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-nocache-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-status-nocache-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);
		const status = statusLine(await formatStatusBar(state));

		assert.doesNotMatch(status, /Hit\(/);
		assert.match(status, /\?\//);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBar shows the provider's totalTokens from the last response", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-total-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-status-total-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);

		const provider = new MockProvider(() => ({
			assistantText: "hi",
			toolCalls: [],
			finishReason: "stop",
		}));
		await state.runtime.context.appendMessages(
			[
				{ role: "user", content: "u" },
				{ role: "assistant", content: "a" },
			],
			provider,
			"You are a test agent.",
			[],
			undefined,
			{
				usage: {
					input: 200,
					output: 50,
					cacheRead: 800,
					cacheWrite: 0,
					totalTokens: 1_050,
				},
			},
		);

		const status = statusLine(await formatStatusBar(state));
		// Ground truth is totalTokens (1_050 -> 1.1K), not a chars/4 estimate.
		assert.match(status, /1\.1K\//);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBar keeps the last response's count while a follow-up is typed", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-stale-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-status-stale-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);

		const provider = new MockProvider(() => ({
			assistantText: "hi",
			toolCalls: [],
			finishReason: "stop",
		}));
		await state.runtime.context.appendMessages(
			[
				{ role: "user", content: "u" },
				{ role: "assistant", content: "a" },
			],
			provider,
			"You are a test agent.",
			[],
			undefined,
			{
				usage: {
					input: 200,
					output: 50,
					cacheRead: 800,
					cacheWrite: 0,
					totalTokens: 1_050,
				},
			},
		);

		// Type a follow-up before the next response lands — append a user
		// message only (no new usage). The bar must NOT re-estimate.
		await state.runtime.context.appendMessages(
			[{ role: "user", content: "follow-up" }],
			provider,
			"You are a test agent.",
			[],
		);

		const status = statusLine(await formatStatusBar(state));
		assert.match(status, /1\.1K\//);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBar resets to ? after in-memory state is cleared", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-reset-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-status-reset-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);

		const provider = new MockProvider(() => ({
			assistantText: "hi",
			toolCalls: [],
			finishReason: "stop",
		}));
		await state.runtime.context.appendMessages(
			[
				{ role: "user", content: "u" },
				{ role: "assistant", content: "a" },
			],
			provider,
			"You are a test agent.",
			[],
			undefined,
			{
				usage: {
					input: 200,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_050,
				},
			},
		);
		assert.match(statusLine(await formatStatusBar(state)), /1\.1K\//);

		// Clearing in-memory state (e.g. /recover) drops the ground truth.
		state.runtime.context.reset();
		assert.match(statusLine(await formatStatusBar(state)), /\?\//);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBar hides cache hit rate when there is no cacheable input", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-nocacheinput-"),
	);
	const homeDir = await createTempDir(
		"sigpi-chat-repl-status-nocacheinput-home-",
	);
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);

		const provider = new MockProvider(() => ({
			assistantText: "hi",
			toolCalls: [],
			finishReason: "stop",
		}));
		await state.runtime.context.appendMessages(
			[
				{ role: "user", content: "u" },
				{ role: "assistant", content: "a" },
			],
			provider,
			"You are a test agent.",
			[],
			undefined,
			{
				// Zero input and zero cache reads => nothing to measure against.
				usage: {
					input: 0,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 50,
				},
			},
		);

		const status = statusLine(await formatStatusBar(state));
		assert.doesNotMatch(status, /Hit\(/);
		assert.match(status, /50\//);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBar shows Hit(0.0%) for a cold cache with real input", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-cold-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-status-cold-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);

		const provider = new MockProvider(() => ({
			assistantText: "hi",
			toolCalls: [],
			finishReason: "stop",
		}));
		await state.runtime.context.appendMessages(
			[
				{ role: "user", content: "u" },
				{ role: "assistant", content: "a" },
			],
			provider,
			"You are a test agent.",
			[],
			undefined,
			{
				// cacheRead = 0, input > 0 => legitimate 0.0% hit rate.
				usage: {
					input: 1_000,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_050,
				},
			},
		);

		const status = statusLine(await formatStatusBar(state));
		assert.match(status, /Hit\(0\.0%\)/);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBar shows @shortSha for a detached HEAD", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-detached-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-status-detached-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		gitIn(cwd, "init -q -b main");
		gitIn(cwd, "config user.email test@test.local");
		gitIn(cwd, "config user.name Test");
		gitIn(cwd, "commit --allow-empty -q -m initial");
		gitIn(cwd, "checkout --detach -q");

		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);
		const status = statusLine(await formatStatusBar(state));

		// `@` followed by a short SHA, at the end of the cwd segment.
		assert.match(status, /\(@[0-9a-f]+\)/);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBar includes a model segment at the start", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-nomodel-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-status-nomodel-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);

		const provider = new MockProvider(() => ({
			assistantText: "hi",
			toolCalls: [],
			finishReason: "stop",
		}));
		await state.runtime.context.appendMessages(
			[
				{ role: "user", content: "u" },
				{ role: "assistant", content: "a" },
			],
			provider,
			"You are a test agent.",
			[],
			undefined,
			{
				usage: {
					input: 200,
					output: 50,
					cacheRead: 800,
					cacheWrite: 0,
					totalTokens: 1_050,
				},
			},
		);

		const status = statusLine(await formatStatusBar(state));
		// The model name is anchored at the start (the cwd path can
		// legitimately contain the substring "model", so we anchor at start).
		assert.match(status, /^test-model /);
		assert.match(status, /1\.1K\//);
		assert.match(status, /Hit\(80\.0%\)/);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBar restores token count from a resumed session with usage", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-resume-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-status-resume-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);

		// Build a persisted assistant `usage`, export the snapshot, then reset
		// (a fresh process load) and rehydrate from it — exactly what a
		// session resume does.
		const provider = new MockProvider(() => ({
			assistantText: "hi",
			toolCalls: [],
			finishReason: "stop",
		}));
		await state.runtime.context.appendMessages(
			[
				{ role: "user", content: "u" },
				{ role: "assistant", content: "a" },
			],
			provider,
			"You are a test agent.",
			[],
			undefined,
			{
				usage: {
					input: 200,
					output: 50,
					cacheRead: 800,
					cacheWrite: 0,
					totalTokens: 1_050,
				},
			},
		);
		const snapshot = state.runtime.context.exportState();
		state.runtime.context.reset();
		state.runtime.context.hydrateState(snapshot);

		const status = statusLine(await formatStatusBar(state));
		// Real number restored from the persisted entry, not `?`.
		assert.match(status, /1\.1K\//);
		assert.match(status, /Hit\(80\.0%\)/);
	} finally {
		restoreHome();
		process.chdir(previousCwd);
	}
});

test("formatStatusBar shows ? for a resumed session without usage", async () => {
	const cwd = await realpath(
		await createTempDir("sigpi-chat-repl-status-resumeold-"),
	);
	const homeDir = await createTempDir("sigpi-chat-repl-status-resumeold-home-");
	const previousCwd = process.cwd();
	const restoreHome = setTestHome(homeDir);
	process.chdir(cwd);

	try {
		await writeTestConfig(cwd);
		const runtime = await createAgentRuntime({ createSession: true });
		const state = runtimeToChatReplState(runtime);

		// Legacy snapshot: assistant message, but no `usage` field.
		state.runtime.context.hydrateState({
			summary: null,
			recentMessages: [
				{ role: "user", content: "u" },
				{ role: "assistant", content: "a" },
			],
		});

		const status = statusLine(await formatStatusBar(state));
		assert.match(status, /\?\//);
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

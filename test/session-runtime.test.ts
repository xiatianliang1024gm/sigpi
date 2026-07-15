import assert from "node:assert/strict";
import test from "node:test";
import { ConversationContext } from "../src/agent/context.js";
import { AgentRunner } from "../src/agent/runner.js";
import { TurnInterruptController } from "../src/interrupt.js";
import { deriveContextStateFromEntries } from "../src/session/format.js";
import {
	hydrateRuntimeFromSession,
	SessionRuntime,
} from "../src/session/runtime.js";
import { createSystemPromptFingerprint } from "../src/session/store.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";
import {
	createTempDir,
	createTestSessionStore,
	MockProvider,
	stripMessageIds,
	writeWorkspaceFile,
} from "./helpers.js";

test("session runtime persists successful turns", async () => {
	const cwd = await createTempDir("sigpi-session-runtime-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const session = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: [],
		skillsFingerprint: null,
	});
	const provider = new MockProvider(() => ({
		assistantText: "final response",
		toolCalls: [],
		finishReason: "stop",
	}));
	const context = new ConversationContext();
	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context,
		systemPrompt: "system prompt",
		options: {
			workingDirectory: cwd,
		},
	});
	const sessionRuntime = new SessionRuntime(runner, context, store, session);

	const result = await sessionRuntime.runTurn("continue task");
	const persisted = await store.getSession(session.sessionId);

	assert.equal(result.outputText, "final response");
	assert.equal(persisted.turnCount, 1);
	assert.equal(persisted.lastCompletedUserInput, "continue task");
	assert.equal(persisted.lastTurn?.status, "completed");
	assert.equal(persisted.turns.length, 1);
	assert.equal(persisted.turns[0]?.assistantOutput, "final response");
});

test("session runtime persists failed-turn recovery context and can continue in-process", async () => {
	const cwd = await createTempDir("sigpi-session-runtime-failed-");
	await writeWorkspaceFile(cwd, "src/demo.ts", "export const demo = 1;\n");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const session = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: [],
		skillsFingerprint: null,
	});
	const provider = new MockProvider((_request, index) => {
		if (index === 0) {
			return {
				assistantText:
					"I will find the matching file before answering the real question.",
				toolCalls: [
					{
						id: "call_1",
						name: "glob",
						arguments: { pattern: "src/**/*.ts" },
						rawArguments: '{"pattern":"src/**/*.ts"}',
					},
				],
				finishReason: "tool_calls",
			};
		}

		throw new Error("provider failure");
	});
	const context = new ConversationContext({
		summaryEnabled: true,
	});
	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context,
		systemPrompt: "system prompt",
		options: {
			workingDirectory: cwd,
		},
	});
	const sessionRuntime = new SessionRuntime(runner, context, store, session);

	await assert.rejects(
		() => sessionRuntime.runTurn("fail turn"),
		/provider failure/,
	);

	const persisted = await store.getSession(session.sessionId);
	assert.equal(persisted.turnCount, 0);
	assert.equal(provider.requests.length, 2);
	const recent = deriveContextStateFromEntries(
		persisted.entries,
	).recentMessages;
	assert.equal(recent.length, 3);
	assert.equal(recent[0]?.role, "user");
	assert.equal(recent[1]?.role, "assistant");
	assert.equal(recent[2]?.role, "tool");
	assert.match(recent[2]?.content ?? "", /src\/demo\.ts/);
	assert.equal(persisted.lastTurn?.status, "failed");
	assert.equal(persisted.lastCompletedUserInput, null);
	assert.equal(persisted.turns.length, 1);
	assert.equal(persisted.turns[0]?.status, "failed");
	assert.equal(persisted.turns[0]?.assistantOutput, null);
	assert.equal(persisted.turns[0]?.toolExecutions.length, 0);

	const continueProvider = new MockProvider((request) => {
		const conversationMessages = request.messages.filter(
			(message) => message.role !== "system",
		);
		assert.equal(conversationMessages[0]?.role, "user");
		assert.equal(conversationMessages[0]?.content, "fail turn");
		assert.equal(conversationMessages[1]?.role, "assistant");
		assert.equal(conversationMessages[2]?.role, "tool");
		assert.match(conversationMessages[2]?.content ?? "", /src\/demo\.ts/);
		assert.equal(request.messages.at(-1)?.role, "user");
		assert.equal(request.messages.at(-1)?.content, "continue");

		return {
			assistantText: "continued successfully",
			toolCalls: [],
			finishReason: "stop",
		};
	});
	const continueRunner = new AgentRunner({
		provider: continueProvider,
		tools: createDefaultToolRegistry(),
		context,
		systemPrompt: "system prompt",
		options: {
			workingDirectory: cwd,
		},
	});
	const continueRuntime = new SessionRuntime(
		continueRunner,
		context,
		store,
		sessionRuntime.getCurrentSession(),
	);

	const continued = await continueRuntime.runTurn("continue");
	assert.equal(continued.outputText, "continued successfully");
});

test("session runtime restores failed-turn recovery context after reload", async () => {
	const cwd = await createTempDir("sigpi-session-runtime-reload-");
	await writeWorkspaceFile(cwd, "src/demo.ts", "export const demo = 1;\n");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const session = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: [],
		skillsFingerprint: null,
	});
	const failingProvider = new MockProvider((_request, index) => {
		if (index === 0) {
			return {
				assistantText: "I will inspect the matching files first.",
				toolCalls: [
					{
						id: "call_1",
						name: "glob",
						arguments: { pattern: "src/**/*.ts" },
						rawArguments: '{"pattern":"src/**/*.ts"}',
					},
				],
				finishReason: "tool_calls",
			};
		}

		throw new Error("provider timeout");
	});
	const initialContext = new ConversationContext();
	const initialRunner = new AgentRunner({
		provider: failingProvider,
		tools: createDefaultToolRegistry(),
		context: initialContext,
		systemPrompt: "system prompt",
		options: {
			workingDirectory: cwd,
		},
	});
	const initialRuntime = new SessionRuntime(
		initialRunner,
		initialContext,
		store,
		session,
	);

	await assert.rejects(
		() => initialRuntime.runTurn("resume later"),
		/provider timeout/,
	);

	const loaded = await store.loadSession({
		sessionId: session.sessionId,
		cwd,
		systemPromptFingerprint: fingerprint,
	});
	const reloadedContext = new ConversationContext();
	const reloadedSession = await hydrateRuntimeFromSession({
		context: reloadedContext,
		store,
		loadedSession: loaded,
	});
	const resumedProvider = new MockProvider((request) => {
		const conversationMessages = request.messages.filter(
			(message) => message.role !== "system",
		);
		assert.equal(conversationMessages[0]?.role, "user");
		assert.equal(conversationMessages[0]?.content, "resume later");
		assert.equal(conversationMessages[1]?.role, "assistant");
		assert.equal(conversationMessages[2]?.role, "tool");
		assert.match(conversationMessages[2]?.content ?? "", /src\/demo\.ts/);
		assert.equal(request.messages.at(-1)?.content, "continue after reload");

		return {
			assistantText: "reloaded session continued",
			toolCalls: [],
			finishReason: "stop",
		};
	});
	const resumedRunner = new AgentRunner({
		provider: resumedProvider,
		tools: createDefaultToolRegistry(),
		context: reloadedContext,
		systemPrompt: "system prompt",
		options: {
			workingDirectory: cwd,
		},
	});
	const resumedRuntime = new SessionRuntime(
		resumedRunner,
		reloadedContext,
		store,
		reloadedSession,
	);

	const result = await resumedRuntime.runTurn("continue after reload");
	assert.equal(result.outputText, "reloaded session continued");
});

test("session runtime persists interrupted turns without incrementing turnCount", async () => {
	const cwd = await createTempDir("sigpi-session-runtime-interrupted-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const session = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: [],
		skillsFingerprint: null,
	});
	const interruptController = new TurnInterruptController();
	const provider = new MockProvider(
		(request) =>
			new Promise((_resolve, reject) => {
				request.abortSignal?.addEventListener(
					"abort",
					() => {
						reject(
							request.abortSignal?.reason ?? new Error("missing abort reason"),
						);
					},
					{ once: true },
				);
				setTimeout(() => {
					interruptController.requestInterrupt();
				}, 10);
			}),
	);
	const context = new ConversationContext();
	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context,
		systemPrompt: "system prompt",
		options: {
			workingDirectory: cwd,
		},
	});
	const sessionRuntime = new SessionRuntime(runner, context, store, session);

	const result = await sessionRuntime.runTurn(
		"interrupt me",
		interruptController,
	);
	const persisted = await store.getSession(session.sessionId);

	assert.equal(result.completionStatus, "interrupted");
	assert.equal(persisted.turnCount, 0);
	assert.equal(persisted.lastTurn?.status, "interrupted");
	assert.equal(persisted.lastTurn?.interruptSource, "user_escape");
	assert.equal(persisted.lastTurn?.interruptStage, "model");
	assert.equal(persisted.turns.length, 1);
	assert.equal(persisted.turns[0]?.status, "interrupted");
	assert.equal(persisted.turns[0]?.interruptSource, "user_escape");
	assert.equal(persisted.turns[0]?.interruptStage, "model");
	assert.deepEqual(
		stripMessageIds(
			deriveContextStateFromEntries(persisted.entries).recentMessages,
		),
		[{ role: "user", content: "interrupt me" }],
	);
});

test("max-steps turn is resumable and go on continues the same task", async () => {
	const cwd = await createTempDir("sigpi-session-runtime-resume-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const session = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: [],
		skillsFingerprint: null,
	});
	// First turn: always emit a tool call so the turn hits maxSteps. Second turn
	// ("go on"): emit a final answer to prove the resumed turn finishes instead
	// of re-running the same steps.
	const provider = new MockProvider((request) => {
		const lastUser = [...request.messages]
			.reverse()
			.find((message) => message.role === "user");
		if (lastUser?.content === "go on") {
			return {
				assistantText: "finished the analysis",
				toolCalls: [],
				finishReason: "stop",
			};
		}

		return {
			assistantText: null,
			toolCalls: [
				{
					id: "call_1",
					name: "glob",
					arguments: { pattern: "src/**/*.ts" },
					rawArguments: '{"pattern":"src/**/*.ts"}',
				},
			],
			finishReason: "tool_calls",
		};
	});
	const context = new ConversationContext();
	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context,
		systemPrompt: "system prompt",
		options: {
			workingDirectory: cwd,
			maxSteps: 3,
		},
	});
	const sessionRuntime = new SessionRuntime(runner, context, store, session);

	const maxStepsResult = await sessionRuntime.runTurn("analyze the project");

	assert.equal(maxStepsResult.completionStatus, "completed");
	assert.equal(maxStepsResult.resumable, true);
	assert.match(
		maxStepsResult.outputText ?? "",
		/I reached the maximum tool-call steps/,
	);
	assert.match(maxStepsResult.outputText ?? "", /go on/);

	// The resumed turn must not re-run the same steps: it should request the
	// model exactly once and finish with a fresh budget.
	const requestsBeforeResume = provider.requests.length;
	const resumed = await sessionRuntime.runTurn("go on");

	assert.equal(resumed.completionStatus, "completed");
	assert.equal(resumed.resumable, false);
	assert.equal(resumed.outputText, "finished the analysis");
	assert.equal(provider.requests.length - requestsBeforeResume, 1);

	const persisted = await store.getSession(session.sessionId);
	assert.equal(persisted.turnCount, 2);
});

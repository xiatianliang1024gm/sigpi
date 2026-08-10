import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
	createChatCommandDefinitions,
	executeChatCommand,
	getChatCommandSuggestions,
	parseChatCommand,
} from "../src/chat-commands.js";
import { BackgroundTaskManager } from "../src/tools/background.js";
import { createTempDir, waitFor } from "./helpers.js";

test("parseChatCommand matches supported slash commands", () => {
	const commands = createChatCommandDefinitions();

	for (const value of [
		"/summary",
		"/compact",
		"/model",
		"/session",
		"/resume",
		"/new",
		"/exit",
	]) {
		const parsed = parseChatCommand(value, commands);
		assert.equal(parsed.kind, "command");
		assert.equal(parsed.command.name, value);
	}
});

test("parseChatCommand accepts legacy exit aliases for local quit", () => {
	const commands = createChatCommandDefinitions();

	for (const value of ["exit", "quit"]) {
		const parsed = parseChatCommand(value, commands);
		assert.equal(parsed.kind, "command");
		assert.equal(parsed.command.name, "/exit");
	}
});

test("parseChatCommand does not execute partial or non-slash input", () => {
	const commands = createChatCommandDefinitions();

	assert.deepEqual(parseChatCommand("hello", commands), { kind: "none" });

	const partial = parseChatCommand("/res", commands);
	assert.equal(partial.kind, "unknown");
	assert.equal(partial.rawName, "/res");
});

test("executeChatCommand reports unknown slash commands locally", async () => {
	const outputs: string[] = [];
	const result = await executeChatCommand(
		"/unknown",
		createChatCommandDefinitions(),
		{
			getState: () => ({}) as never,
			setState: () => {},
			store: {} as never,
			writeLine: (line: string) => outputs.push(line),
		},
	);

	assert.deepEqual(result, {
		kind: "unknown-command",
		rawName: "/unknown",
	});
	assert.deepEqual(outputs, []);
});

test("executeChatCommand compacts context through the active session runtime", async () => {
	const outputs: string[] = [];
	const result = await executeChatCommand(
		"/compact",
		createChatCommandDefinitions(),
		{
			getState: () =>
				({
					runtime: {
						turn: {
							compactContext: async () => ({
								summarized: true,
								summary: "summary",
								recentMessageCount: 2,
								previousRecentMessageCount: 5,
								summaryChars: 7,
								previousSummaryChars: 0,
								tokensBefore: 45,
								tokensAfter: 18,
							}),
						},
					},
					contextWindow: {
						softLimitChars: 0,
						hardLimitChars: 0,
						keepLastMessages: 0,
						reserveTokens: 0,
						displayUnit: "chars",
					},
				}) as never,
			setState: () => {},
			store: {} as never,
			writeLine: (line: string) => outputs.push(line),
		},
	);

	assert.deepEqual(result, {
		kind: "handled",
		action: "continue",
	});
	assert.deepEqual(outputs, [
		"Context compacted: context window 45 → 18 tokens.",
	]);
});

test("executeChatCommand forwards /compact <instructions> to compactContext", async () => {
	const captured: { options: unknown } = { options: null };
	const outputs: string[] = [];
	await executeChatCommand(
		"/compact Focus on the database schema.",
		createChatCommandDefinitions(),
		{
			getState: () =>
				({
					runtime: {
						turn: {
							compactContext: async (options: unknown) => {
								captured.options = options;
								return {
									summarized: true,
									summary: "summary",
									recentMessageCount: 2,
									previousRecentMessageCount: 5,
									summaryChars: 7,
									previousSummaryChars: 0,
									tokensBefore: 45,
									tokensAfter: 18,
								};
							},
						},
					},
					contextWindow: {
						contextWindow: 200_000,
						reserveTokens: 0,
					},
				}) as never,
			setState: () => {},
			store: {} as never,
			writeLine: (line: string) => outputs.push(line),
		},
	);

	assert.deepEqual(captured.options, {
		instructions: "Focus on the database schema.",
	});
	assert.ok(outputs.includes("Custom instructions applied to summary."));
});

test("executeChatCommand omits options.abortSignal when no interrupt signal is available", async () => {
	const captured: { options: unknown } = { options: "sentinel" };
	await executeChatCommand("/compact", createChatCommandDefinitions(), {
		getState: () =>
			({
				runtime: {
					turn: {
						compactContext: async (options: unknown) => {
							captured.options = options;
							return {
								summarized: true,
								summary: "summary",
								recentMessageCount: 2,
								previousRecentMessageCount: 5,
								summaryChars: 7,
								previousSummaryChars: 0,
								tokensBefore: 45,
								tokensAfter: 18,
							};
						},
					},
				},
				contextWindow: {
					contextWindow: 200_000,
					reserveTokens: 0,
				},
			}) as never,
		setState: () => {},
		store: {} as never,
		writeLine: () => {},
	});

	const passedOptions = captured.options as {
		instructions?: string;
		abortSignal?: AbortSignal;
	};
	assert.equal(passedOptions?.instructions, undefined);
	assert.equal(passedOptions?.abortSignal, undefined);
});

test("executeChatCommand forwards an interrupt signal to /compact", async () => {
	const captured: { options: unknown } = { options: null };
	const controller = new AbortController();
	await executeChatCommand("/compact", createChatCommandDefinitions(), {
		getState: () =>
			({
				runtime: {
					turn: {
						compactContext: async (options: unknown) => {
							captured.options = options;
							return {
								summarized: false,
								summary: null,
								recentMessageCount: 1,
								previousRecentMessageCount: 1,
								summaryChars: 0,
								previousSummaryChars: 0,
								tokensBefore: 6,
								tokensAfter: 6,
							};
						},
					},
				},
				contextWindow: {
					contextWindow: 200_000,
					reserveTokens: 0,
				},
			}) as never,
		setState: () => {},
		store: {} as never,
		writeLine: () => {},
		getInterruptSignal: () => controller.signal,
	});

	const options = captured.options as { abortSignal?: AbortSignal };
	assert.ok(options?.abortSignal, "/compact must forward the interrupt signal");
	assert.equal(options.abortSignal?.aborted, false);
	controller.abort();
	assert.equal(options.abortSignal?.aborted, true);
});

test("executeChatCommand reports when manual compaction is a no-op", async () => {
	const outputs: string[] = [];
	await executeChatCommand("/compact", createChatCommandDefinitions(), {
		getState: () =>
			({
				runtime: {
					turn: {
						compactContext: async () => ({
							summarized: false,
							summary: null,
							recentMessageCount: 1,
							previousRecentMessageCount: 1,
							summaryChars: 0,
							previousSummaryChars: 0,
							tokensBefore: 6,
							tokensAfter: 6,
						}),
					},
				},
				contextWindow: {
					contextWindow: 200_000,
					reserveTokens: 0,
				},
			}) as never,
		setState: () => {},
		store: {} as never,
		writeLine: (line: string) => outputs.push(line),
	});

	assert.deepEqual(outputs, ["Nothing to compact. Context window: 6 tokens."]);
});

test("/model with no args opens the TUI selector instead of printing a list", async () => {
	const outputs: string[] = [];
	let selectorOpened = false;
	await executeChatCommand(
		"/model",
		createChatCommandDefinitions({
			selectModelFromSelector: async () => {
				selectorOpened = true;
				return null;
			},
		}),
		{
			getState: () =>
				({
					modelId: "fast",
					modelName: "fast-model",
					models: {
						fast: {
							baseURL: "https://fast.example/v1",
							apiKey: "fast-key",
							name: "fast-model",
							timeoutMs: 30000,
							maxRetries: 2,
							retryBaseDelayMs: 250,
						},
						deep: {
							baseURL: "https://deep.example/v1",
							apiKey: "deep-key",
							name: "deep-model",
							timeoutMs: 30000,
							maxRetries: 2,
							retryBaseDelayMs: 250,
						},
					},
				}) as never,
			setState: () => {},
			store: {} as never,
			writeLine: (line: string) => outputs.push(line),
		},
	);

	// The model list is now rendered by the TUI selector overlay, not via writeLine.
	assert.deepEqual(outputs, []);
	assert.equal(selectorOpened, true);
});

test("/model switches to the interactively selected model", async () => {
	const outputs: string[] = [];
	let providerUpdated = false;
	let updatedState: { modelId: string; modelName: string } | null = null;

	await executeChatCommand(
		"/model",
		createChatCommandDefinitions({
			selectModelFromSelector: async () => "deep",
			rememberModelSelection: async () => {},
		}),
		{
			getState: () =>
				({
					modelId: "fast",
					modelName: "fast-model",
					logger: {},
					runtime: {
						turn: {
							setProvider: () => {
								providerUpdated = true;
							},
						},
						setActiveModel: () => {},
					},
					models: {
						fast: {
							baseURL: "https://fast.example/v1",
							apiKey: "fast-key",
							name: "fast-model",
							timeoutMs: 30000,
							maxRetries: 2,
							retryBaseDelayMs: 250,
						},
						deep: {
							baseURL: "https://deep.example/v1",
							apiKey: "deep-key",
							name: "deep-model",
							timeoutMs: 30000,
							maxRetries: 2,
							retryBaseDelayMs: 250,
						},
					},
				}) as never,
			setState: (state) => {
				updatedState = {
					modelId: state.modelId,
					modelName: state.modelName,
				};
			},
			store: {} as never,
			writeLine: (line: string) => outputs.push(line),
		},
	);

	assert.equal(providerUpdated, true);
	assert.deepEqual(updatedState, {
		modelId: "deep",
		modelName: "deep-model",
	});
	assert.equal(outputs.at(-1), "Switched model to deep (deep-model).");
});

test("/model switches the active provider for the current chat state", async () => {
	const outputs: string[] = [];
	let providerUpdated = false;
	let updatedState: { modelId: string; modelName: string } | null = null;

	await executeChatCommand(
		"/model deep",
		createChatCommandDefinitions({
			rememberModelSelection: async () => {},
		}),
		{
			getState: () =>
				({
					modelId: "fast",
					modelName: "fast-model",
					logger: {},
					runtime: {
						turn: {
							setProvider: () => {
								providerUpdated = true;
							},
						},
						setActiveModel: () => {},
					},
					models: {
						fast: {
							baseURL: "https://fast.example/v1",
							apiKey: "fast-key",
							name: "fast-model",
							timeoutMs: 30000,
							maxRetries: 2,
							retryBaseDelayMs: 250,
						},
						deep: {
							baseURL: "https://deep.example/v1",
							apiKey: "deep-key",
							name: "deep-model",
							timeoutMs: 30000,
							maxRetries: 2,
							retryBaseDelayMs: 250,
						},
					},
				}) as never,
			setState: (state) => {
				updatedState = {
					modelId: state.modelId,
					modelName: state.modelName,
				};
			},
			store: {} as never,
			writeLine: (line: string) => outputs.push(line),
		},
	);

	assert.equal(providerUpdated, true);
	assert.deepEqual(updatedState, {
		modelId: "deep",
		modelName: "deep-model",
	});
	assert.deepEqual(outputs, ["Switched model to deep (deep-model)."]);
});

test("/model remembers a successful model switch", async () => {
	const rememberedModelIds: string[] = [];

	await executeChatCommand(
		"/model deep",
		createChatCommandDefinitions({
			rememberModelSelection: async (modelId) => {
				rememberedModelIds.push(modelId);
			},
		}),
		{
			getState: () =>
				({
					modelId: "fast",
					modelName: "fast-model",
					logger: {},
					runtime: {
						turn: {
							setProvider: () => {},
						},
						setActiveModel: () => {},
					},
					models: {
						fast: {
							baseURL: "https://fast.example/v1",
							apiKey: "fast-key",
							name: "fast-model",
							timeoutMs: 30000,
							maxRetries: 2,
							retryBaseDelayMs: 250,
						},
						deep: {
							baseURL: "https://deep.example/v1",
							apiKey: "deep-key",
							name: "deep-model",
							timeoutMs: 30000,
							maxRetries: 2,
							retryBaseDelayMs: 250,
						},
					},
				}) as never,
			setState: () => {},
			store: {} as never,
			writeLine: () => {},
		},
	);

	assert.deepEqual(rememberedModelIds, ["deep"]);
});

test("/model does not remember an unknown model", async () => {
	const rememberedModelIds: string[] = [];
	const outputs: string[] = [];

	await executeChatCommand(
		"/model missing",
		createChatCommandDefinitions({
			rememberModelSelection: async (modelId) => {
				rememberedModelIds.push(modelId);
			},
		}),
		{
			getState: () =>
				({
					modelId: "fast",
					modelName: "fast-model",
					logger: {},
					runtime: {
						turn: {
							setProvider: () => {},
						},
						setActiveModel: () => {},
					},
					models: {
						fast: {
							baseURL: "https://fast.example/v1",
							apiKey: "fast-key",
							name: "fast-model",
							timeoutMs: 30000,
							maxRetries: 2,
							retryBaseDelayMs: 250,
						},
					},
				}) as never,
			setState: () => {},
			store: {} as never,
			writeLine: (line: string) => outputs.push(line),
		},
	);

	assert.deepEqual(rememberedModelIds, []);
	assert.equal(outputs[0], "Unknown model: missing");
});

test("/new starts a fresh session and replaces the active state", async () => {
	const outputs: string[] = [];
	let updatedState: unknown = "unchanged";
	const previousState = {
		runtime: {
			turn: { getCurrentSession: () => ({ sessionId: "old-session" }) },
		},
	} as never;
	const freshState = {
		runtime: {
			turn: {
				getCurrentSession: () => ({ sessionId: "fresh-session" }),
			},
		},
	} as never;

	await executeChatCommand(
		"/new",
		createChatCommandDefinitions({
			attachNewSession: async () => ({
				updatedState: freshState,
				selectedSessionId: "fresh-session",
				warnings: ["restored warning"],
			}),
		}),
		{
			getState: () => previousState,
			setState: (state) => {
				updatedState = state;
			},
			store: {} as never,
			writeLine: (line: string) => outputs.push(line),
		},
	);

	assert.deepEqual(outputs, [
		"Started new session: fresh-session",
		"[session-warning] restored warning",
	]);
	assert.equal(updatedState, freshState);
});

test("/resume replays the attached session's messages into the view", async () => {
	const replayed: unknown[][] = [];
	const view = {
		replaceTranscript: (components: unknown[]) => replayed.push(components),
	};
	const session = {
		entries: [
			{
				kind: "message",
				id: "m1",
				turnId: 1,
				timestamp: "2026-05-22T00:01:00.000Z",
				message: { role: "user", content: "hello", id: "m1" },
			},
		],
	};

	await executeChatCommand(
		"/resume",
		createChatCommandDefinitions({
			attachSessionFromSelector: async () => ({
				updatedState: { runtime: { session } } as never,
				selectedSessionId: "resumed-session",
				warnings: [],
			}),
		}),
		{
			getState: () => ({ view }) as never,
			setState: () => {},
			store: {
				listSessions: async () => [{ sessionId: "resumed-session" }],
			} as never,
			writeLine: () => {},
		},
	);

	// The terminal transcript is replaced with the attached session's
	// messages (the user line here) instead of leaving the old session on
	// screen or requiring a separate /history view.
	assert.equal(replayed.length, 1);
	assert.equal(replayed[0]?.length, 1);
});

test("/new clears the previous transcript in the view", async () => {
	const replayed: unknown[][] = [];
	const view = {
		replaceTranscript: (components: unknown[]) => replayed.push(components),
	};

	await executeChatCommand(
		"/new",
		createChatCommandDefinitions({
			attachNewSession: async () => ({
				updatedState: { runtime: { session: { entries: [] } } } as never,
				selectedSessionId: "fresh-session",
				warnings: [],
			}),
		}),
		{
			getState: () => ({ view }) as never,
			setState: () => {},
			store: {} as never,
			writeLine: () => {},
		},
	);

	// A fresh session has no messages, so the previous session's transcript
	// is replaced with an empty component list.
	assert.equal(replayed.length, 1);
	assert.deepEqual(replayed[0], []);
});

test("/exit prints the active session title and id before quitting", async () => {
	const outputs: string[] = [];
	const result = await executeChatCommand(
		"/exit",
		createChatCommandDefinitions(),
		{
			getState: () =>
				({
					runtime: {
						turn: {
							getCurrentSession: () => ({
								sessionId: "11111111-1111-4111-8111-111111111111",
								title: "demo session",
							}),
						},
					},
				}) as never,
			setState: () => {},
			store: {} as never,
			writeLine: (line: string) => outputs.push(line),
		},
	);

	assert.deepEqual(result, { kind: "handled", action: "exit" });
	assert.deepEqual(outputs, [
		"Exiting session: demo session (11111111-1111-4111-8111-111111111111)",
	]);
});

test("/exit prints only the session id when no title is set", async () => {
	const outputs: string[] = [];
	const result = await executeChatCommand(
		"/exit",
		createChatCommandDefinitions(),
		{
			getState: () =>
				({
					runtime: {
						turn: {
							getCurrentSession: () => ({
								sessionId: "22222222-2222-4222-8222-222222222222",
								title: null,
							}),
						},
					},
				}) as never,
			setState: () => {},
			store: {} as never,
			writeLine: (line: string) => outputs.push(line),
		},
	);

	assert.deepEqual(result, { kind: "handled", action: "exit" });
	assert.deepEqual(outputs, [
		"Exiting session: 22222222-2222-4222-8222-222222222222",
	]);
});

test("/exit reports when there is no active session", async () => {
	const outputs: string[] = [];
	const result = await executeChatCommand(
		"/exit",
		createChatCommandDefinitions(),
		{
			getState: () =>
				({ runtime: { turn: { getCurrentSession: () => null } } }) as never,
			setState: () => {},
			store: {} as never,
			writeLine: (line: string) => outputs.push(line),
		},
	);

	assert.deepEqual(result, { kind: "handled", action: "exit" });
	assert.deepEqual(outputs, ["Exiting chat (no active session)."]);
});

test("/summary reports context structure instead of recent message bodies", async () => {
	const outputs: string[] = [];
	await executeChatCommand("/summary", createChatCommandDefinitions(), {
		getState: () =>
			({
				runtime: {
					context: {
						getContextBudget: () => ({
							hardContextLimit: 200_000,
							reserveTokens: 16384,
							keepRecentTokens: 20_000,
						}),
						getSummary: () => "compressed memory",
						getLastUsage: () => null,
						getRecentMessages: () => [
							{ role: "user", content: "secret user text" },
							{ role: "assistant", content: "assistant body" },
							{
								role: "tool",
								name: "read",
								toolCallId: "call_1",
								content: '{"ok":true}',
							},
						],
					},
					systemPromptSections: [
						{ id: "core", label: "Core instructions", content: "Be concise." },
						{
							id: "tools",
							label: "Tool guidance",
							content: "Use tools carefully.",
						},
						{
							id: "skills",
							label: "Skill guidance",
							content: "No skills loaded.",
						},
					],
					toolSchemas: [
						{
							type: "function",
							function: {
								name: "glob",
								description: "List files",
								parameters: { type: "object" },
							},
						},
					],
				},
				loadedSkillNames: [],
			}) as never,
		setState: () => {},
		store: {} as never,
		writeLine: (line: string) => outputs.push(line),
	});

	assert.equal(outputs.length, 1);
	assert.match(outputs[0] ?? "", /Context window:/);
	assert.match(outputs[0] ?? "", /System prompt:/);
	assert.match(outputs[0] ?? "", /Tool definitions:/);
	assert.match(outputs[0] ?? "", /Summary memory:/);
	assert.match(outputs[0] ?? "", /Recent uncompressed messages:/);
	assert.equal((outputs[0] ?? "").includes("secret user text"), false);
	assert.equal((outputs[0] ?? "").includes("assistant body"), false);
});

test("getChatCommandSuggestions narrows matches by prefix", () => {
	const commands = createChatCommandDefinitions();

	assert.deepEqual(
		getChatCommandSuggestions("/", commands, 10).map((entry) => entry.name),
		[
			"/summary",
			"/compact",
			"/model",
			"/session",
			"/resume",
			"/new",
			"/exit",
			"/tasks",
			"/skill",
		],
	);
	assert.deepEqual(
		getChatCommandSuggestions("/re", commands).map((entry) => entry.name),
		["/resume"],
	);
	assert.deepEqual(getChatCommandSuggestions("/re more", commands), []);
	assert.deepEqual(getChatCommandSuggestions("plain text", commands), []);
});

test("/tasks lists running background tasks", async () => {
	const manager = new BackgroundTaskManager();
	const logPath = path.join(await createTempDir("sigpi-tasks-test-"), "t1.log");
	manager.spawn({
		id: "task-1",
		command: "sleep 2",
		invocation: { executable: "sleep", args: ["2"] },
		cwd: process.cwd(),
		logPath,
		description: "background nap",
	});

	const outputs: string[] = [];
	const commands = createChatCommandDefinitions({
		backgroundTaskManager: manager,
	});
	await executeChatCommand("/tasks", commands, {
		getState: () => ({}) as never,
		setState: () => {},
		store: {} as never,
		writeLine: (line: string) => outputs.push(line),
	} as never);

	assert.equal(outputs.length, 1);
	assert.match(outputs[0], /task-1/);
	assert.match(outputs[0], /\[running\]/);
	assert.match(outputs[0], /background nap/);

	manager.stop("task-1");
	await waitFor(() => manager.get("task-1")?.status === "done", 3000);
});

test("/tasks stop ends a background task and reports it", async () => {
	const manager = new BackgroundTaskManager();
	const logPath = path.join(await createTempDir("sigpi-tasks-test-"), "t2.log");
	manager.spawn({
		id: "task-2",
		command: "sleep 5",
		invocation: { executable: "sleep", args: ["5"] },
		cwd: process.cwd(),
		logPath,
		description: null,
	});

	const commands = createChatCommandDefinitions({
		backgroundTaskManager: manager,
	});
	const outputs: string[] = [];
	await executeChatCommand("/tasks stop task-2", commands, {
		getState: () => ({}) as never,
		setState: () => {},
		store: {} as never,
		writeLine: (line: string) => outputs.push(line),
	} as never);

	assert.match(outputs[0], /Stopped task task-2/);
	await waitFor(() => manager.get("task-2")?.status === "done", 3000);
});

test("/tasks reports when there are no background tasks", async () => {
	const manager = new BackgroundTaskManager();
	const commands = createChatCommandDefinitions({
		backgroundTaskManager: manager,
	});
	const outputs: string[] = [];
	await executeChatCommand("/tasks", commands, {
		getState: () => ({}) as never,
		setState: () => {},
		store: {} as never,
		writeLine: (line: string) => outputs.push(line),
	} as never);
	assert.equal(outputs[0], "No background tasks.");
});

test("/tasks stop reports unknown task ids", async () => {
	const manager = new BackgroundTaskManager();
	const commands = createChatCommandDefinitions({
		backgroundTaskManager: manager,
	});
	const outputs: string[] = [];
	await executeChatCommand("/tasks stop missing", commands, {
		getState: () => ({}) as never,
		setState: () => {},
		store: {} as never,
		writeLine: (line: string) => outputs.push(line),
	} as never);
	assert.match(outputs[0], /not found or already finished/);
});

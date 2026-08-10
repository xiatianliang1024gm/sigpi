import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { CompactionFailedError } from "../src/agent/compaction-error.js";
import { ConversationContext } from "../src/agent/context.js";
import { AgentRunner, summarizeToolExecutions } from "../src/agent/runner.js";
import {
	TurnInterruptController,
	TurnInterruptedError,
} from "../src/interrupt.js";
import { ModelRequestError } from "../src/model/transport.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ExecutedToolCall, TurnProgressEvent } from "../src/types.js";
import {
	createTempDir,
	MemoryLogger,
	MockProvider,
	stripMessageIds,
	writeWorkspaceFile,
} from "./helpers.js";

test("returns direct model output without tools", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "Hello from the model.",
		toolCalls: [],
		finishReason: "stop",
	}));

	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context: new ConversationContext(),
		systemPrompt: "You are a test agent.",
	});

	const result = await runner.runTurn("say hello");

	assert.equal(result.outputText, "Hello from the model.");
	assert.equal(result.toolExecutions.length, 0);
	assert.equal(result.steps, 1);
});

test("executes a tool call and feeds the result back to the model", async () => {
	const cwd = await createTempDir("sigpi-find-files-");
	await writeWorkspaceFile(cwd, "src/demo.ts", "export const demo = 1;\n");

	const provider = new MockProvider((request, index) => {
		if (index === 0) {
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
		}

		const toolMessage = request.messages.at(-1);
		assert.equal(toolMessage?.role, "tool");
		assert.match(toolMessage.content, /src\/demo\.ts/);

		return {
			assistantText: "I found the matching file.",
			toolCalls: [],
			finishReason: "stop",
		};
	});

	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context: new ConversationContext(),
		systemPrompt: "You are a test agent.",
		options: {
			workingDirectory: cwd,
		},
	});

	const result = await runner.runTurn("find TypeScript files under src");

	assert.equal(result.outputText, "I found the matching file.");
	assert.equal(result.toolExecutions.length, 1);
	assert.equal(result.toolExecutions[0]?.result.ok, true);
	assert.equal(result.steps, 2);
});

test("truncated file reads expose continuation metadata for the next tool call", async () => {
	const cwd = await createTempDir("sigpi-read-continuation-");
	// Write a file large enough to exceed DEFAULT_READ_MAX_CHARS
	const bigContent = Array.from(
		{ length: 6000 },
		(_, i) => `Line ${i + 1}`,
	).join("\n");
	await writeWorkspaceFile(cwd, "notes.txt", bigContent);

	const provider = new MockProvider((request, index) => {
		if (index === 0) {
			return {
				assistantText: null,
				toolCalls: [
					{
						id: "call_1",
						name: "read",
						arguments: { file_path: "notes.txt" },
						rawArguments: '{"file_path":"notes.txt"}',
					},
				],
				finishReason: "tool_calls",
			};
		}

		if (index === 1) {
			const toolMessage = request.messages.at(-1);
			assert.equal(toolMessage?.role, "tool");
			assert.match(toolMessage.content, /\[...truncated, continue from line/);
			assert.match(toolMessage.content, /Line 1/);

			return {
				assistantText: "Read complete.",
				toolCalls: [],
				finishReason: "stop",
			};
		}

		throw new Error("Unexpected extra turn");
	});

	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context: new ConversationContext(),
		systemPrompt: "You are a test agent.",
		options: {
			workingDirectory: cwd,
		},
	});

	const result = await runner.runTurn("read notes.txt");

	assert.equal(result.toolExecutions.length, 1);
	assert.equal(result.toolExecutions[0]?.toolCall.name, "read");
});

test("returns structured tool errors for invalid arguments", async () => {
	const provider = new MockProvider((request, index) => {
		if (index === 0) {
			return {
				assistantText: null,
				toolCalls: [
					{
						id: "call_1",
						name: "edit",
						arguments: {
							file_path: "demo.txt",
							old_string: "alpha",
							new_string: "beta",
						},
						rawArguments:
							'{"file_path":"demo.txt","old_string":"alpha","new_string":"beta"}',
					},
				],
				finishReason: "tool_calls",
			};
		}

		const toolMessage = request.messages.at(-1);
		assert.equal(toolMessage?.role, "tool");
		assert.match(toolMessage.content, /STATUS: error/);
		assert.match(toolMessage.content, /ERROR: File does not exist/);
		assert.match(toolMessage.content, /DETAILS:/);

		return {
			assistantText: "The patch was rejected.",
			toolCalls: [],
			finishReason: "stop",
		};
	});

	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context: new ConversationContext(),
		systemPrompt: "You are a test agent.",
	});

	const result = await runner.runTurn("apply an invalid patch");

	assert.equal(result.outputText, "The patch was rejected.");
	assert.equal(result.toolExecutions[0]?.result.ok, false);
});

test("assembles a local max-steps fallback without a final model call", async () => {
	const provider = new MockProvider(() => ({
		assistantText: null,
		toolCalls: [
			{
				id: "call_1",
				name: "glob",
				arguments: { pattern: "*.ts" },
				rawArguments: '{"pattern":"*.ts"}',
			},
		],
		finishReason: "tool_calls",
	}));
	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context: new ConversationContext(),
		systemPrompt: "You are a test agent.",
		options: {
			maxSteps: 2,
		},
	});

	const result = await runner.runTurn("loop forever");

	// The limit must end the turn with no extra model call: every request is a
	// normal tool-calling step (tools populated), so there is no tools:[]
	// synthesis request.
	assert.equal(provider.requests.length, 2);
	assert.ok(
		provider.requests.every((request) => (request.tools?.length ?? 0) > 0),
		"no tools:[] synthesis request should be fired at the limit",
	);
	assert.equal(result.steps, 2);
	assert.match(
		result.outputText ?? "",
		/I reached the maximum tool-call steps \(2\)/,
	);
	// glob is a search tool and is excluded from the file-op turn summary
	// (ADR-0022); with no file read/modify ops the summary reports none.
	assert.match(result.outputText ?? "", /No tool results were captured\./);
	assert.doesNotMatch(result.outputText ?? "", /glob/);
	assert.match(result.outputText ?? "", /go on/);
});

test("max-steps fallback contains no tool-call markup and prompts go on", async () => {
	const provider = new MockProvider(() => ({
		assistantText: null,
		toolCalls: [
			{
				id: "call_1",
				name: "read",
				arguments: { file_path: "README.md" },
				rawArguments: '{"file_path":"README.md"}',
			},
		],
		finishReason: "tool_calls",
	}));
	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context: new ConversationContext(),
		systemPrompt: "You are a test agent.",
		options: {
			maxSteps: 1,
		},
	});

	const result = await runner.runTurn("分析当前项目");

	assert.match(
		result.outputText ?? "",
		/I reached the maximum tool-call steps \(1\)/,
	);
	assert.match(result.outputText ?? "", /Read README\.md/);
	assert.match(result.outputText ?? "", /go on/);
	assert.doesNotMatch(result.outputText ?? "", /<tool_call>/);
	assert.doesNotMatch(result.outputText ?? "", /<invoke name=/);
});

test("interrupts an in-flight model request and returns interrupted status", async () => {
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
		systemPrompt: "You are a test agent.",
	});

	const result = await runner.runTurn("stop this request", interruptController);

	assert.equal(result.completionStatus, "interrupted");
	assert.equal(result.outputText, null);
	assert.equal(result.interruptStage, "model");
	assert.equal(result.interruptSource, "user_escape");
	assert.equal(result.toolExecutions.length, 0);
	assert.deepEqual(stripMessageIds(context.getRecentMessages()), [
		{ role: "user", content: "stop this request" },
	]);
});

test("interrupt during a tool preserves completed results and skips later tools", async () => {
	let secondToolCalled = false;
	const interruptController = new TurnInterruptController();
	const tools = new ToolRegistry([
		{
			name: "slow_tool",
			description: "slow tool",
			inputSchema: z.object({}).strict(),
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			execute: async () => {
				setTimeout(() => {
					interruptController.requestInterrupt();
				}, 10);
				await new Promise((resolve) => {
					setTimeout(resolve, 30);
				});
				return { ok: "first tool complete" };
			},
		},
		{
			name: "second_tool",
			description: "second tool",
			inputSchema: z.object({}).strict(),
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			execute: async () => {
				secondToolCalled = true;
				return { ok: "should not run" };
			},
		},
	]);
	const provider = new MockProvider((_request, index) => {
		if (index === 0) {
			return {
				assistantText: "I need to run two tools.",
				toolCalls: [
					{
						id: "call_1",
						name: "slow_tool",
						arguments: {},
						rawArguments: "{}",
					},
					{
						id: "call_2",
						name: "second_tool",
						arguments: {},
						rawArguments: "{}",
					},
				],
				finishReason: "tool_calls",
			};
		}

		return {
			assistantText: "should not reach a final answer",
			toolCalls: [],
			finishReason: "stop",
		};
	});
	const context = new ConversationContext();
	const runner = new AgentRunner({
		provider,
		tools,
		context,
		systemPrompt: "You are a test agent.",
	});

	const result = await runner.runTurn("run both tools", interruptController);

	assert.equal(result.completionStatus, "interrupted");
	assert.equal(result.interruptStage, "tool");
	assert.equal(result.toolExecutions.length, 1);
	assert.equal(result.toolExecutions[0]?.toolCall.name, "slow_tool");
	assert.equal(secondToolCalled, false);
	// The interrupted assistant message carried two tool calls; the second
	// never ran, so the recovered transcript must pair it with a synthetic
	// interrupted result instead of leaving it dangling.
	const messages = context.getRecentMessages();
	assert.deepEqual(
		messages.map((message) => message.role),
		["user", "assistant", "tool", "tool"],
	);
	const interruptedResult = messages[3];
	if (interruptedResult?.role === "tool") {
		assert.equal(interruptedResult.toolCallId, "call_2");
		assert.match(interruptedResult.content, /interrupted/i);
	} else {
		assert.fail("expected a synthetic result for the skipped tool call");
	}
});

test("closes a dangling tool call when a tool aborts mid-execution on interrupt", async () => {
	const interruptController = new TurnInterruptController();
	const tools = new ToolRegistry([
		{
			name: "abortable_tool",
			description: "tool that is still running when the user hits Esc",
			inputSchema: z.object({}).strict(),
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			execute: async (_args, context) => {
				// The user hits Esc ~10ms into the tool's run, exactly like a
				// long-running bash command being aborted.
				setTimeout(() => {
					interruptController.requestInterrupt();
				}, 10);
				await new Promise((_resolve, reject) => {
					const onAbort = () => {
						reject(
							context.abortSignal?.reason ??
								new TurnInterruptedError("user_escape", "tool"),
						);
					};
					context.abortSignal?.addEventListener("abort", onAbort, {
						once: true,
					});
				});
				return { ok: "should not be reached" };
			},
		},
	]);
	const provider = new MockProvider((_request, index) => {
		if (index === 0) {
			return {
				assistantText: "Running the abortable tool.",
				toolCalls: [
					{
						id: "call_aborted",
						name: "abortable_tool",
						arguments: {},
						rawArguments: "{}",
					},
				],
				finishReason: "tool_calls",
			};
		}

		return {
			assistantText: "continued",
			toolCalls: [],
			finishReason: "stop",
		};
	});
	const context = new ConversationContext();
	const runner = new AgentRunner({
		provider,
		tools,
		context,
		systemPrompt: "You are a test agent.",
	});

	const result = await runner.runTurn(
		"run the abortable tool",
		interruptController,
	);

	assert.equal(result.completionStatus, "interrupted");
	assert.equal(result.interruptStage, "tool");

	// The aborted tool produced no result, but the recovered transcript must
	// pair the assistant tool call with a synthetic interrupted result —
	// otherwise the next request carries a tool call without an output and
	// providers reject it (400 "No tool output found for tool call ...").
	const messages = stripMessageIds(context.getRecentMessages());
	assert.deepEqual(
		messages.map((message) => message.role),
		["user", "assistant", "tool"],
	);
	const toolMessage = context.getRecentMessages()[2];
	if (toolMessage?.role === "tool") {
		assert.equal(toolMessage.toolCallId, "call_aborted");
		assert.match(toolMessage.content ?? "", /interrupted/i);
	} else {
		assert.fail("expected a tool message closing the aborted tool call");
	}

	// A follow-up turn must be able to continue from the recovered transcript
	// with every tool call answered.
	const second = await runner.runTurn(
		"continue",
		new TurnInterruptController(),
	);
	assert.equal(second.completionStatus, "completed");

	const followUpRequest = provider.requests.at(-1);
	assert.ok(followUpRequest);
	const answered = new Set<string>();
	for (const message of followUpRequest.messages) {
		if (message.role === "tool" && message.toolCallId) {
			answered.add(message.toolCallId);
		}
	}
	for (const message of followUpRequest.messages) {
		if (message.role === "assistant" && message.toolCalls) {
			for (const toolCall of message.toolCalls) {
				assert.ok(
					answered.has(toolCall.id),
					`tool call ${toolCall.id} must have an output in the follow-up request`,
				);
			}
		}
	}
});

test("compacts before a request when the estimate exceeds the soft limit", async () => {
	const provider = new MockProvider((request) => {
		if (request.context?.purpose === "summary") {
			return {
				assistantText:
					"User asked for a long explanation; keep the key facts only.",
				toolCalls: [],
				finishReason: "stop",
			};
		}

		return {
			assistantText: "final response",
			toolCalls: [],
			finishReason: "stop",
		};
	});

	const context = new ConversationContext({
		summaryEnabled: true,
		getContextBudget: () => ({
			hardContextLimit: 40,
			reserveTokens: 2,
			keepRecentTokens: 5,
		}),
		keepRecentMessagesFloor: 2,
	});

	const progressEvents: TurnProgressEvent[] = [];
	const runner = new AgentRunner({
		provider,
		tools: new ToolRegistry([]),
		context,
		systemPrompt: "You are a test agent.",
		options: {
			progressReporter: (event) => {
				progressEvents.push(event);
			},
		},
	});

	// One short turn (~22 tokens: 10 system + 12 message) stays below the
	// 38-token soft limit; the second turn's persisted window
	// (10 + 12 + 8 + 11 = 41) crosses it and must compact before the request.
	await runner.runTurn("A short but real user message.");
	assert.equal(
		context.getSummary(),
		null,
		"a single short turn must not trigger compaction",
	);
	progressEvents.length = 0;

	const second = await runner.runTurn("One more short user message.");

	// The turn continued after the pre-request compaction and produced a real
	// answer instead of failing or stopping.
	assert.equal(second.outputText, "final response");
	assert.equal(
		context.getSummary(),
		"User asked for a long explanation; keep the key facts only.",
	);
	// The split summarized the older message and kept the recent one live.
	const transcript = context
		.getRecentMessages()
		.map((message) => message.content ?? "")
		.join("\n");
	assert.doesNotMatch(transcript, /A short but real user message/);
	assert.match(transcript, /One more short user message/);

	const compactedEvent = progressEvents.find(
		(event) => event.type === "context_compacted",
	);
	assert.ok(
		compactedEvent,
		"estimate-triggered compaction must emit context_compacted",
	);
	assert.equal(compactedEvent?.trigger, "token");
	assert.equal(typeof compactedEvent?.tokensBefore, "number");
	assert.equal(typeof compactedEvent?.tokensAfter, "number");

	// Requests: first turn, summary request, second turn.
	assert.equal(provider.requests.length, 3);
	assert.equal(provider.requests[1]?.context?.purpose, "summary");
});

test("retries a provider context_length_exceeded after a forced compaction", async () => {
	const provider = new MockProvider((request, index) => {
		if (request.context?.purpose === "summary") {
			return {
				assistantText: "Compacted summary of the failed request.",
				toolCalls: [],
				finishReason: "stop",
			};
		}
		if (index === 0) {
			throw new ModelRequestError(
				"Model request exceeded the context window",
				"context_length_exceeded",
			);
		}
		return {
			assistantText: "recovered answer",
			toolCalls: [],
			finishReason: "stop",
		};
	});

	const context = new ConversationContext({ summaryEnabled: true });
	const progressEvents: TurnProgressEvent[] = [];
	const runner = new AgentRunner({
		provider,
		tools: new ToolRegistry([]),
		context,
		systemPrompt: "You are a test agent.",
		options: {
			progressReporter: (event) => {
				progressEvents.push(event);
			},
		},
	});

	const result = await runner.runTurn("hello");

	// The 400 was retried after a forced compaction and the turn completed.
	assert.equal(result.outputText, "recovered answer");
	assert.equal(
		context.getSummary(),
		"Compacted summary of the failed request.",
	);
	// Requests: failed turn request, summary, retried turn request.
	assert.equal(provider.requests.length, 3);
	const compactedEvent = progressEvents.find(
		(event) => event.type === "context_compacted",
	);
	assert.ok(compactedEvent, "force compaction must emit context_compacted");
	assert.equal(compactedEvent?.trigger, "force");
	// The persisted window shrank from [user] to [] (the user message was
	// summarized); the summary itself is counted separately in tokensAfter.
	assert.equal(typeof compactedEvent?.tokensBefore, "number");
	assert.equal(typeof compactedEvent?.tokensAfter, "number");
});

test("gives up after the context_length_exceeded retry fails instead of looping", async () => {
	const provider = new MockProvider((request) => {
		if (request.context?.purpose === "summary") {
			return {
				assistantText: "shrunken summary",
				toolCalls: [],
				finishReason: "stop",
			};
		}
		throw new ModelRequestError(
			"Model request exceeded the context window",
			"context_length_exceeded",
		);
	});

	const runner = new AgentRunner({
		provider,
		tools: new ToolRegistry([]),
		context: new ConversationContext({ summaryEnabled: true }),
		systemPrompt: "You are a test agent.",
	});

	await assert.rejects(
		runner.runTurn("hello"),
		(error) =>
			error instanceof ModelRequestError &&
			error.kind === "context_length_exceeded",
	);

	// Initial request + exactly one retry (ADR 0026, D3: "retries the original
	// request once"). The forced compaction summarized the only message, so no
	// further summary requests fire — the retry fails the turn instead of
	// looping the compact → 400 cycle.
	assert.equal(provider.requests.length, 3);
	assert.equal(
		provider.requests.filter((request) => request.context?.purpose === "turn")
			.length,
		2,
	);
	assert.equal(
		provider.requests.filter(
			(request) => request.context?.purpose === "summary",
		).length,
		1,
	);
});

test("never persists an empty model response", async () => {
	const provider = new MockProvider((request, index) => {
		if (index === 0) {
			return {
				assistantText: null,
				toolCalls: [],
				finishReason: "stop",
			};
		}
		return {
			assistantText: "real answer",
			toolCalls: [],
			finishReason: "stop",
		};
	});

	const context = new ConversationContext();
	const runner = new AgentRunner({
		provider,
		tools: new ToolRegistry([]),
		context,
		systemPrompt: "You are a test agent.",
	});

	const result = await runner.runTurn("hello");

	assert.equal(result.outputText, "real answer");
	assert.equal(result.steps, 2);
	// The empty response was re-prompted, never appended: the transcript holds
	// only the user input and the real answer.
	assert.deepEqual(
		stripMessageIds(context.getRecentMessages()).map((message) => message.role),
		["user", "assistant"],
	);
	assert.equal(context.getRecentMessages()[1]?.content, "real answer");
	// The retry note reaches the model on the second request.
	assert.match(
		JSON.stringify(provider.requests[1]?.messages ?? []),
		/previous response was empty/,
	);
});

test("retries an empty model response when the context has room", async () => {
	const provider = new MockProvider((_request, index) => {
		if (index < 2) {
			return {
				assistantText: null,
				toolCalls: [],
				finishReason: "stop",
			};
		}
		return {
			assistantText: "real answer after the glitch",
			toolCalls: [],
			finishReason: "stop",
		};
	});

	const runner = new AgentRunner({
		provider,
		tools: new ToolRegistry([]),
		context: new ConversationContext(),
		systemPrompt: "You are a test agent.",
	});

	const result = await runner.runTurn("hello");

	assert.equal(result.outputText, "real answer after the glitch");
	assert.equal(result.steps, 3);
	// Two retries are bounded: a third empty response must end the turn.
	const alwaysEmpty = new MockProvider(() => ({
		assistantText: null,
		toolCalls: [],
		finishReason: "stop",
	}));
	const boundedRunner = new AgentRunner({
		provider: alwaysEmpty,
		tools: new ToolRegistry([]),
		context: new ConversationContext(),
		systemPrompt: "You are a test agent.",
	});
	const bounded = await boundedRunner.runTurn("hello");
	assert.equal(bounded.outputText, "No response generated.");
	assert.equal(bounded.steps, 3);
});

test("surfaces insufficient compaction as a turn failure instead of silently dropping messages", async () => {
	const provider = new MockProvider((request) => {
		if (request.context?.purpose === "summary") {
			return {
				assistantText: "summary",
				toolCalls: [],
				finishReason: "stop",
			};
		}
		throw new ModelRequestError(
			"Model request exceeded the context window",
			"context_length_exceeded",
		);
	});

	const context = new ConversationContext({
		summaryEnabled: true,
		getContextBudget: () => ({
			hardContextLimit: 80,
			reserveTokens: 2,
			keepRecentTokens: 5,
		}),
	});
	// The system prompt alone (~130 tokens) cannot fit the 78-token soft
	// limit, so even a forced compaction cannot satisfy the D6 post-check.
	const runner = new AgentRunner({
		provider,
		tools: new ToolRegistry([]),
		context,
		systemPrompt: "A very long system prompt ".repeat(20) + "padding.",
	});

	await assert.rejects(
		runner.runTurn("hello"),
		(error) =>
			error instanceof CompactionFailedError &&
			error.reason === "insufficient_compaction",
	);

	// D4: nothing was dropped — the user message is still in the transcript.
	assert.equal(context.getRecentMessages().length, 1);
});

test("runner emits progress events during multi-step execution", async () => {
	const progressEvents: TurnProgressEvent[] = [];
	const cwd = await createTempDir("sigpi-progress-find-files-");
	await writeWorkspaceFile(cwd, "src/demo.ts", "export const demo = 1;\n");
	const provider = new MockProvider((_request, index) => {
		if (index === 0) {
			return {
				assistantText: "I will find the matching file first.",
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

		return {
			assistantText: "I found the file.",
			toolCalls: [],
			finishReason: "stop",
		};
	});

	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context: new ConversationContext(),
		systemPrompt: "You are a test agent.",
		options: {
			workingDirectory: cwd,
			progressReporter: (event) => {
				progressEvents.push(event);
			},
		},
	});

	const result = await runner.runTurn("find TypeScript files");

	assert.equal(result.outputText, "I found the file.");
	assert.equal(
		progressEvents.find((event) => event.type === "turn_started")?.userInput,
		"find TypeScript files",
	);
	assert.deepEqual(
		progressEvents.map((event) => event.type),
		[
			"turn_started",
			"step_started",
			"model_request_started",
			"model_request_finished",
			"assistant_message",
			"tool_calls_received",
			"tool_execution_started",
			"tool_execution_finished",
			"step_started",
			"model_request_started",
			"model_request_finished",
			"turn_finished",
		],
	);
	assert.equal(
		progressEvents.find((event) => event.type === "assistant_message")
			?.assistantText,
		"I will find the matching file first.",
	);
	assert.equal(
		progressEvents.find((event) => event.type === "tool_execution_started")
			?.message,
		'find files matching "src/**/*.ts"',
	);
	const toolFinishedEvent = progressEvents.find(
		(event) => event.type === "tool_execution_finished",
	);
	assert.match(toolFinishedEvent?.toolResult ?? "", /src\/demo\.ts/);
});

test("runner progress includes structured file edit results", async () => {
	const cwd = await createTempDir("sigpi-progress-edit-summary-");
	await writeWorkspaceFile(cwd, "demo.txt", "old\n");
	const progressEvents: TurnProgressEvent[] = [];
	const provider = new MockProvider((_, index) => {
		if (index === 0) {
			return {
				assistantText: null,
				toolCalls: [
					{
						id: "call_write_progress_1",
						name: "write",
						arguments: {
							file_path: "demo.txt",
							content: "new\n",
						},
						rawArguments: "{}",
					},
				],
				finishReason: "tool_calls",
			};
		}

		return {
			assistantText: "done",
			toolCalls: [],
			finishReason: "stop",
		};
	});
	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context: new ConversationContext(),
		systemPrompt: "You are a test agent.",
		options: {
			maxSteps: 4,
			temperature: 0,
			workingDirectory: cwd,
			progressReporter: (event) => {
				progressEvents.push(event);
			},
		},
	});

	await runner.runTurn("update demo");

	const toolFinishedEvent = progressEvents.find(
		(event) => event.type === "tool_execution_finished",
	);
	assert.equal(toolFinishedEvent?.toolName, "write");
	assert.equal(toolFinishedEvent?.toolResult ?? "", "ok");
	assert.match(
		JSON.stringify(toolFinishedEvent?.toolResultData),
		/"editSummary"/,
	);
});

test("runner progress includes shell command detail", async () => {
	const progressEvents: TurnProgressEvent[] = [];
	const provider = new MockProvider((_, index) => {
		if (index === 0) {
			return {
				assistantText: "I need to inspect the directory contents.",
				toolCalls: [
					{
						id: "call_1",
						name: "bash",
						arguments: { command: "pwd" },
						rawArguments: '{"command":"pwd"}',
					},
				],
				finishReason: "tool_calls",
			};
		}

		return {
			assistantText: "done",
			toolCalls: [],
			finishReason: "stop",
		};
	});

	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context: new ConversationContext(),
		systemPrompt: "You are a test agent.",
		options: {
			progressReporter: (event) => {
				progressEvents.push(event);
			},
		},
	});

	await runner.runTurn("where am i?");

	const shellEvent = progressEvents.find(
		(event) =>
			event.type === "tool_execution_started" && event.toolName === "bash",
	);

	assert.equal(shellEvent?.message, "shell pwd");
	assert.equal(shellEvent?.detail, undefined);
});

test("summarizeToolExecutions records only file read/modify ops (ADR-0022)", () => {
	const exec = (
		name: string,
		args: Record<string, unknown>,
	): ExecutedToolCall => ({
		toolCall: {
			id: `${name}-${Math.random()}`,
			name,
			arguments: args,
			rawArguments: JSON.stringify(args),
		},
		result: { ok: true, data: {} },
	});

	const executions: ExecutedToolCall[] = [
		exec("read", { file_path: "/a.ts" }),
		exec("bash", { command: "pwd && ls -la" }),
		exec("grep", { pattern: "foo" }),
		exec("glob", { pattern: "**/*.ts" }),
		exec("edit", { file_path: "/a.ts" }),
		exec("write", { file_path: "/b.ts" }),
		exec("update-plan", { plan: [] }),
		exec("read", { file_path: "/a.ts" }),
	];

	const summary = summarizeToolExecutions(executions);

	// bash/grep/glob/update-plan excluded; /a.ts collapsed to a single Modified.
	assert.deepEqual(summary, ["Modified /a.ts", "Modified /b.ts"]);
});

test("summarizeToolExecutions caps at 20 lines", () => {
	const exec = (i: number): ExecutedToolCall => ({
		toolCall: {
			id: `read-${i}`,
			name: "read",
			arguments: { file_path: `/file-${i}.ts` },
			rawArguments: `{"file_path":"/file-${i}.ts"}`,
		},
		result: { ok: true, data: {} },
	});

	const executions = Array.from({ length: 50 }, (_, i) => exec(i));
	const summary = summarizeToolExecutions(executions);

	assert.equal(summary.length, 20);
});

test("turn_finished estimate uses provider usage, not the chars/4 fallback", async () => {
	// Regression: the final assistant message of a direct-answer turn used to
	// be missing from `workingMessages`, so `lastUsage.messageIndex` pointed
	// one past the working list. The usage ground-truth path was skipped and
	// `turn_finished` reported the inflated chars/4 estimate (~5.2K vs the
	// provider's ~2.3K on the real minimax session), making the status bar
	// jump between turns.
	const provider = new MockProvider((_request, index) => {
		if (index === 0) {
			return {
				assistantText: "first answer",
				toolCalls: [],
				finishReason: "stop",
				usage: {
					input: 900,
					output: 100,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_000,
				},
			};
		}
		return {
			assistantText: "second answer",
			toolCalls: [],
			finishReason: "stop",
			usage: {
				input: 1_100,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_200,
			},
		};
	});

	const progressEvents: TurnProgressEvent[] = [];
	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context: new ConversationContext(),
		systemPrompt: "You are a test agent.",
		options: {
			progressReporter: (event) => {
				progressEvents.push(event);
			},
		},
	});

	await runner.runTurn("first question");
	await runner.runTurn("second question");

	const finished = progressEvents.filter(
		(event) => event.type === "turn_finished",
	);
	assert.equal(finished.length, 2);
	const estimate = finished[1]?.estimatedContextTokens;
	assert.ok(
		estimate !== undefined && estimate >= 1_200 && estimate < 1_500,
		`expected the provider-reported 1.2K ground truth, got ${estimate}`,
	);
});

test("turn_finished reports accumulated provider usage across the turn", async () => {
	const progressEvents: TurnProgressEvent[] = [];
	const logger = new MemoryLogger();
	const usagePerRequest = [
		{
			input: 1_000,
			output: 200,
			cacheRead: 100,
			cacheWrite: 50,
			totalTokens: 1_350,
		},
		{
			input: 1_200,
			output: 500,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_700,
		},
	] as const;

	const provider = new MockProvider((_request, index) => {
		const usage = usagePerRequest[index] ?? usagePerRequest.at(-1);
		if (index === 0) {
			return {
				assistantText: null,
				toolCalls: [
					{
						id: "call_usage_1",
						name: "glob",
						arguments: { pattern: "no-such-file-xyz/**" },
						rawArguments: '{"pattern":"no-such-file-xyz/**"}',
					},
				],
				finishReason: "tool_calls",
				usage,
			};
		}
		return {
			assistantText: "Done.",
			toolCalls: [],
			finishReason: "stop",
			usage,
		};
	});

	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context: new ConversationContext(),
		systemPrompt: "You are a test agent.",
		options: {
			workingDirectory: process.cwd(),
			progressReporter: (event) => {
				progressEvents.push(event);
			},
			logger,
		},
	});

	const result = await runner.runTurn("do the thing");
	assert.equal(result.outputText, "Done.");

	const finished = progressEvents.find(
		(event) => event.type === "turn_finished",
	);
	assert.ok(finished, "expected a turn_finished event");
	assert.deepEqual(finished.turnTokens, {
		input: 2_200,
		output: 700,
		cacheRead: 100,
		cacheWrite: 50,
		totalTokens: 3_050,
	});

	const logEntry = logger.entries.find(
		(entry) => entry.event === "turn_finished",
	);
	assert.ok(logEntry, "expected a turn_finished log entry");
	assert.equal(logEntry.fields?.inputTokens, 2_200);
	assert.equal(logEntry.fields?.outputTokens, 700);
	assert.equal(logEntry.fields?.turnTotalTokens, 3_050);
	assert.equal(typeof logEntry.fields?.turnElapsedMs, "number");
});

test("terminal events omit turnTokens when the provider reports no usage", async () => {
	const progressEvents: TurnProgressEvent[] = [];
	const provider = new MockProvider(() => ({
		assistantText: "Plain answer.",
		toolCalls: [],
		finishReason: "stop",
	}));

	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context: new ConversationContext(),
		systemPrompt: "You are a test agent.",
		options: {
			workingDirectory: process.cwd(),
			progressReporter: (event) => {
				progressEvents.push(event);
			},
		},
	});

	await runner.runTurn("hello");

	const finished = progressEvents.find(
		(event) => event.type === "turn_finished",
	);
	assert.ok(finished);
	assert.equal(finished.turnTokens, undefined);
});

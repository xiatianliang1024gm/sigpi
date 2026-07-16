import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { z } from "zod";
import { ConversationContext } from "../src/agent/context.js";
import { AgentRunner, summarizeToolExecutions } from "../src/agent/runner.js";
import { TurnInterruptController } from "../src/interrupt.js";
import { createShellRuntime } from "../src/shell.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ExecutedToolCall, TurnProgressEvent } from "../src/types.js";
import {
	createTempDir,
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
		assert.match(toolMessage.content, /TOOL: glob/);
		assert.match(toolMessage.content, /STATUS: ok/);
		assert.match(toolMessage.content, /RESULT:/);
		assert.match(toolMessage.content, /Files:/);
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
			assert.match(toolMessage.content, /PARTIAL view/);
			assert.match(toolMessage.content, /read\(\{"file_path":"notes.txt"/);

			return {
				assistantText: null,
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
	assert.match(result.outputText ?? "", /Current goal: loop forever/);
	assert.match(result.outputText ?? "", /Work done this turn:/);
	// glob is a search tool and is excluded from the file-op turn summary
	// (ADR-0022); with no file read/modify ops the summary reports none.
	assert.match(result.outputText ?? "", /No tool results were captured\./);
	assert.doesNotMatch(result.outputText ?? "", /glob/);
	assert.match(result.outputText ?? "", /go on/);
	assert.equal(result.resumable, true);
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
	assert.match(result.outputText ?? "", /Current goal: 分析当前项目/);
	assert.match(result.outputText ?? "", /Read README\.md/);
	assert.match(result.outputText ?? "", /go on/);
	assert.doesNotMatch(result.outputText ?? "", /<tool_call>/);
	assert.doesNotMatch(result.outputText ?? "", /<invoke name=/);
	assert.equal(result.resumable, true);
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
	assert.deepEqual(
		context.getRecentMessages().map((message) => message.role),
		["user", "assistant", "tool"],
	);
});

test("summarizes older context when the token threshold is exceeded", async () => {
	const provider = new MockProvider((request) => {
		const summarizing =
			request.tools.length === 0 && request.messages.length === 3;

		if (summarizing) {
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
			hardContextLimit: 35,
			reserveTokens: 2,
			keepRecentTokens: 5,
		}),
		keepRecentMessagesFloor: 2,
	});

	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(),
		context,
		systemPrompt: "You are a test agent.",
	});

	const longUserMessage =
		"A very long message that should trigger summarization when combined with the system prompt and tool definitions. ".repeat(
			6,
		);
	const longSecondMessage =
		"Another long message that should keep pressure on context. ".repeat(6);
	await runner.runTurn(longUserMessage);
	const second = await runner.runTurn(longSecondMessage);

	assert.equal(second.contextUpdated.summarized, true);
	assert.equal(
		context.getSummary(),
		"User asked for a long explanation; keep the key facts only.",
	);
	assert.ok(context.getRecentMessages().length <= 2);
});

test("compacts oversized in-turn tool context while preserving current goal", async () => {
	const progressEvents: TurnProgressEvent[] = [];
	const tools = new ToolRegistry([
		{
			name: "large_read",
			description: "Return a large file-like payload",
			inputSchema: z.object({ label: z.string() }).strict(),
			parameters: {
				type: "object",
				properties: {
					label: { type: "string" },
				},
				required: ["label"],
				additionalProperties: false,
			},
			execute: ({ label }) => ({
				label,
				content: `${label}:${"x".repeat(500)}`,
			}),
		},
	]);
	const provider = new MockProvider((request, index) => {
		if (request.context?.purpose === "summary") {
			const prompt = request.messages.at(-1)?.content ?? "";
			assert.match(prompt, /<current-user-goal>/);
			assert.match(prompt, /Analyze the project and explain the architecture/);
			assert.match(prompt, /large_read/);
			return {
				assistantText: [
					"## Current Goal",
					"Analyze the project and explain the architecture.",
					"",
					"## Work Done This Turn",
					"- Read several large project files.",
					"",
					"## Key Findings",
					"- Large read payloads were compacted.",
					"",
					"## Next Step",
					"1. Continue analysis from the recent files.",
				].join("\n"),
				toolCalls: [],
				finishReason: "stop",
			};
		}

		if (index === 0) {
			return {
				assistantText: null,
				toolCalls: [
					{
						id: "call_1",
						name: "large_read",
						arguments: { label: "one" },
						rawArguments: '{"label":"one"}',
					},
				],
				finishReason: "tool_calls",
			};
		}

		if (index === 1) {
			return {
				assistantText: null,
				toolCalls: [
					{
						id: "call_2",
						name: "large_read",
						arguments: { label: "two" },
						rawArguments: '{"label":"two"}',
					},
				],
				finishReason: "tool_calls",
			};
		}

		if (index === 2) {
			return {
				assistantText: null,
				toolCalls: [
					{
						id: "call_3",
						name: "large_read",
						arguments: { label: "three" },
						rawArguments: '{"label":"three"}',
					},
				],
				finishReason: "tool_calls",
			};
		}

		const joinedMessages = request.messages
			.map((message) => message.content ?? "")
			.join("\n");
		assert.match(joinedMessages, /Current turn checkpoint/);
		assert.match(joinedMessages, /## Current Goal/);
		assert.match(
			joinedMessages,
			/Analyze the project and explain the architecture/,
		);
		assert.doesNotMatch(joinedMessages, /one:x{100}/);
		request.messages.forEach((message, messageIndex) => {
			if (message.role !== "tool") {
				return;
			}
			const previousMessage = request.messages[messageIndex - 1];
			assert.equal(previousMessage?.role, "assistant");
			assert.ok(previousMessage.toolCalls?.length);
		});

		return {
			assistantText: "Architecture summary.",
			toolCalls: [],
			finishReason: "stop",
		};
	});
	const context = new ConversationContext({
		summaryEnabled: true,
		getContextBudget: () => ({
			hardContextLimit: 200,
			reserveTokens: 10,
			keepRecentTokens: 30,
		}),
	});
	const runner = new AgentRunner({
		provider,
		tools,
		context,
		systemPrompt: "You are a test agent.",
		options: {
			maxSteps: 5,
			progressReporter: (event) => {
				progressEvents.push(event);
			},
		},
	});

	const result = await runner.runTurn(
		"Analyze the project and explain the architecture",
	);

	assert.equal(result.outputText, "Architecture summary.");
	assert.equal(result.toolExecutions.length, 3);
	assert.ok(
		provider.requests.some((request) => request.context?.purpose === "summary"),
	);
	const checkpointEvent = progressEvents.find(
		(event) => event.type === "context_checkpoint",
	);
	assert.match(
		checkpointEvent?.message ?? "",
		/checkpoint compacted current turn/,
	);
	assert.match(
		checkpointEvent?.message ?? "",
		/Analyze the project and explain the architecture/,
	);
	assert.match(
		checkpointEvent?.detail ?? "",
		/estimated context before checkpoint/,
	);
});

test("checkpoint goal uses prior task when the user says continue", async () => {
	const progressEvents: TurnProgressEvent[] = [];
	const tools = new ToolRegistry([
		{
			name: "large_read",
			description: "Return a large file-like payload",
			inputSchema: z.object({ label: z.string() }).strict(),
			parameters: {
				type: "object",
				properties: {
					label: { type: "string" },
				},
				required: ["label"],
				additionalProperties: false,
			},
			execute: ({ label }) => ({
				label,
				content: `${label}:${"x".repeat(500)}`,
			}),
		},
	]);
	const context = new ConversationContext({
		summaryEnabled: true,
		getContextBudget: () => ({
			hardContextLimit: 200,
			reserveTokens: 10,
			keepRecentTokens: 30,
		}),
	});
	context.hydrateState({
		summary:
			"## Goal\n分析当前项目\n\n## Next Steps\n1. Continue reading source files.",
		recentMessages: [
			{ role: "user", content: "分析当前项目" },
			{ role: "assistant", content: "I started inspecting the project." },
		],
	});
	const provider = new MockProvider((request, index) => {
		if (request.context?.purpose === "summary") {
			const prompt = request.messages.at(-1)?.content ?? "";
			assert.match(
				prompt,
				/<current-user-goal>\n分析当前项目\n<\/current-user-goal>/,
			);
			assert.doesNotMatch(
				prompt,
				/<current-user-goal>\n继续\n<\/current-user-goal>/,
			);
			return {
				assistantText: "## Current Goal\n分析当前项目",
				toolCalls: [],
				finishReason: "stop",
			};
		}

		if (index < 3) {
			const label = `read-${index + 1}`;
			return {
				assistantText: null,
				toolCalls: [
					{
						id: `call_${index + 1}`,
						name: "large_read",
						arguments: { label },
						rawArguments: JSON.stringify({ label }),
					},
				],
				finishReason: "tool_calls",
			};
		}

		return {
			assistantText: "继续完成分析。",
			toolCalls: [],
			finishReason: "stop",
		};
	});
	const runner = new AgentRunner({
		provider,
		tools,
		context,
		systemPrompt: "You are a test agent.",
		options: {
			maxSteps: 5,
			progressReporter: (event) => {
				progressEvents.push(event);
			},
		},
	});

	await runner.runTurn("继续");

	const checkpointEvent = progressEvents.find(
		(event) => event.type === "context_checkpoint",
	);
	assert.match(checkpointEvent?.message ?? "", /goal: 分析当前项目/);
	assert.doesNotMatch(checkpointEvent?.message ?? "", /goal: 继续/);
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
	assert.match(toolFinishedEvent?.toolResult ?? "", /TOOL: glob/);
	assert.match(toolFinishedEvent?.toolResult ?? "", /STATUS: ok/);
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
	assert.match(toolFinishedEvent?.toolResult ?? "", /TOOL: write/);
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

test("runner nudges the model to verify changes before finishing", async () => {
	const cwd = await createTempDir("sigpi-verify-");
	const shellRuntime = createShellRuntime(
		process.platform === "win32" ? "powershell" : "sh",
		process.platform,
	);
	const verificationCommand =
		process.platform === "win32"
			? "if (Test-Path note.txt) { Write-Output ok } else { exit 1 }"
			: "test -f note.txt && printf 'ok'";
	const provider = new MockProvider((request, index) => {
		if (index === 0) {
			return {
				assistantText: "I will update the file.",
				toolCalls: [
					{
						id: "call_write_1",
						name: "write",
						arguments: {
							file_path: "note.txt",
							content: "updated\n",
						},
						rawArguments: '{"path":"note.txt","content":"updated\\n"}',
					},
				],
				finishReason: "tool_calls",
			};
		}

		if (index === 1) {
			return {
				assistantText: "The file has been updated.",
				toolCalls: [],
				finishReason: "stop",
			};
		}

		if (index === 2) {
			assert.equal(request.messages.at(-1)?.role, "user");
			assert.match(
				request.messages.at(-1)?.content ?? "",
				/You changed files in this turn/i,
			);
			return {
				assistantText: "I should verify the file change.",
				toolCalls: [
					{
						id: "call_verify_1",
						name: "bash",
						arguments: { command: verificationCommand },
						rawArguments: JSON.stringify({ command: verificationCommand }),
					},
				],
				finishReason: "tool_calls",
			};
		}

		return {
			assistantText: "Verified.",
			toolCalls: [],
			finishReason: "stop",
		};
	});

	const runner = new AgentRunner({
		provider,
		tools: createDefaultToolRegistry(shellRuntime),
		context: new ConversationContext(),
		systemPrompt: "You are a test agent.",
		options: {
			workingDirectory: cwd,
			enableVerificationReminder: true,
		},
	});

	const result = await runner.runTurn("update note.txt");

	assert.equal(result.outputText, "Verified.");
	assert.deepEqual(
		result.toolExecutions.map((execution) => execution.toolCall.name),
		["write", "bash"],
	);
	assert.equal(await readFile(`${cwd}/note.txt`, "utf8"), "updated\n");
	assert.equal(provider.requests.length, 4);
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

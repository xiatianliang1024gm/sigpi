import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createSubAgentRunner } from "../src/agent/sub-agent.js";
import { buildSubAgentSystemPrompt } from "../src/defaults.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolDefinition, TurnProgressEvent } from "../src/types.js";
import { MockProvider } from "./helpers.js";

const noteTool: ToolDefinition<{ text: string }> = {
	name: "note",
	description: "Record a note.",
	inputSchema: z.object({ text: z.string() }),
	parameters: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
		additionalProperties: false,
	},
	execute: ({ text }) => ({ recorded: text }),
};

test("run() returns the sub-agent's final assistant text", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "The conclusion is X.",
		toolCalls: [],
		finishReason: "stop",
	}));

	const runner = createSubAgentRunner({
		provider,
		tools: new ToolRegistry(),
		systemPrompt: "You are a sub-agent.",
		workingDirectory: process.cwd(),
		maxSteps: 5,
	});

	const result = await runner.run({ description: "investigate" });

	assert.equal(result.outputText, "The conclusion is X.");
	assert.equal(result.completionStatus, "completed");
	assert.equal(result.steps, 1);
});

test("run() drives a tool call and returns the final text", async () => {
	const provider = new MockProvider((_request, index) => {
		if (index === 0) {
			return {
				assistantText: null,
				toolCalls: [
					{
						id: "call_1",
						name: "note",
						arguments: { text: "gather evidence" },
						rawArguments: '{"text":"gather evidence"}',
					},
				],
				finishReason: "tool_calls",
			};
		}
		return {
			assistantText: "Final conclusion after tool use.",
			toolCalls: [],
			finishReason: "stop",
		};
	});

	const runner = createSubAgentRunner({
		provider,
		tools: new ToolRegistry([noteTool]),
		systemPrompt: "You are a sub-agent.",
		workingDirectory: process.cwd(),
		maxSteps: 5,
	});

	const result = await runner.run({ description: "gather and conclude" });

	assert.equal(result.outputText, "Final conclusion after tool use.");
	assert.equal(result.steps, 2);
});

test("each run() starts from a fresh, isolated context", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "done",
		toolCalls: [],
		finishReason: "stop",
	}));

	const runner = createSubAgentRunner({
		provider,
		tools: new ToolRegistry(),
		systemPrompt: "You are a sub-agent.",
		workingDirectory: process.cwd(),
		maxSteps: 5,
	});

	await runner.run({ description: "first run only" });
	const before = provider.requests.length;
	await runner.run({ description: "second run only" });

	const secondRunRequests = provider.requests.slice(before);
	assert.ok(secondRunRequests.length > 0);
	const firstRequest = secondRunRequests[0];
	// A fresh context means the second run's first request carries only its own
	// system prompt + user input — nothing from the first run.
	assert.equal(
		firstRequest.messages.filter((message) => message.role === "user").length,
		1,
	);
	assert.equal(firstRequest.messages.at(-1)?.content, "second run only");
	assert.ok(!JSON.stringify(firstRequest.messages).includes("first run only"));
});

test("a pre-aborted signal ends run() as interrupted without calling the model", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "should never run",
		toolCalls: [],
		finishReason: "stop",
	}));

	const runner = createSubAgentRunner({
		provider,
		tools: new ToolRegistry(),
		systemPrompt: "You are a sub-agent.",
		workingDirectory: process.cwd(),
		maxSteps: 5,
	});

	const controller = new AbortController();
	controller.abort();
	const result = await runner.run({
		description: "aborted before start",
		signal: controller.signal,
	});

	assert.equal(result.completionStatus, "interrupted");
	assert.equal(provider.requests.length, 0);
});

test("run() forwards tagged activity, never the child's own turn lifecycle", async () => {
	const provider = new MockProvider((_request, index) => {
		if (index === 0) {
			return {
				assistantText: "Checking the retry policy.",
				toolCalls: [
					{
						id: "call_1",
						name: "note",
						arguments: { text: "read runner.ts" },
						rawArguments: '{"text":"read runner.ts"}',
					},
				],
				finishReason: "tool_calls",
			};
		}
		return {
			assistantText: "The retry budget is shared.",
			toolCalls: [],
			finishReason: "stop",
		};
	});

	const events: TurnProgressEvent[] = [];
	const runner = createSubAgentRunner({
		provider,
		tools: new ToolRegistry([noteTool]),
		systemPrompt: "You are a sub-agent.",
		workingDirectory: process.cwd(),
		maxSteps: 5,
		onProgress: (event) => events.push(event),
	});

	await runner.run({ description: "  find\n the retry policy  " });

	// Everything forwarded is tagged, so a frontend can nest it under the
	// parent's `SubAgent` tool line instead of rendering it as parent activity.
	assert.ok(events.length > 0, "expected forwarded progress events");
	assert.ok(
		events.every((event) => event.subAgent),
		"every forwarded event carries the marker",
	);
	const markers = new Set(events.map((event) => event.subAgent?.id));
	assert.equal(markers.size, 1, "one marker per run");
	// The task label is the description with whitespace collapsed.
	assert.equal(events[0]?.subAgent?.task, "find the retry policy");

	const forwardedTypes = new Set(events.map((event) => event.type));
	for (const expected of [
		"model_request_started",
		"assistant_message",
		"model_request_finished",
		"tool_calls_received",
		"tool_execution_started",
		"tool_execution_finished",
	]) {
		assert.ok(
			forwardedTypes.has(expected as TurnProgressEvent["type"]),
			`expected the child's ${expected} to be forwarded`,
		);
	}
	// The child's turn boundaries must NOT be forwarded: every frontend keys on
	// these names to mean "the parent turn started/ended" (transcript reset,
	// turn clock, run stats, the session event log's open-turn tracking), so a
	// sub-agent run would otherwise look like a whole extra turn.
	assert.ok(
		!forwardedTypes.has("turn_started") &&
			!forwardedTypes.has("turn_finished") &&
			!forwardedTypes.has("turn_max_steps_reached"),
		"the child's turn lifecycle must not reach the parent's stream",
	);
});

test("each run() tags its events with a fresh marker id", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "done",
		toolCalls: [],
		finishReason: "stop",
	}));

	const runIds: string[] = [];
	const runner = createSubAgentRunner({
		provider,
		tools: new ToolRegistry(),
		systemPrompt: "You are a sub-agent.",
		workingDirectory: process.cwd(),
		maxSteps: 5,
		onProgress: (event) => {
			if (event.subAgent) {
				runIds.push(event.subAgent.id);
			}
		},
	});

	await runner.run({ description: "first" });
	await runner.run({ description: "second" });

	const unique = new Set(runIds);
	assert.equal(unique.size, 2, "each run gets its own marker id");
});

test("buildSubAgentSystemPrompt states the output contract", () => {
	const prompt = buildSubAgentSystemPrompt({ cwd: process.cwd() });

	assert.match(prompt, /结论/);
	assert.match(prompt, /证据/);
	assert.match(prompt, /未解问题/);
	assert.match(
		prompt,
		new RegExp(process.cwd().replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")),
	);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createToolMessage } from "../src/agent/messages.js";
import type { SubAgentResult, SubAgentRunner } from "../src/agent/sub-agent.js";
import { createSubAgentTool } from "../src/tools/builtin/sub-agent.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";
import { formatToolExecutionResult } from "../src/tools/render.js";

function stubRunner(
	overrides: Partial<SubAgentResult> & { outputText: string },
): SubAgentRunner {
	return {
		run: async () => ({
			steps: 1,
			completionStatus: "completed",
			usage: null,
			...overrides,
		}),
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

test("execute() returns the conclusion as the rendered result", async () => {
	const tool = createSubAgentTool(stubRunner({ outputText: "RESULT TEXT" }));

	const data = await tool.execute(
		{ description: "investigate the parser" },
		{ cwd: process.cwd() },
	);

	assert.equal(asRecord(data).rendered, "RESULT TEXT");
	assert.equal(asRecord(data).summary, "RESULT TEXT");
});

test("formatToolExecutionResult prefers the rendered conclusion", async () => {
	const tool = createSubAgentTool(stubRunner({ outputText: "RESULT TEXT" }));

	const data = await tool.execute(
		{ description: "investigate the parser" },
		{ cwd: process.cwd() },
	);

	assert.equal(
		formatToolExecutionResult("SubAgent", { ok: true, data }),
		"RESULT TEXT",
	);
});

test("an over-long conclusion is truncated by createToolMessage", async () => {
	const long = "x".repeat(70_000);
	const tool = createSubAgentTool(stubRunner({ outputText: long }));

	const data = await tool.execute(
		{ description: "collect everything" },
		{ cwd: process.cwd() },
	);

	const message = createToolMessage("call_1", "SubAgent", {
		ok: true,
		data,
	});

	assert.ok(message.content.length < long.length);
	assert.match(message.content, /tool result truncated/);
});

test("describeProgress labels the delegation", () => {
	const tool = createSubAgentTool(stubRunner({ outputText: "" }));

	const progress = tool.describeProgress?.({
		description: "find the parser",
	});

	assert.equal(progress?.summary, 'delegate to sub-agent: "find the parser"');
});

test("the default registry omits SubAgent when no runner is provided", () => {
	const registry = createDefaultToolRegistry();
	const names = registry.getSchemas().map((schema) => schema.function.name);

	assert.ok(!names.includes("SubAgent"));
});

test("the registry includes SubAgent when a runner is provided", () => {
	const registry = createDefaultToolRegistry(
		undefined,
		{},
		{
			subAgent: stubRunner({ outputText: "x" }),
		},
	);
	const names = registry.getSchemas().map((schema) => schema.function.name);

	assert.ok(names.includes("SubAgent"));
});

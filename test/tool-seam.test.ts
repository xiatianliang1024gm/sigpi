import assert from "node:assert/strict";
import test from "node:test";
import { createGrepTool } from "../src/tools/builtin/grep.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolCall } from "../src/types.js";

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
	return { id: "1", name, arguments: args, rawArguments: JSON.stringify(args) };
}

const grepTool = createGrepTool();

test("registry describeProgress uses the tool adapter, falls back to tool <name>", () => {
	const registry = new ToolRegistry([grepTool]);
	assert.equal(
		registry.describeProgress(toolCall("grep", { pattern: "x" })).summary,
		'search files mentioning "x"',
	);
	assert.equal(
		registry.describeProgress(toolCall("unknown_tool", {})).summary,
		"tool unknown_tool",
	);
});

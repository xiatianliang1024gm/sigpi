import assert from "node:assert/strict";
import test from "node:test";
import { createShellRuntime } from "../src/shell.js";
import { createBashTool } from "../src/tools/builtin/bash.js";
import { createEditTool } from "../src/tools/builtin/edit.js";
import { createGrepTool } from "../src/tools/builtin/grep.js";
import { createReadTool } from "../src/tools/builtin/read.js";
import { updatePlanTool } from "../src/tools/builtin/update-plan.js";
import { createWriteTool } from "../src/tools/builtin/write.js";
import { ReadTracker } from "../src/tools/read-tracker.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type {
	LedgerRecorder,
	ToolCall,
	ToolExecutionResult,
} from "../src/types.js";

function fakeRecorder() {
	const calls = {
		search: [] as unknown[],
		read: [] as unknown[],
		modified: [] as string[],
		candidate: [] as string[],
		finding: [] as string[],
		rejected: [] as string[],
		shellFinding: [] as unknown[],
	};
	const recorder: LedgerRecorder = {
		search: (entry) => calls.search.push(entry),
		read: (path, range) => calls.read.push({ path, range }),
		modified: (path) => calls.modified.push(path),
		candidate: (path) => calls.candidate.push(path),
		finding: (text) => calls.finding.push(text),
		rejected: (path) => calls.rejected.push(path),
		shellFinding: (command, ok, exitCode) =>
			calls.shellFinding.push({ command, ok, exitCode }),
	};
	return { calls, recorder };
}

function emptyLedger() {
	return {
		searchedQueries: [],
		candidateFiles: [],
		readRanges: [],
		rejectedPaths: [],
		keyFindings: [],
		modifiedFiles: [],
	};
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
	return { id: "1", name, arguments: args, rawArguments: JSON.stringify(args) };
}

const bashConfig = { mode: "workspace_write" as const };
const readTracker = new ReadTracker();

const grepTool = createGrepTool();
const readTool = createReadTool(readTracker);
const writeTool = createWriteTool(bashConfig, readTracker);
const editTool = createEditTool(bashConfig, readTracker);
const bashTool = createBashTool(
	createShellRuntime(
		process.platform === "win32" ? "powershell" : "zsh",
		process.platform,
	),
	bashConfig,
	readTracker,
);

test("grep adapter records search, candidates, and finding", () => {
	const { calls, recorder } = fakeRecorder();
	const tc = toolCall("grep", {
		pattern: "foo",
		glob: "src/**",
		output_mode: "files_with_matches",
		case_sensitive: false,
	});
	const result: ToolExecutionResult = {
		ok: true,
		data: {
			totalMatchCount: 3,
			truncated: false,
			matches: "src/a.ts\nsrc/b.ts",
		},
	};
	grepTool.recordLedger?.(recorder, tc, result);
	assert.equal(calls.search.length, 1);
	assert.equal((calls.search[0] as { query: string }).query, "foo");
	assert.deepEqual(calls.candidate, ["src/a.ts", "src/b.ts"]);
	assert.equal(calls.finding.length, 1);
});

test("read adapter records a read range", () => {
	const { calls, recorder } = fakeRecorder();
	const tc = toolCall("read", { file_path: "src/x.ts" });
	const result: ToolExecutionResult = {
		ok: true,
		data: { returnedLineStart: 1, returnedLineEnd: 40, truncated: false },
	};
	readTool.recordLedger?.(recorder, tc, result);
	assert.equal(calls.read.length, 1);
	assert.equal((calls.read[0] as { path: string }).path, "src/x.ts");
	assert.deepEqual((calls.read[0] as { range: unknown }).range, {
		startLine: 1,
		endLine: 40,
		truncated: false,
	});
});

test("write and edit adapters record modified paths", () => {
	const { calls: wCalls, recorder: wRec } = fakeRecorder();
	const wResult: ToolExecutionResult = { ok: true, data: {} };
	writeTool.recordLedger?.(
		wRec,
		toolCall("write", { file_path: "a.ts" }),
		wResult,
	);
	assert.deepEqual(wCalls.modified, ["a.ts"]);

	const { calls: eCalls, recorder: eRec } = fakeRecorder();
	const eResult: ToolExecutionResult = {
		ok: true,
		data: { path: "resolved/b.ts" },
	};
	editTool.recordLedger?.(
		eRec,
		toolCall("edit", { file_path: "b.ts" }),
		eResult,
	);
	assert.deepEqual(eCalls.modified, ["b.ts", "resolved/b.ts"]);
});

test("bash adapter records a shell finding", () => {
	const { calls, recorder } = fakeRecorder();
	const result: ToolExecutionResult = {
		ok: true,
		data: { ok: true, exitCode: 0 },
	};
	bashTool.recordLedger?.(
		recorder,
		toolCall("bash", { command: "ls" }),
		result,
	);
	assert.equal(calls.shellFinding.length, 1);
	assert.deepEqual(calls.shellFinding[0], {
		command: "ls",
		ok: true,
		exitCode: 0,
	});
});

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

test("registry recordLedger routes to the adapter through the facade", () => {
	const registry = new ToolRegistry([grepTool]);
	const tc = toolCall("grep", {
		pattern: "foo",
		output_mode: "files_with_matches",
	});
	const result: ToolExecutionResult = {
		ok: true,
		data: { totalMatchCount: 2, matches: "src/a.ts" },
	};
	const updated = registry.recordLedger(tc, result, emptyLedger());
	assert.equal(updated.searchedQueries.length, 1);
	assert.equal(updated.searchedQueries[0]?.query, "foo");
	assert.deepEqual(updated.candidateFiles, ["src/a.ts"]);
});

test("registry recordLedger is a no-op for tools without an adapter", () => {
	const registry = new ToolRegistry([updatePlanTool]);
	const ledger = emptyLedger();
	const updated = registry.recordLedger(
		toolCall("update_plan", { plan: [] }),
		{ ok: true, data: {} },
		ledger,
	);
	assert.equal(updated.modifiedFiles.length, 0);
	assert.equal(updated.searchedQueries.length, 0);
});

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
	evaluateCommandPolicy,
	evaluateMutatingToolPolicy,
	isWithinAnyRoot,
	resolveWritableWorkspacePath,
	SandboxPolicyError,
} from "../src/tools/sandbox-policy.js";

// A fake skill discovery root used as the read-only target in every test.
const skillRoot = path.resolve("/tmp/fake-sigpi/skills");
const skillFile = path.join(skillRoot, "evil", "SKILL.md");
const cwd = process.cwd();

// ---------------------------------------------------------------------------
// isWithinAnyRoot
// ---------------------------------------------------------------------------

test("isWithinAnyRoot matches a path beneath a root", () => {
	assert.equal(isWithinAnyRoot(path.join(skillRoot, "a"), [skillRoot]), true);
});

test("isWithinAnyRoot matches the root directory itself", () => {
	assert.equal(isWithinAnyRoot(skillRoot, [skillRoot]), true);
});

test("isWithinAnyRoot rejects a sibling that shares a name prefix", () => {
	const sibling = `${skillRoot}-extra`;
	assert.equal(isWithinAnyRoot(sibling, [skillRoot]), false);
});

test("isWithinAnyRoot rejects an unrelated path", () => {
	assert.equal(isWithinAnyRoot("/tmp/elsewhere", [skillRoot]), false);
});

test("isWithinAnyRoot returns false for empty roots", () => {
	assert.equal(isWithinAnyRoot(skillRoot, []), false);
});

// ---------------------------------------------------------------------------
// evaluateMutatingToolPolicy (write/edit pre-check)
// ---------------------------------------------------------------------------

test("evaluateMutatingToolPolicy blocks a skill-root target in workspace_write", () => {
	assert.throws(
		() =>
			evaluateMutatingToolPolicy(skillFile, "workspace_write", "write", [
				skillRoot,
			]),
		SandboxPolicyError,
	);
});

test("evaluateMutatingToolPolicy blocks a skill-root target in read_only", () => {
	assert.throws(
		() =>
			evaluateMutatingToolPolicy(skillFile, "read_only", "write", [skillRoot]),
		SandboxPolicyError,
	);
});

test("evaluateMutatingToolPolicy blocks a skill-root target in full_access", () => {
	assert.throws(
		() =>
			evaluateMutatingToolPolicy(skillFile, "full_access", "write", [
				skillRoot,
			]),
		SandboxPolicyError,
	);
});

test("evaluateMutatingToolPolicy allows a normal workspace path in full_access", () => {
	assert.doesNotThrow(() =>
		evaluateMutatingToolPolicy("src/new.ts", "full_access", "write", [
			skillRoot,
		]),
	);
});

// ---------------------------------------------------------------------------
// resolveWritableWorkspacePath (write/edit path resolution)
// ---------------------------------------------------------------------------

test("resolveWritableWorkspacePath blocks a skill-root target in workspace_write", () => {
	assert.throws(
		() =>
			resolveWritableWorkspacePath(
				cwd,
				skillFile,
				"workspace_write",
				"write",
				[],
				[skillRoot],
			),
		SandboxPolicyError,
	);
});

test("resolveWritableWorkspacePath blocks a skill-root target in full_access", () => {
	assert.throws(
		() =>
			resolveWritableWorkspacePath(
				cwd,
				skillFile,
				"full_access",
				"write",
				[],
				[skillRoot],
			),
		SandboxPolicyError,
	);
});

test("resolveWritableWorkspacePath still enforces read_only write gate", () => {
	assert.throws(
		() =>
			resolveWritableWorkspacePath(
				cwd,
				"src/new.ts",
				"read_only",
				"write",
				[],
				[skillRoot],
			),
		/is not permitted in read_only mode/,
	);
});

test("resolveWritableWorkspacePath still enforces workspace containment", () => {
	assert.throws(
		() =>
			resolveWritableWorkspacePath(
				cwd,
				"../escape.ts",
				"workspace_write",
				"write",
				[],
				[skillRoot],
			),
		/Path must stay within the working directory/,
	);
});

// ---------------------------------------------------------------------------
// evaluateCommandPolicy (bash)
// ---------------------------------------------------------------------------

test("evaluateCommandPolicy blocks a redirect into a skill root in workspace_write", () => {
	assert.throws(
		() =>
			evaluateCommandPolicy(
				`printf 'x' > ${skillFile}`,
				cwd,
				"workspace_write",
				[],
				[skillRoot],
			),
		SandboxPolicyError,
	);
});

test("evaluateCommandPolicy blocks a redirect into a skill root in read_only", () => {
	assert.throws(
		() =>
			evaluateCommandPolicy(
				`printf 'x' > ${skillFile}`,
				cwd,
				"read_only",
				[],
				[skillRoot],
			),
		SandboxPolicyError,
	);
});

test("evaluateCommandPolicy blocks a redirect into a skill root in full_access", () => {
	assert.throws(
		() =>
			evaluateCommandPolicy(
				`printf 'x' > ${skillFile}`,
				cwd,
				"full_access",
				[],
				[skillRoot],
			),
		SandboxPolicyError,
	);
});

test("evaluateCommandPolicy blocks an append redirect into a skill root in full_access", () => {
	assert.throws(
		() =>
			evaluateCommandPolicy(
				`printf 'x' >> ${skillFile}`,
				cwd,
				"full_access",
				[],
				[skillRoot],
			),
		SandboxPolicyError,
	);
});

test("evaluateCommandPolicy allows a normal write in full_access", () => {
	assert.doesNotThrow(() =>
		evaluateCommandPolicy(
			"printf 'x' > ./out.txt",
			cwd,
			"full_access",
			[],
			[skillRoot],
		),
	);
});

test("evaluateCommandPolicy still denies an out-of-workspace write in workspace_write", () => {
	assert.throws(
		() =>
			evaluateCommandPolicy(
				"printf 'x' > ../escape.txt",
				cwd,
				"workspace_write",
				[],
				[skillRoot],
			),
		/must stay within the working directory/,
	);
});

test("evaluateCommandPolicy still denies writes in read_only (non-skill target)", () => {
	assert.throws(
		() =>
			evaluateCommandPolicy(
				"printf 'x' > ./out.txt",
				cwd,
				"read_only",
				[],
				[skillRoot],
			),
		/is not permitted in read_only mode/,
	);
});

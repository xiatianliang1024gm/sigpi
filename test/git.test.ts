import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _resetGitBranchCacheForTests, getGitBranch } from "../src/git.js";
import { gitIn } from "./helpers.js";

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "sigpi-git-test-"));
	gitIn(dir, "init -q -b main");
	gitIn(dir, "config user.email test@test.local");
	gitIn(dir, "config user.name Test");
	gitIn(dir, "commit --allow-empty -q -m initial");
	return dir;
}

function cleanup(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

test("getGitBranch returns the current branch name", async () => {
	_resetGitBranchCacheForTests();
	const dir = makeRepo();
	try {
		const branch = await getGitBranch(dir);
		assert.equal(branch, "main");
	} finally {
		cleanup(dir);
	}
});

test("getGitBranch returns @shortSha for detached HEAD", async () => {
	_resetGitBranchCacheForTests();
	const dir = makeRepo();
	try {
		const sha = gitIn(dir, "rev-parse --short HEAD").trim();
		gitIn(dir, "checkout --detach -q HEAD");
		const branch = await getGitBranch(dir);
		assert.equal(branch, `@${sha}`);
	} finally {
		cleanup(dir);
	}
});

test("getGitBranch returns null for a non-repo directory", async () => {
	_resetGitBranchCacheForTests();
	const dir = mkdtempSync(join(tmpdir(), "sigpi-git-norepo-"));
	try {
		const branch = await getGitBranch(dir);
		assert.equal(branch, null);
	} finally {
		cleanup(dir);
	}
});

test("getGitBranch caches results per cwd", async () => {
	_resetGitBranchCacheForTests();
	const dir = makeRepo();
	try {
		const first = await getGitBranch(dir);
		assert.equal(first, "main");
		// Switch branches on disk; the cached value must still be returned.
		gitIn(dir, "checkout -q -b feature");
		const second = await getGitBranch(dir);
		assert.equal(second, "main");
	} finally {
		cleanup(dir);
	}
});

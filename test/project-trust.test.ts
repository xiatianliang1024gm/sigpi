import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	findClosestGatingDir,
	lookupClosestTrust,
	projectHasGatedResources,
	readTrustStore,
	resolveProjectTrust,
	writeTrustDecision,
} from "../src/project-trust.js";

const BASE = path.join(os.tmpdir(), `sigpi-pt-tests-${process.pid}`);

async function makeDir(prefix: string): Promise<string> {
	const full = path.join(BASE, prefix);
	await mkdir(full, { recursive: true });
	return full;
}

test.afterEach(async () => {
	await rm(BASE, { recursive: true, force: true });
});

test("projectHasGatedResources is false without any gating marker", async () => {
	const cwd = await makeDir("nogate");
	assert.equal(projectHasGatedResources(cwd), false);
	assert.equal(findClosestGatingDir(cwd), undefined);
});

test("projectHasGatedResources treats a bare .sigpi/ as NOT gated", async () => {
	const cwd = await makeDir("baredir");
	await mkdir(path.join(cwd, ".sigpi"), { recursive: true });
	assert.equal(projectHasGatedResources(cwd), false);
});

test(".sigpi/skills, .agents/skills, and .sigpi/config.toml are all gating markers", async () => {
	const sigpiSkills = await makeDir("sigpi");
	await touch(sigpiSkills, ".sigpi/skills/x/SKILL.md");
	assert.equal(projectHasGatedResources(sigpiSkills), true);
	assert.equal(findClosestGatingDir(sigpiSkills), path.resolve(sigpiSkills));

	const agentsSkills = await makeDir("agents");
	await touch(agentsSkills, ".agents/skills/x/SKILL.md");
	assert.equal(projectHasGatedResources(agentsSkills), true);

	const projectConfig = await makeDir("projcfg");
	await touch(projectConfig, ".sigpi/config.toml");
	assert.equal(projectHasGatedResources(projectConfig), true);
});

test("findClosestGatingDir returns the nearest ancestor gating dir", async () => {
	const root = await makeDir("ancestor");
	await touch(root, ".sigpi/skills/x/SKILL.md");
	const nested = path.join(root, "a", "b", "c");
	await mkdir(nested, { recursive: true });
	assert.equal(findClosestGatingDir(nested), path.resolve(root));
});

test("read/write/lookup trust decisions walk up to the nearest ancestor", async () => {
	const homeDir = await makeDir("home");
	const root = await makeDir("store");
	const sub = path.join(root, "deep", "nested");

	assert.deepEqual(readTrustStore(homeDir), { decisions: {} });

	writeTrustDecision(homeDir, root, "always");
	assert.equal(readTrustStore(homeDir).decisions[path.resolve(root)], "always");
	assert.equal(lookupClosestTrust(readTrustStore(homeDir), sub), "always");

	// An unrelated directory has no decision.
	const other = await makeDir("store-other");
	assert.equal(lookupClosestTrust(readTrustStore(homeDir), other), undefined);

	// A nearer ancestor overrides a farther one.
	writeTrustDecision(homeDir, sub, "never");
	assert.equal(lookupClosestTrust(readTrustStore(homeDir), sub), "never");
});

test("resolveProjectTrust allows when there are no gated resources", async () => {
	const cwd = await makeDir("rt-nogate");
	const result = await resolveProjectTrust({
		cwd,
		homeDir: "/nonexistent",
		defaultTrust: "ask",
	});
	assert.equal(result.allows, true);
	assert.equal(result.skipped, false);
	assert.equal(result.reason, "no-gating-resources");
});

test("resolveProjectTrust honors a saved decision", async () => {
	const homeDir = await makeDir("rt-saved-home");
	const cwd = await makeDir("rt-saved-project");
	await touch(cwd, ".sigpi/skills/x/SKILL.md");
	writeTrustDecision(homeDir, cwd, "always");

	const allowed = await resolveProjectTrust({
		cwd,
		homeDir,
		defaultTrust: "ask",
	});
	assert.equal(allowed.allows, true);
	assert.equal(allowed.skipped, false);
	assert.equal(allowed.reason, "saved-always");

	writeTrustDecision(homeDir, cwd, "never");
	const denied = await resolveProjectTrust({
		cwd,
		homeDir,
		defaultTrust: "ask",
	});
	assert.equal(denied.allows, false);
	assert.equal(denied.skipped, true);
	assert.equal(denied.reason, "saved-never");
});

test("resolveProjectTrust follows defaultProjectTrust when nothing else decides", async () => {
	const cwd = await makeDir("rt-default");
	await touch(cwd, ".sigpi/config.toml");

	const always = await resolveProjectTrust({
		cwd,
		homeDir: "/nonexistent",
		defaultTrust: "always",
	});
	assert.equal(always.allows, true);
	assert.equal(always.reason, "default-always");

	const never = await resolveProjectTrust({
		cwd,
		homeDir: "/nonexistent",
		defaultTrust: "never",
	});
	assert.equal(never.allows, false);
	assert.equal(never.skipped, true);
	assert.equal(never.reason, "default-never");
});

test("resolveProjectTrust is headless-denied when default is ask and no prompt is supplied", async () => {
	const cwd = await makeDir("rt-ask");
	await touch(cwd, ".sigpi/skills/x/SKILL.md");
	const result = await resolveProjectTrust({
		cwd,
		homeDir: "/nonexistent",
		defaultTrust: "ask",
	});
	assert.equal(result.allows, false);
	assert.equal(result.skipped, true);
	assert.equal(result.reason, "headless-denied");
});

test("resolveProjectTrust --approve overrides a saved/never decision", async () => {
	const homeDir = await makeDir("rt-approve-home");
	const cwd = await makeDir("rt-approve-project");
	await touch(cwd, ".sigpi/skills/x/SKILL.md");
	writeTrustDecision(homeDir, cwd, "never");

	const result = await resolveProjectTrust({
		cwd,
		homeDir,
		defaultTrust: "ask",
		approve: true,
	});
	assert.equal(result.allows, true);
	assert.equal(result.skipped, false);
	assert.equal(result.reason, "cli-approve");
});

test("resolveProjectTrust --no-approve denies even when default is always", async () => {
	const cwd = await makeDir("rt-noapprove");
	await touch(cwd, ".sigpi/skills/x/SKILL.md");
	const result = await resolveProjectTrust({
		cwd,
		homeDir: "/nonexistent",
		defaultTrust: "always",
		noApprove: true,
	});
	assert.equal(result.allows, false);
	assert.equal(result.skipped, true);
	assert.equal(result.reason, "cli-no-approve");
});

test("resolveProjectTrust prompts interactively and persists the decision", async () => {
	const cwd = await makeDir("rt-prompt-project");
	await touch(cwd, ".agents/skills/x/SKILL.md");

	// "always" is persisted for the next run.
	const homeAlways = await makeDir("rt-prompt-home-always");
	let promptedDir = "";
	const alwaysPrompt = async (dir: string) => {
		promptedDir = dir;
		return "always" as const;
	};
	const allowed = await resolveProjectTrust({
		cwd,
		homeDir: homeAlways,
		defaultTrust: "ask",
		prompt: alwaysPrompt,
	});
	assert.equal(allowed.allows, true);
	assert.equal(promptedDir, path.resolve(cwd));
	assert.equal(
		readTrustStore(homeAlways).decisions[path.resolve(cwd)],
		"always",
	);

	// "never" with a fresh home dir is not contaminated by the prior decision.
	const homeNever = await makeDir("rt-prompt-home-never");
	const deniedPrompt = async () => "never" as const;
	const denied = await resolveProjectTrust({
		cwd,
		homeDir: homeNever,
		defaultTrust: "ask",
		prompt: deniedPrompt,
	});
	assert.equal(denied.allows, false);
	assert.equal(readTrustStore(homeNever).decisions[path.resolve(cwd)], "never");

	// A null (skip) answer denies without persisting a new decision.
	const homeSkip = await makeDir("rt-prompt-home-skip");
	const skipPrompt = async () => null;
	const skipped = await resolveProjectTrust({
		cwd,
		homeDir: homeSkip,
		defaultTrust: "ask",
		prompt: skipPrompt,
	});
	assert.equal(skipped.allows, false);
	assert.equal(
		readTrustStore(homeSkip).decisions[path.resolve(cwd)],
		undefined,
	);
});

async function touch(dir: string, relative: string): Promise<void> {
	const full = path.join(dir, relative);
	await mkdir(path.dirname(full), { recursive: true });
	await writeFile(full, "", "utf8");
}

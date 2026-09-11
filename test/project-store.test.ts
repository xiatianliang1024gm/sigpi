import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	getProjectRegistryPath,
	loadProjectRegistry,
	saveProjectRegistry,
} from "../src/server/project-store.js";

async function tempHome(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "sigpi-home-"));
}

/** Write a raw registry file, creating the `~/.sigpi` directory first. */
async function writeRegistry(homeDir: string, contents: string): Promise<void> {
	const filePath = getProjectRegistryPath(homeDir);
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, contents, "utf8");
}

test("loadProjectRegistry is empty when nothing was saved", async () => {
	const homeDir = await tempHome();
	assert.deepEqual(await loadProjectRegistry({ homeDir }), []);
});

test("saveProjectRegistry round-trips through loadProjectRegistry", async () => {
	const homeDir = await tempHome();
	await saveProjectRegistry(
		[
			{ cwd: "/tmp/a", addedAt: 10 },
			{ cwd: "/tmp/b", addedAt: 20 },
		],
		{ homeDir },
	);

	assert.deepEqual(await loadProjectRegistry({ homeDir }), [
		{ cwd: "/tmp/a", addedAt: 10 },
		{ cwd: "/tmp/b", addedAt: 20 },
	]);

	// The file lives under `~/.sigpi/projects.json` and is versioned JSON.
	const raw = await readFile(getProjectRegistryPath(homeDir), "utf8");
	const parsed = JSON.parse(raw) as { version: number; projects: unknown[] };
	assert.equal(parsed.version, 1);
	assert.equal(parsed.projects.length, 2);
});

test("saveProjectRegistry round-trips an optional display name", async () => {
	const homeDir = await tempHome();
	await saveProjectRegistry(
		[
			{ cwd: "/tmp/a", addedAt: 10, name: "Work" },
			{ cwd: "/tmp/b", addedAt: 20 },
		],
		{ homeDir },
	);

	assert.deepEqual(await loadProjectRegistry({ homeDir }), [
		{ cwd: "/tmp/a", addedAt: 10, name: "Work" },
		{ cwd: "/tmp/b", addedAt: 20 },
	]);
});

test("loadProjectRegistry survives a corrupt file", async () => {
	const homeDir = await tempHome();
	await writeRegistry(homeDir, "{ not json");
	assert.deepEqual(await loadProjectRegistry({ homeDir }), []);
});

test("loadProjectRegistry discards malformed entries", async () => {
	const homeDir = await tempHome();
	await writeRegistry(
		homeDir,
		JSON.stringify({
			version: 1,
			projects: [
				{ cwd: "/tmp/ok", addedAt: 5 },
				{ cwd: 42 },
				null,
				"nope",
				{ addedAt: 1 },
			],
		}),
	);

	assert.deepEqual(await loadProjectRegistry({ homeDir }), [
		{ cwd: "/tmp/ok", addedAt: 5 },
	]);
});

test("loadProjectRegistry tolerates a missing `projects` array", async () => {
	const homeDir = await tempHome();
	await writeRegistry(homeDir, JSON.stringify({ version: 1 }));
	assert.deepEqual(await loadProjectRegistry({ homeDir }), []);
});

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import {
	getDefaultUserConfigPath,
	initializeUserConfig,
} from "../src/config.js";
import { createTempDir } from "./helpers.js";

test("initializeUserConfig creates ~/.sigpi/config.toml by default", async () => {
	const homeDir = await createTempDir("sigpi-init-home-");

	const result = await initializeUserConfig({ homeDir });
	const content = await readFile(result.configPath, "utf8");

	assert.equal(result.created, true);
	assert.equal(result.configPath, getDefaultUserConfigPath(homeDir));
	assert.match(content, /\[model\]/);
	assert.match(content, /default = "local"/);
	assert.match(content, /\[models\.local\]/);
	assert.match(content, /\[storage\]/);
	assert.match(content, /base_url = "http:\/\/localhost:8000\/v1"/);
	assert.match(content, /timeout_ms = 60000/);
	assert.match(content, /max_retries = 2/);
	assert.match(content, /file = "~\/\.sigpi\/logs\/agent\.log"/);
});

test("initializeUserConfig does not overwrite an existing file unless forced", async () => {
	const homeDir = await createTempDir("sigpi-init-existing-");

	const first = await initializeUserConfig({ homeDir });
	const originalContent = await readFile(first.configPath, "utf8");
	const second = await initializeUserConfig({ homeDir });
	const preservedContent = await readFile(first.configPath, "utf8");

	assert.equal(first.created, true);
	assert.equal(second.created, false);
	assert.equal(preservedContent, originalContent);
});

test("initializeUserConfig overwrites an existing file when forced", async () => {
	const homeDir = await createTempDir("sigpi-init-force-");

	const first = await initializeUserConfig({ homeDir });
	const customContent = '[model]\nactive = "override"\n';
	await writeFile(first.configPath, customContent, "utf8");
	const overwritten = await initializeUserConfig({ homeDir, overwrite: true });
	const finalContent = await readFile(first.configPath, "utf8");

	assert.equal(first.created, true);
	assert.equal(overwritten.created, true);
	assert.match(finalContent, /your-api-key/);
	assert.doesNotMatch(finalContent, /override\.example/);
});

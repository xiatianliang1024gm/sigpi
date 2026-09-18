import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadAppConfig } from "../src/config.js";
import { createAgentRuntime } from "../src/runtime.js";
import { createTempDir } from "./helpers.js";

async function writeSubAgentConfig(
	homeDir: string,
	subAgentEnabled: boolean,
): Promise<void> {
	const configDir = path.join(homeDir, ".sigpi");
	await mkdir(configDir, { recursive: true });
	await writeFile(
		path.join(configDir, "config.toml"),
		[
			"[model]",
			'active = "test"',
			"",
			"[models.test]",
			'base_url = "https://example.test/v1"',
			'api_key = "test-key"',
			'name = "test-model"',
			"",
			"[tools.sub_agent]",
			`enabled = ${subAgentEnabled}`,
		].join("\n"),
		"utf8",
	);
}

function toolNames(runtime: Awaited<ReturnType<typeof createAgentRuntime>>) {
	return runtime.toolSchemas.map((schema) => schema.function.name);
}

test("runtime exposes the SubAgent tool when [tools.sub_agent] is enabled", async () => {
	const homeDir = await createTempDir("sigpi-subagent-on-");
	await writeSubAgentConfig(homeDir, true);
	const config = loadAppConfig({ homeDir, env: {} });

	const runtime = await createAgentRuntime({
		config,
		homeDir,
		createSession: true,
	});
	try {
		assert.ok(toolNames(runtime).includes("SubAgent"));
	} finally {
		runtime.dispose();
	}
});

test("runtime omits the SubAgent tool by default", async () => {
	const homeDir = await createTempDir("sigpi-subagent-off-");
	await writeSubAgentConfig(homeDir, false);
	const config = loadAppConfig({ homeDir, env: {} });

	const runtime = await createAgentRuntime({
		config,
		homeDir,
		createSession: true,
	});
	try {
		assert.ok(!toolNames(runtime).includes("SubAgent"));
	} finally {
		runtime.dispose();
	}
});

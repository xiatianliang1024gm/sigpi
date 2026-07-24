import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
	CONFIG_ALIASES,
	getDefaultLogFilePath,
	getDefaultProjectConfigPath,
	getDefaultSessionsRoot,
	getDefaultUserConfigPath,
	loadAppConfig,
	parseTomlConfig,
	renderDefaultConfigToml,
} from "../src/config.js";
import { createTempDir } from "./helpers.js";

test("alias maps drive parseTomlConfig for every section", () => {
	// Type-correct sentinels per section so the TOML actually parses.
	const sentinels: Record<string, Record<string, string | number | boolean>> = {
		model: {
			base_url: "u",
			api_key: "k",
			name: "n",
			api_format: "chat_completions",
			timeout_ms: 1,
			max_retries: 0,
			retry_base_delay_ms: 1,
			max_tokens: 1,
			stream: true,
			proxy: "http://proxy.example:7078",
			hard_context_limit: 1,
			reserve_tokens: 1,
			keep_recent_tokens: 1,
		},
		agent: {
			max_steps: 1,
		},
		logging: {
			level: "info",
			file: "f",
			to_console: true,
			max_body_preview_chars: 1,
			max_console_body_preview_chars: 1,
		},
		storage: { sessions_root: "sr" },
		shell: { kind: "bash", path: "p" },
		trust: { default_project_trust: "ask" },
		bash: {
			default_timeout_ms: 1,
			max_timeout_ms: 1,
			max_output_length: 1,
			maintain_project_working_dir: true,
			env_file: "e",
		},
	};
	const tomlSections: Record<string, string> = {
		model: "models.t",
		agent: "agent",
		logging: "logging",
		storage: "storage",
		shell: "shell",
		trust: "trust",
		bash: "tools.bash",
	};

	for (const [section, aliases] of Object.entries(CONFIG_ALIASES)) {
		// `tools` carries an array-valued alias (allowed_roots) which this
		// scalar-sentinel harness can't emit; it is covered by a dedicated test.
		if (section === "tools") {
			continue;
		}
		const lines = [`[${tomlSections[section]}]`];
		for (const [, snake] of Object.entries(aliases)) {
			const value = sentinels[section][snake];
			lines.push(
				`${snake} = ${typeof value === "string" ? JSON.stringify(value) : value}`,
			);
		}
		const parsed = parseTomlConfig(lines.join("\n"));
		const mapped =
			section === "bash"
				? parsed.tools?.bash
				: section === "model"
					? parsed.models?.t
					: (parsed as Record<string, unknown>)[section];
		assert.ok(
			mapped,
			`section "${section}" should map through parseTomlConfig`,
		);
		for (const camel of Object.keys(aliases)) {
			assert.ok(
				camel in (mapped as Record<string, unknown>),
				`alias "${camel}" (section "${section}") is not wired through parseTomlConfig`,
			);
		}
	}
});

test("parseTomlConfig maps supported sections into runtime config shape", () => {
	const parsed = parseTomlConfig(`
[models.fast]
base_url = "https://example.test/v1"
api_key = "secret"
name = "demo-model"
api_format = "responses"
timeout_ms = 21000
max_retries = 1
retry_base_delay_ms = 99
max_tokens = 8192

[models.deep]
base_url = "https://deep.example/v1"
api_key = "deep-secret"
name = "deep-model"

[agent]
max_steps = 9

[logging]
level = "debug"
file = "custom/agent.log"
to_console = true

[storage]
sessions_root = "~/agent-projects"

[shell]
kind = "bash"
path = "/bin/bash"

[tools.bash]
`);

	assert.deepEqual(parsed, {
		models: {
			fast: {
				baseURL: "https://example.test/v1",
				apiKey: "secret",
				name: "demo-model",
				apiFormat: "responses",
				timeoutMs: 21000,
				maxRetries: 1,
				retryBaseDelayMs: 99,
				maxTokens: 8192,
			},
			deep: {
				baseURL: "https://deep.example/v1",
				apiKey: "deep-secret",
				name: "deep-model",
			},
		},
		agent: {
			maxSteps: 9,
		},
		logging: {
			level: "debug",
			filePath: "custom/agent.log",
			toConsole: true,
		},
		storage: {
			sessionsRoot: "~/agent-projects",
		},
		shell: {
			kind: "bash",
			path: "/bin/bash",
		},
		tools: {
			bash: {},
		},
	});
});

test("loadAppConfig merges user config, project config, and env overrides", async () => {
	const cwd = await createTempDir("sigpi-config-project-");
	const homeDir = await createTempDir("sigpi-config-home-");
	const userConfigDir = path.join(homeDir, ".sigpi");
	const projectConfigDir = path.join(cwd, ".sigpi");

	await mkdir(userConfigDir, { recursive: true });
	await mkdir(projectConfigDir, { recursive: true });

	await writeFile(
		path.join(userConfigDir, "config.toml"),
		[
			"[models.user]",
			'base_url = "https://user.example/v1"',
			'api_key = "user-key"',
			'name = "user-model"',
			"timeout_ms = 19000",
			"",
			"[models.project]",
			'base_url = "https://project.example/v1"',
			'api_key = "project-key"',
			'name = "user-project-placeholder"',
			"timeout_ms = 19000",
			"max_tokens = 4096",
			"hard_context_limit = 100000",
			"",
			"[agent]",
			"max_steps = 7",
			"",
			"[logging]",
			'level = "warn"',
			'file = "user.log"',
			"",
			"[storage]",
			'sessions_root = "~/sessions"',
		].join("\n"),
		"utf8",
	);

	await writeFile(
		path.join(projectConfigDir, "config.toml"),
		[
			"[models.project]",
			'name = "project-model"',
			"keep_recent_tokens = 3000",
			"",
			"[agent]",
			"",
			"[shell]",
			'kind = "bash"',
		].join("\n"),
		"utf8",
	);

	const config = loadAppConfig({
		cwd,
		homeDir,
		env: {
			MODEL_API_KEY: "env-key",
			AGENT_LOG_TO_CONSOLE: "true",
			AGENT_SHELL_PATH: "/bin/custom-bash",
		},
	});

	assert.equal(config.modelId, "user");
	assert.equal(config.model.baseURL, "https://user.example/v1");
	assert.equal(config.model.apiKey, "env-key");
	assert.equal(config.model.name, "user-model");
	assert.equal(config.model.apiFormat, "chat_completions");
	assert.equal(config.model.timeoutMs, 19000);
	assert.equal(config.model.maxRetries, 2);
	assert.equal(config.model.retryBaseDelayMs, 250);
	assert.equal(config.agent.maxSteps, 7);
	assert.equal(config.models.project.hardContextLimit, 100000);
	assert.equal(config.models.project.keepRecentTokens, 3000);
	assert.equal(config.logging.level, "warn");
	assert.equal(config.logging.filePath, "user.log");
	assert.equal(config.logging.toConsole, true);
	assert.equal(config.storage.sessionsRoot, path.join(homeDir, "sessions"));
	assert.equal(config.shell.kind, "bash");
	assert.equal(config.shell.path, "/bin/custom-bash");
});

test("loadAppConfig parses [tools.bash] keys", async () => {
	const cwd = await createTempDir("sigpi-config-bash-project-");
	const homeDir = await createTempDir("sigpi-config-bash-home-");
	const userConfigDir = path.join(homeDir, ".sigpi");
	await mkdir(userConfigDir, { recursive: true });
	await writeFile(
		path.join(userConfigDir, "config.toml"),
		[
			"[model]",
			'default = "m"',
			"[models.m]",
			'base_url = "https://x/v1"',
			'api_key = "k"',
			'name = "n"',
			"[tools.bash]",
			"default_timeout_ms = 90000",
			"max_timeout_ms = 300000",
			"max_output_length = 20000",
			"maintain_project_working_dir = true",
			'env_file = "~/.sigpi/bash-env.sh"',
		].join("\n"),
		"utf8",
	);

	const config = loadAppConfig({ cwd, homeDir, env: {} });
	assert.equal(config.tools.bash.defaultTimeoutMs, 90000);
	assert.equal(config.tools.bash.maxTimeoutMs, 300000);
	assert.equal(config.tools.bash.maxOutputLength, 20000);
	assert.equal(config.tools.bash.maintainProjectWorkingDir, true);
	assert.equal(config.tools.bash.envFile, "~/.sigpi/bash-env.sh");
});

test("loadAppConfig applies Bash env-var overrides (BASH_*/CLAUDE_*)", async () => {
	const cwd = await createTempDir("sigpi-config-bashenv-project-");
	const homeDir = await createTempDir("sigpi-config-bashenv-home-");
	await mkdir(path.join(homeDir, ".sigpi"), { recursive: true });
	await writeFile(
		path.join(homeDir, ".sigpi", "config.toml"),
		[
			"[model]",
			'default = "m"',
			"[models.m]",
			'base_url = "https://x/v1"',
			'api_key = "k"',
			'name = "n"',
		].join("\n"),
		"utf8",
	);

	const config = loadAppConfig({
		cwd,
		homeDir,
		env: {
			BASH_DEFAULT_TIMEOUT_MS: "130000",
			BASH_MAX_TIMEOUT_MS: "540000",
			BASH_MAX_OUTPUT_LENGTH: "40000",
			CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
			CLAUDE_ENV_FILE: "~/.sigpi/env.sh",
		},
	});
	assert.equal(config.tools.bash.defaultTimeoutMs, 130000);
	assert.equal(config.tools.bash.maxTimeoutMs, 540000);
	assert.equal(config.tools.bash.maxOutputLength, 40000);
	assert.equal(config.tools.bash.maintainProjectWorkingDir, true);
	assert.equal(config.tools.bash.envFile, "~/.sigpi/env.sh");
});

test("loadAppConfig rejects a model whose max_tokens exceeds hard_context_limit", async () => {
	const cwd = await createTempDir("sigpi-config-budget-overflow-");
	const homeDir = await createTempDir("sigpi-config-budget-overflow-home-");
	await mkdir(path.join(homeDir, ".sigpi"), { recursive: true });
	await writeFile(
		path.join(homeDir, ".sigpi", "config.toml"),
		[
			"[model]",
			'default = "m"',
			"[models.m]",
			'base_url = "https://x/v1"',
			'api_key = "k"',
			'name = "n"',
			"hard_context_limit = 1000",
			"max_tokens = 4096",
		].join("\n"),
		"utf8",
	);

	assert.throws(
		() => loadAppConfig({ cwd, homeDir, env: {} }),
		/hard_context_limit/,
	);
});

test("loadAppConfig accepts a model whose max_tokens fits within hard_context_limit", async () => {
	const cwd = await createTempDir("sigpi-config-budget-ok-");
	const homeDir = await createTempDir("sigpi-config-budget-ok-home-");
	await mkdir(path.join(homeDir, ".sigpi"), { recursive: true });
	await writeFile(
		path.join(homeDir, ".sigpi", "config.toml"),
		[
			"[model]",
			'default = "m"',
			"[models.m]",
			'base_url = "https://x/v1"',
			'api_key = "k"',
			'name = "n"',
			"hard_context_limit = 100000",
			"max_tokens = 4096",
		].join("\n"),
		"utf8",
	);

	const config = loadAppConfig({ cwd, homeDir, env: {} });
	assert.equal(config.models.m.hardContextLimit, 100000);
	assert.equal(config.models.m.maxTokens, 4096);
});

test("loadAppConfig defaults [tools.bash] bounds when unset", async () => {
	const cwd = await createTempDir("sigpi-config-bashdefault-project-");
	const homeDir = await createTempDir("sigpi-config-bashdefault-home-");
	await mkdir(path.join(homeDir, ".sigpi"), { recursive: true });
	await writeFile(
		path.join(homeDir, ".sigpi", "config.toml"),
		[
			"[model]",
			'default = "m"',
			"[models.m]",
			'base_url = "https://x/v1"',
			'api_key = "k"',
			'name = "n"',
		].join("\n"),
		"utf8",
	);

	const config = loadAppConfig({ cwd, homeDir, env: {} });
	assert.equal(config.tools.bash.defaultTimeoutMs, 120000);
	assert.equal(config.tools.bash.maxTimeoutMs, 600000);
	assert.equal(config.tools.bash.maxOutputLength, 30000);
	assert.equal(config.tools.bash.maintainProjectWorkingDir, false);
	assert.equal(config.tools.bash.envFile, undefined);
});

test("loadAppConfig remembers the last selected configured model", async () => {
	const cwd = await createTempDir("sigpi-config-remember-project-");
	const homeDir = await createTempDir("sigpi-config-remember-home-");
	const configDir = path.join(homeDir, ".sigpi");

	await mkdir(configDir, { recursive: true });
	await writeFile(
		path.join(configDir, "config.toml"),
		[
			"[model]",
			'active = "fast"',
			"",
			"[models.fast]",
			'base_url = "https://fast.example/v1"',
			'api_key = "fast-key"',
			'name = "fast-model"',
			"",
			"[models.deep]",
			'base_url = "https://deep.example/v1"',
			'api_key = "deep-key"',
			'name = "deep-model"',
		].join("\n"),
		"utf8",
	);
	await writeFile(
		path.join(configDir, "state.json"),
		`${JSON.stringify({ lastModelId: "deep" })}\n`,
		"utf8",
	);

	const config = loadAppConfig({
		cwd,
		homeDir,
		env: {},
	});

	assert.equal(config.modelId, "deep");
	assert.equal(config.model.name, "deep-model");
});

test("loadAppConfig lets MODEL_ID override the remembered model", async () => {
	const cwd = await createTempDir("sigpi-config-env-model-project-");
	const homeDir = await createTempDir("sigpi-config-env-model-home-");
	const configDir = path.join(homeDir, ".sigpi");

	await mkdir(configDir, { recursive: true });
	await writeFile(
		path.join(configDir, "config.toml"),
		[
			"[model]",
			'active = "fast"',
			"",
			"[models.fast]",
			'base_url = "https://fast.example/v1"',
			'api_key = "fast-key"',
			'name = "fast-model"',
			"",
			"[models.deep]",
			'base_url = "https://deep.example/v1"',
			'api_key = "deep-key"',
			'name = "deep-model"',
		].join("\n"),
		"utf8",
	);
	await writeFile(
		path.join(configDir, "state.json"),
		`${JSON.stringify({ lastModelId: "deep" })}\n`,
		"utf8",
	);

	const config = loadAppConfig({
		cwd,
		homeDir,
		env: {
			MODEL_ID: "fast",
		},
	});

	assert.equal(config.modelId, "fast");
	assert.equal(config.model.name, "fast-model");
});

test("loadAppConfig ignores a remembered model missing from current config", async () => {
	const cwd = await createTempDir("sigpi-config-stale-model-project-");
	const homeDir = await createTempDir("sigpi-config-stale-model-home-");
	const configDir = path.join(homeDir, ".sigpi");

	await mkdir(configDir, { recursive: true });
	await writeFile(
		path.join(configDir, "config.toml"),
		[
			"[model]",
			'active = "fast"',
			"",
			"[models.fast]",
			'base_url = "https://fast.example/v1"',
			'api_key = "fast-key"',
			'name = "fast-model"',
		].join("\n"),
		"utf8",
	);
	await writeFile(
		path.join(configDir, "state.json"),
		`${JSON.stringify({ lastModelId: "removed" })}\n`,
		"utf8",
	);

	const config = loadAppConfig({
		cwd,
		homeDir,
		env: {},
	});

	assert.equal(config.modelId, "fast");
	assert.equal(config.model.name, "fast-model");
});

test("default config paths target ~/.sigpi and project .sigpi", () => {
	assert.equal(
		getDefaultUserConfigPath("/tmp/home"),
		path.join("/tmp/home", ".sigpi", "config.toml"),
	);
	assert.equal(
		getDefaultProjectConfigPath("/tmp/project"),
		path.join("/tmp/project", ".sigpi", "config.toml"),
	);
	assert.equal(
		getDefaultSessionsRoot("/tmp/home"),
		path.join("/tmp/home", ".sigpi", "projects"),
	);
	assert.equal(
		getDefaultLogFilePath("/tmp/home"),
		path.join("/tmp/home", ".sigpi", "logs", "agent.log"),
	);
});

test("default model config uses a 60 second timeout with 2 retries", async () => {
	const cwd = await createTempDir("sigpi-config-default-model-");
	const homeDir = await createTempDir("sigpi-config-default-model-home-");
	const configDir = path.join(cwd, ".sigpi");
	await mkdir(configDir, { recursive: true });
	await writeFile(
		path.join(configDir, "config.toml"),
		[
			"[models.demo]",
			'base_url = "https://configured.example/v1"',
			'api_key = "configured-key"',
			'name = "configured-model"',
		].join("\n"),
		"utf8",
	);
	const config = loadAppConfig({
		cwd,
		homeDir,
		env: {
			MODEL_BASE_URL: "https://example.test/v1",
			MODEL_API_KEY: "env-key",
			MODEL_NAME: "demo-model",
		},
	});

	assert.equal(config.model.timeoutMs, 60000);
	assert.equal(config.model.maxRetries, 2);
	assert.equal(config.logging.filePath, getDefaultLogFilePath(homeDir));
	assert.match(renderDefaultConfigToml(), /\[models\.local\]/);
	assert.match(renderDefaultConfigToml(), /timeout_ms = 60000/);
	assert.match(renderDefaultConfigToml(), /max_retries = 2/);
	assert.match(
		renderDefaultConfigToml(),
		/file = "~\/\.sigpi\/logs\/agent\.log"/,
	);
});

test("loadAppConfig rejects removed verbose agent key", async () => {
	const cwd = await createTempDir("sigpi-config-removed-verbose-");
	const homeDir = await createTempDir("sigpi-config-removed-verbose-home-");
	const configDir = path.join(cwd, ".sigpi");
	await mkdir(configDir, { recursive: true });
	await writeFile(
		path.join(configDir, "config.toml"),
		[
			"[models.demo]",
			'base_url = "https://configured.example/v1"',
			'api_key = "configured-key"',
			'name = "configured-model"',
			"",
			"[agent]",
			"verbose = true",
		].join("\n"),
		"utf8",
	);

	assert.throws(() => loadAppConfig({ cwd, homeDir, env: {} }), /verbose/);
});

test("parseTomlConfig rejects removed execution-guard keys under [tools.bash]", () => {
	const toml = [
		"[models.m]",
		'base_url = "https://x/v1"',
		'api_key = "k"',
		'name = "n"',
		"[tools.bash]",
		'mode = "full_access"',
		'allowed_roots = ["/tmp"]',
	].join("\n");

	assert.throws(
		() => parseTomlConfig(toml),
		/removed execution-guard/i,
		"config with removed mode/allowed_roots should fail to parse",
	);
});

test("loadAppConfig fails to load a config file carrying removed [tools.bash] guards", async () => {
	const cwd = await createTempDir("sigpi-config-removed-guards-project-");
	const homeDir = await createTempDir("sigpi-config-removed-guards-home-");
	await mkdir(path.join(homeDir, ".sigpi"), { recursive: true });
	await writeFile(
		path.join(homeDir, ".sigpi", "config.toml"),
		[
			"[models.m]",
			'base_url = "https://x/v1"',
			'api_key = "k"',
			'name = "n"',
			"[tools.bash]",
			'mode = "full_access"',
		].join("\n"),
		"utf8",
	);

	assert.throws(
		() => loadAppConfig({ cwd, homeDir, env: {} }),
		/Failed to load config file|removed execution-guard/i,
		"config file with removed mode key should fail to load",
	);
});

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { loadAgentStateSync } from "./state.js";
import type {
	LogLevel,
	ProcessOutputMode,
	RunShellMode,
	ShellKind,
} from "./types.js";

const modelConfigSchema = z.object({
	baseURL: z.string().min(1),
	apiKey: z.string().min(1),
	name: z.string().min(1),
	apiFormat: z
		.enum(["chat_completions", "responses"])
		.default("chat_completions"),
	stream: z.boolean().default(true),
	timeoutMs: z.number().int().positive().default(60_000),
	maxRetries: z.number().int().min(0).max(5).default(2),
	retryBaseDelayMs: z.number().int().positive().default(250),
	/**
	 * Model's maximum output tokens. Used as a cap when sizing the
	 * compaction summary so we never ask the model for a summary larger
	 * than it can produce. Optional; defaults to 2048 internally when
	 * not configured.
	 */
	maxTokens: z.number().int().positive().optional(),
});

const agentConfigSchema = z.object({
	maxSteps: z.number().int().positive().default(20),
	/**
	 * Model's full context window in tokens. The compact trigger fires when
	 * `tokens > contextWindow - reserveTokens`. When the model hasn't yet
	 * reported usage, the token estimate falls back to `chars / 4`.
	 */
	contextWindow: z.number().int().positive().default(200_000),
	/** Tokens reserved for the model's response. */
	reserveTokens: z.number().int().nonnegative().default(16_384),
	/** Recent tokens to keep un-summarized when summarizing. */
	keepRecentTokens: z.number().int().positive().default(20_000),
	processOutput: z
		.enum(["compact", "detailed"], {
			errorMap: () => ({
				message:
					'Invalid [agent] process_output. Valid values are "compact" or "detailed".',
			}),
		})
		.default("detailed"),
});

const loggingConfigSchema = z.object({
	level: z.enum(["debug", "info", "warn", "error"]).default("info"),
	filePath: z.string().min(1),
	toConsole: z.boolean().default(false),
	maxBodyPreviewChars: z.number().int().positive().default(16_000),
	maxConsoleBodyPreviewChars: z.number().int().positive().default(500),
});

const storageConfigSchema = z.object({
	sessionsRoot: z.string().min(1).default("~/.sigpi/projects"),
});

const shellKindSchema = z.enum([
	"zsh",
	"bash",
	"sh",
	"pwsh",
	"powershell",
	"cmd",
]);

const shellConfigSchema = z.object({
	kind: shellKindSchema.optional(),
	path: z.string().min(1).optional(),
});

const runShellModeSchema = z.enum([
	"read_only",
	"workspace_write",
	"full_access",
]);

const bashConfigSchema = z.object({
	mode: runShellModeSchema.default("workspace_write"),
	defaultTimeoutMs: z.number().int().positive().default(120_000),
	maxTimeoutMs: z.number().int().positive().default(600_000),
	maxOutputLength: z.number().int().positive().default(30_000),
	maintainProjectWorkingDir: z.boolean().default(false),
	envFile: z.string().min(1).optional(),
});

const appConfigSchema = z.object({
	model: modelConfigSchema,
	modelId: z.string().min(1),
	models: z.record(modelConfigSchema),
	agent: agentConfigSchema.default({}),
	logging: loggingConfigSchema,
	storage: storageConfigSchema.default({}),
	shell: shellConfigSchema.default({}),
	tools: z
		.object({
			bash: bashConfigSchema.default({}),
		})
		.default({}),
});

/**
 * Single source of truth for the camelCase ↔ snake_case field names of the
 * on-disk TOML config. Each map is consumed in both directions: `snakeFields`
 * renames the authoritative app sub-schema's keys when building
 * `tomlRootSchema`, and `mapSection` inverts the same map when reading parsed
 * TOML back into the camelCase `PartialConfig`. Adding a config field means
 * adding one row here (and to the app sub-schema) — the two schemas can no
 * longer drift.
 */
const MODEL_ALIASES: Record<string, string> = {
	baseURL: "base_url",
	apiKey: "api_key",
	name: "name",
	apiFormat: "api_format",
	stream: "stream",
	timeoutMs: "timeout_ms",
	maxRetries: "max_retries",
	retryBaseDelayMs: "retry_base_delay_ms",
	maxTokens: "max_tokens",
};
const AGENT_ALIASES: Record<string, string> = {
	maxSteps: "max_steps",
	contextWindow: "context_window",
	reserveTokens: "reserve_tokens",
	keepRecentTokens: "keep_recent_tokens",
	processOutput: "process_output",
};
const LOGGING_ALIASES: Record<string, string> = {
	level: "level",
	filePath: "file",
	toConsole: "to_console",
	maxBodyPreviewChars: "max_body_preview_chars",
	maxConsoleBodyPreviewChars: "max_console_body_preview_chars",
};
const STORAGE_ALIASES: Record<string, string> = {
	sessionsRoot: "sessions_root",
};
const SHELL_ALIASES: Record<string, string> = {
	kind: "kind",
	path: "path",
};
const BASH_ALIASES: Record<string, string> = {
	mode: "mode",
	defaultTimeoutMs: "default_timeout_ms",
	maxTimeoutMs: "max_timeout_ms",
	maxOutputLength: "max_output_length",
	maintainProjectWorkingDir: "maintain_project_working_dir",
	envFile: "env_file",
};

/**
 * The six section alias maps, grouped as the canonical camelCase ↔ snake_case
 * contract. Exported so tests can assert every alias is wired through
 * `parseTomlConfig` (forward completeness); the reverse direction is enforced
 * at module load by `snakeFields`.
 */
export const CONFIG_ALIASES = {
	model: MODEL_ALIASES,
	agent: AGENT_ALIASES,
	logging: LOGGING_ALIASES,
	storage: STORAGE_ALIASES,
	shell: SHELL_ALIASES,
	bash: BASH_ALIASES,
};

/**
 * Build the optional, snake-cased TOML shape for one config section by pulling
 * the field *types* from the authoritative app sub-schema (`.shape`) and the
 * field *names* from `aliases`. `strict` rejects unknown keys when set (used
 * for the model section, matching prior behaviour); every field is otherwise
 * `.partial()` so an override file stays fully optional.
 */
function snakeFields(
	subSchema: z.ZodTypeAny,
	aliases: Record<string, string>,
	strict = false,
) {
	const shape = (subSchema as z.ZodObject<z.ZodRawShape>).shape;
	const out: z.ZodRawShape = {};
	for (const [camel, snake] of Object.entries(aliases)) {
		const type = shape[camel];
		if (!type) {
			throw new Error(`config alias "${camel}" has no matching field`);
		}
		out[snake] = type.optional();
	}
	// Reverse guard: every app sub-schema field must be present in the alias
	// map. Without this, a field added to the app schema silently never
	// appears on disk, and the two schemas drift. Enforced at module load.
	for (const camel of Object.keys(shape)) {
		if (!(camel in aliases)) {
			throw new Error(
				`config sub-schema field "${camel}" missing from alias map`,
			);
		}
	}
	const built = z.object(out).partial();
	return strict ? built.strict() : built;
}

const tomlRootSchema = z.object({
	model: z
		.object({
			active: z.string().min(1).optional(),
			default: z.string().min(1).optional(),
		})
		.strict()
		.partial()
		.optional(),
	models: z
		.record(snakeFields(modelConfigSchema, MODEL_ALIASES, true))
		.optional(),
	agent: snakeFields(agentConfigSchema, AGENT_ALIASES, true).optional(),
	logging: snakeFields(loggingConfigSchema, LOGGING_ALIASES).optional(),
	storage: snakeFields(storageConfigSchema, STORAGE_ALIASES).optional(),
	shell: snakeFields(shellConfigSchema, SHELL_ALIASES).optional(),
	tools: z
		.object({
			bash: snakeFields(bashConfigSchema, BASH_ALIASES).optional(),
		})
		.partial()
		.optional(),
});

export interface ModelConfig {
	baseURL: string;
	apiKey: string;
	name: string;
	apiFormat: "chat_completions" | "responses";
	stream: boolean;
	timeoutMs: number;
	maxRetries: number;
	retryBaseDelayMs: number;
	maxTokens?: number;
}

export interface AgentConfig {
	maxSteps: number;
	contextWindow: number;
	reserveTokens: number;
	keepRecentTokens: number;
	processOutput: ProcessOutputMode;
}

export interface LoggingConfig {
	level: LogLevel;
	filePath: string;
	toConsole: boolean;
	maxBodyPreviewChars: number;
	maxConsoleBodyPreviewChars: number;
}

export interface StorageConfig {
	sessionsRoot: string;
}

export interface ShellConfig {
	kind?: ShellKind;
	path?: string;
}

export interface RunShellConfig {
	mode: RunShellMode;
	/** Default per-command timeout in ms (clamped to maxTimeoutMs). */
	defaultTimeoutMs?: number;
	/** Hard ceiling per-command timeout in ms. */
	maxTimeoutMs?: number;
	/** Inline output length before overflow is written to a session file. */
	maxOutputLength?: number;
	/** When true, every command starts in the project directory (no cd carry-over). */
	maintainProjectWorkingDir?: boolean;
	/** Optional shell script sourced before each command (env persistence). */
	envFile?: string;
}

export interface ToolsConfig {
	bash: RunShellConfig;
}

export interface AppConfig {
	model: ModelConfig;
	modelId: string;
	models: Record<string, ModelConfig>;
	agent: AgentConfig;
	logging: LoggingConfig;
	storage: StorageConfig;
	shell: ShellConfig;
	tools: ToolsConfig;
}

interface PartialToolsConfig {
	bash?: Partial<RunShellConfig>;
}

interface PartialConfig {
	model?: Partial<ModelConfig>;
	modelId?: string;
	models?: Record<string, Partial<ModelConfig>>;
	agent?: Partial<AgentConfig>;
	logging?: Partial<LoggingConfig>;
	storage?: Partial<StorageConfig>;
	shell?: Partial<ShellConfig>;
	tools?: PartialToolsConfig;
}

export interface LoadAppConfigOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
}

export interface InitializeUserConfigOptions {
	homeDir?: string;
	overwrite?: boolean;
}

export function loadAppConfig(options: LoadAppConfigOptions = {}): AppConfig {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? os.homedir();

	const userConfigPath = path.join(homeDir, ".sigpi", "config.toml");
	const projectConfigPath = path.join(cwd, ".sigpi", "config.toml");

	const fileConfig = mergeConfigs(
		readConfigFile(userConfigPath),
		readConfigFile(projectConfigPath),
	);
	const envConfig = readEnvConfig(env);
	const merged = mergeConfigs(fileConfig, envConfig);

	const agentState = loadAgentStateSync({ homeDir });
	const rememberedModelId =
		!envConfig.modelId &&
		agentState.lastModelId &&
		fileConfig.models?.[agentState.lastModelId]
			? agentState.lastModelId
			: undefined;
	const resolvedModelId =
		envConfig.modelId ?? rememberedModelId ?? fileConfig.modelId;

	const modelConfig = {
		...fileConfig,
		modelId: resolvedModelId,
	};

	try {
		const resolvedModels = resolveModelConfig(modelConfig, envConfig.model);
		const config = appConfigSchema.parse({
			model: resolvedModels.model,
			modelId: resolvedModels.modelId,
			models: resolvedModels.models,
			agent: merged.agent,
			logging: {
				...merged.logging,
				filePath: merged.logging?.filePath
					? expandHomePath(merged.logging.filePath, homeDir)
					: getDefaultLogFilePath(homeDir),
			},
			storage: {
				...merged.storage,
				sessionsRoot: merged.storage?.sessionsRoot
					? expandHomePath(merged.storage.sessionsRoot, homeDir)
					: getDefaultSessionsRoot(homeDir),
			},
			shell: {
				...merged.shell,
				path: merged.shell?.path
					? expandHomePath(merged.shell.path, homeDir)
					: undefined,
			},
			tools: merged.tools,
		});

		return config;
	} catch (error) {
		if (error instanceof z.ZodError) {
			const messages = error.issues.map(
				(issue) => `${issue.path.join(".")}: ${issue.message}`,
			);
			throw new Error(
				`Invalid configuration in ${userConfigPath} or ${projectConfigPath}: ${messages.join("; ")}`,
			);
		}
		throw error;
	}
}

export function getDefaultUserConfigPath(
	homeDir: string = os.homedir(),
): string {
	return path.join(homeDir, ".sigpi", "config.toml");
}

export function getDefaultProjectConfigPath(
	cwd: string = process.cwd(),
): string {
	return path.join(cwd, ".sigpi", "config.toml");
}

export function getDefaultSessionsRoot(homeDir: string = os.homedir()): string {
	return path.join(homeDir, ".sigpi", "projects");
}

export function getDefaultGlobalSkillsDir(
	homeDir: string = os.homedir(),
): string {
	return path.join(homeDir, ".sigpi", "skills");
}

export function getDefaultLogFilePath(homeDir: string = os.homedir()): string {
	return path.join(homeDir, ".sigpi", "logs", "agent.log");
}

export function renderDefaultConfigToml(): string {
	return [
		"[model]",
		'default = "local"',
		"",
		"[models.local]",
		'base_url = "http://localhost:8000/v1"',
		'api_key = "your-api-key"',
		'name = "your-model-name"',
		'api_format = "chat_completions"',
		"timeout_ms = 60000",
		"max_retries = 2",
		"retry_base_delay_ms = 250",
		"# stream = true  # set false for providers that do not support streaming",
		"# max_tokens = 8192  # model max output tokens; caps the /compact summary request",
		"",
		"# [models.remote]",
		'# base_url = "https://api.example.com/v1"',
		'# api_key = "your-api-key"',
		'# name = "remote-model"',
		'# api_format = "responses"',
		"",
		"[agent]",
		"# Token-based context management. Compact triggers when",
		"# `tokens > context_window - reserve_tokens`. The recent-message",
		"# window keeps the last `keep_recent_tokens` tokens verbatim.",
		"max_steps = 20",
		"context_window = 200000",
		"reserve_tokens = 16384",
		"keep_recent_tokens = 20000",
		'process_output = "detailed"',
		"",
		"[logging]",
		'level = "info"',
		'file = "~/.sigpi/logs/agent.log"',
		"to_console = false",
		"# Max chars of a model response body captured in logs (file vs console).",
		"# max_body_preview_chars = 16000",
		"# max_console_body_preview_chars = 500",
		"",
		"[storage]",
		'sessions_root = "~/.sigpi/projects"',
		"",
		"[shell]",
		'# kind = "zsh"',
		'# path = "/bin/zsh"',
		"",
		"[tools.bash]",
		"# Shared tool safety mode: read_only, workspace_write, or full_access.",
		"# This is a guardrail against accidental writes, not strong isolation for untrusted code.",
		'mode = "workspace_write"',
		"# Command timeout bounds (milliseconds). default_timeout_ms must be <= max_timeout_ms.",
		"# default_timeout_ms = 120000",
		"# max_timeout_ms = 600000",
		"# Inline output length (chars) before overflow is written to a session file.",
		"# max_output_length = 30000",
		"# When true, every command starts in the project directory (no cd carry-over).",
		"# maintain_project_working_dir = false",
		"# Optional shell script sourced before each command so env vars persist.",
		'# env_file = "~/.sigpi/bash-env.sh"',
		"",
	].join("\n");
}

export async function initializeUserConfig(
	options: InitializeUserConfigOptions = {},
): Promise<{ configPath: string; created: boolean }> {
	const homeDir = options.homeDir ?? os.homedir();
	const configPath = getDefaultUserConfigPath(homeDir);
	const configDir = path.dirname(configPath);

	await mkdir(configDir, { recursive: true, mode: 0o700 });

	try {
		await writeFile(configPath, renderDefaultConfigToml(), {
			encoding: "utf8",
			mode: 0o600,
			flag: options.overwrite ? "w" : "wx",
		});
		return { configPath, created: true };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST" && !options.overwrite) {
			return { configPath, created: false };
		}
		throw error;
	}
}

/**
 * Invert an alias map to read a parsed (snake_case) TOML section back into the
 * camelCase `PartialConfig` shape, copying only keys that are actually present.
 * The same map drives `snakeFields`, so the two directions cannot diverge.
 */
function mapSection<T>(
	raw: Record<string, unknown> | null | undefined,
	aliases: Record<string, string>,
): Partial<T> | undefined {
	if (!raw) return undefined;
	const out: Record<string, unknown> = {};
	for (const [camel, snake] of Object.entries(aliases)) {
		if (raw[snake] !== undefined) out[camel] = raw[snake];
	}
	return out as Partial<T>;
}

export function parseTomlConfig(content: string): PartialConfig {
	const parsed = parse(content);
	const validated = tomlRootSchema.parse(parsed);

	return {
		modelId: validated.model?.default ?? validated.model?.active,
		models: validated.models
			? Object.fromEntries(
					Object.entries(validated.models).map(([id, model]) => [
						id,
						mapSection<ModelConfig>(model, MODEL_ALIASES) ?? {},
					]),
				)
			: undefined,
		agent: mapSection<AgentConfig>(validated.agent, AGENT_ALIASES),
		logging: mapSection<LoggingConfig>(validated.logging, LOGGING_ALIASES),
		storage: mapSection<StorageConfig>(validated.storage, STORAGE_ALIASES),
		shell: mapSection<ShellConfig>(validated.shell, SHELL_ALIASES),
		tools: validated.tools?.bash
			? { bash: mapSection<RunShellConfig>(validated.tools.bash, BASH_ALIASES) }
			: undefined,
	};
}

function readConfigFile(filePath: string): PartialConfig {
	if (!existsSync(filePath)) {
		return {};
	}

	const content = readFileSync(filePath, "utf8");

	try {
		return parseTomlConfig(content);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to load config file ${filePath}: ${message}`);
	}
}

function readEnvConfig(env: NodeJS.ProcessEnv): PartialConfig {
	return {
		modelId: env.MODEL_ID,
		model: {
			baseURL: env.MODEL_BASE_URL,
			apiKey: env.MODEL_API_KEY,
			name: env.MODEL_NAME,
			apiFormat: parseOptionalApiFormat(env.MODEL_API_FORMAT),
			timeoutMs: parseOptionalInt(env.MODEL_TIMEOUT_MS),
			maxRetries: parseOptionalInt(env.MODEL_MAX_RETRIES),
			retryBaseDelayMs: parseOptionalInt(env.MODEL_RETRY_BASE_DELAY_MS),
			maxTokens: parseOptionalInt(env.MODEL_MAX_TOKENS),
			stream: parseOptionalBoolean(env.MODEL_STREAM),
		},
		agent: {
			maxSteps: parseOptionalInt(env.AGENT_MAX_STEPS),
			contextWindow: parseOptionalInt(env.AGENT_CONTEXT_WINDOW),
			reserveTokens: parseOptionalInt(env.AGENT_RESERVE_TOKENS),
			keepRecentTokens: parseOptionalInt(env.AGENT_KEEP_RECENT_TOKENS),
			processOutput: parseOptionalProcessOutputMode(env.AGENT_PROCESS_OUTPUT),
		},
		logging: {
			level: parseOptionalLevel(env.AGENT_LOG_LEVEL),
			filePath: env.AGENT_LOG_FILE,
			toConsole: parseOptionalBoolean(env.AGENT_LOG_TO_CONSOLE),
		},
		storage: {
			sessionsRoot: env.AGENT_SESSIONS_ROOT,
		},
		shell: {
			kind: parseOptionalShellKind(env.AGENT_SHELL),
			path: env.AGENT_SHELL_PATH,
		},
		tools: {
			bash: dropUndefined({
				mode: parseOptionalRunShellMode(
					env.AGENT_BASH_MODE ?? env.AGENT_RUN_SHELL_MODE,
				),
				defaultTimeoutMs: parseOptionalInt(env.BASH_DEFAULT_TIMEOUT_MS),
				maxTimeoutMs: parseOptionalInt(env.BASH_MAX_TIMEOUT_MS),
				maxOutputLength: parseOptionalInt(env.BASH_MAX_OUTPUT_LENGTH),
				maintainProjectWorkingDir: parseOptionalBoolean(
					env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR,
				),
				envFile: env.CLAUDE_ENV_FILE,
			}),
		},
	};
}

function mergeConfigs(...configs: PartialConfig[]): PartialConfig {
	const result: PartialConfig = {};

	for (const config of configs) {
		if (config.model) {
			result.model = { ...result.model, ...dropUndefined(config.model) };
		}
		if (config.modelId) {
			result.modelId = config.modelId;
		}
		if (config.models) {
			result.models = mergeNamedModels(result.models, config.models);
		}
		if (config.agent) {
			result.agent = { ...result.agent, ...dropUndefined(config.agent) };
		}
		if (config.logging) {
			result.logging = { ...result.logging, ...dropUndefined(config.logging) };
		}
		if (config.storage) {
			result.storage = { ...result.storage, ...dropUndefined(config.storage) };
		}
		if (config.shell) {
			result.shell = { ...result.shell, ...dropUndefined(config.shell) };
		}
		if (config.tools) {
			result.tools = mergeToolConfig(result.tools, config.tools);
		}
	}

	return result;
}

function resolveModelConfig(
	fileConfig: PartialConfig,
	envModel: Partial<ModelConfig> | undefined,
): {
	model: ModelConfig;
	modelId: string;
	models: Record<string, ModelConfig>;
} {
	const envOverrides = dropUndefined(envModel ?? {});
	const models: Record<string, ModelConfig> = {};

	for (const [id, model] of Object.entries(fileConfig.models ?? {})) {
		models[id] = modelConfigSchema.parse(dropUndefined(model));
	}

	const modelId = fileConfig.modelId;
	if (!modelId) {
		throw new Error("Missing required configuration: [model].default");
	}

	const selectedModel = models[modelId];
	if (!selectedModel) {
		throw new Error(`Active model "${modelId}" is not defined in [models]`);
	}

	const model = modelConfigSchema.parse({
		...selectedModel,
		...envOverrides,
	});
	models[modelId] = model;

	return {
		model,
		modelId,
		models,
	};
}

function mergeNamedModels(
	base: Record<string, Partial<ModelConfig>> | undefined,
	override: Record<string, Partial<ModelConfig>>,
): Record<string, Partial<ModelConfig>> {
	const result: Record<string, Partial<ModelConfig>> = { ...(base ?? {}) };
	for (const [id, model] of Object.entries(override)) {
		result[id] = { ...(result[id] ?? {}), ...dropUndefined(model) };
	}
	return result;
}

function dropUndefined<T extends object>(value: T): Partial<T> {
	const entries = Object.entries(value).filter(
		([, item]) => item !== undefined,
	);
	return Object.fromEntries(entries) as Partial<T>;
}

function parseOptionalInt(raw: string | undefined): number | undefined {
	if (raw === undefined) {
		return undefined;
	}

	const parsed = Number(raw);
	return Number.isInteger(parsed) ? parsed : undefined;
}

function parseOptionalBoolean(raw: string | undefined): boolean | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (raw === "1" || raw.toLowerCase() === "true") {
		return true;
	}
	if (raw === "0" || raw.toLowerCase() === "false") {
		return false;
	}
	return undefined;
}

function parseOptionalLevel(raw: string | undefined): LogLevel | undefined {
	switch (raw) {
		case "debug":
		case "info":
		case "warn":
		case "error":
			return raw;
		default:
			return undefined;
	}
}

function parseOptionalApiFormat(
	raw: string | undefined,
): ModelConfig["apiFormat"] | undefined {
	switch (raw) {
		case "chat_completions":
		case "responses":
			return raw;
		default:
			return undefined;
	}
}

function parseOptionalShellKind(
	raw: string | undefined,
): ShellKind | undefined {
	switch (raw) {
		case "zsh":
		case "bash":
		case "sh":
		case "pwsh":
		case "powershell":
		case "cmd":
			return raw;
		default:
			return undefined;
	}
}

function parseOptionalRunShellMode(
	raw: string | undefined,
): RunShellMode | undefined {
	switch (raw) {
		case "read_only":
		case "workspace_write":
		case "full_access":
			return raw;
		default:
			return undefined;
	}
}

function parseOptionalProcessOutputMode(
	raw: string | undefined,
): ProcessOutputMode | undefined {
	if (raw === undefined) return undefined;
	return raw as ProcessOutputMode;
}

function expandHomePath(rawPath: string, homeDir: string): string {
	if (rawPath === "~") {
		return homeDir;
	}

	if (rawPath.startsWith("~/")) {
		return path.join(homeDir, rawPath.slice(2));
	}

	return rawPath;
}

function mergeToolConfig(
	base: PartialToolsConfig | undefined,
	override: PartialToolsConfig,
): PartialToolsConfig {
	return {
		...base,
		...override,
		bash: {
			...(base?.bash ?? {}),
			...(override.bash ?? {}),
		},
	};
}

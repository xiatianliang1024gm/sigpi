import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import type { ProjectTrustPreference } from "./project-trust.js";
import { loadAgentStateSync } from "./state.js";
import type { LogLevel, ProcessOutputMode, ShellKind } from "./types.js";

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
	 * Optional HTTP/HTTPS proxy used for requests to this model's base URL.
	 * When set it seeds `HTTP_PROXY` / `HTTPS_PROXY` (only if the environment
	 * has not already set them). Leave unset to inherit the environment's
	 * proxy configuration, or to connect directly when no proxy is defined.
	 */
	proxy: z.string().optional(),
	/**
	 * Model's maximum output tokens. Used as a cap when sizing the
	 * compaction summary so we never ask the model for a summary larger
	 * than it can produce. Optional; defaults to 2048 internally when
	 * not configured.
	 */
	maxTokens: z.number().int().positive().optional(),
	/**
	 * The model's full context window in tokens (the physical ceiling).
	 * The compact trigger fires when `tokens > hardContextLimit -
	 * reserveTokens`. When the model hasn't yet reported usage, the token
	 * estimate falls back to `chars / 4`. Defaults to 200_000.
	 */
	hardContextLimit: z.number().int().positive().default(200_000),
	/** Tokens reserved for the model's response. Defaults to 16_384. */
	reserveTokens: z.number().int().nonnegative().default(16_384),
	/** Recent tokens to keep un-summarized when summarizing. Defaults to 20_000. */
	keepRecentTokens: z.number().int().positive().default(20_000),
});

const agentConfigSchema = z.object({
	maxSteps: z.number().int().positive().default(40),
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

const trustConfigSchema = z.object({
	defaultProjectTrust: z.enum(["ask", "always", "never"]).default("ask"),
});

const bashConfigSchema = z.object({
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
	trust: trustConfigSchema.default({}),
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
	proxy: "proxy",
	hardContextLimit: "hard_context_limit",
	reserveTokens: "reserve_tokens",
	keepRecentTokens: "keep_recent_tokens",
};
const AGENT_ALIASES: Record<string, string> = {
	maxSteps: "max_steps",
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
	defaultTimeoutMs: "default_timeout_ms",
	maxTimeoutMs: "max_timeout_ms",
	maxOutputLength: "max_output_length",
	maintainProjectWorkingDir: "maintain_project_working_dir",
	envFile: "env_file",
};
const TRUST_ALIASES: Record<string, string> = {
	defaultProjectTrust: "default_project_trust",
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
	trust: TRUST_ALIASES,
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
	trust: snakeFields(trustConfigSchema, TRUST_ALIASES).optional(),
	tools: z
		.object({
			bash: snakeFields(bashConfigSchema, BASH_ALIASES, true).optional(),
		})
		.strict()
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
	proxy?: string;
	/**
	 * The model's full context window in tokens (the physical ceiling). The
	 * compact trigger fires when `tokens > hardContextLimit - reserveTokens`.
	 * Optional here because the model schema applies a 200_000 default at load;
	 * the budget getter in `ConversationContext` treats it as required.
	 */
	hardContextLimit?: number;
	/** Tokens reserved for the model's response. Default 16_384 at load. */
	reserveTokens?: number;
	/** Recent tokens to keep un-summarized when summarizing. Default 20_000 at load. */
	keepRecentTokens?: number;
}

export interface AgentConfig {
	maxSteps: number;
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

export interface TrustConfig {
	defaultProjectTrust: ProjectTrustPreference;
}

export interface ShellConfig {
	kind?: ShellKind;
	path?: string;
}

export interface RunShellConfig {
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
	trust: TrustConfig;
}

interface PartialToolsConfig {
	bash?: Partial<RunShellConfig>;
}

interface PartialTrustConfig {
	defaultProjectTrust?: ProjectTrustPreference;
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
	trust?: PartialTrustConfig;
}

export interface LoadAppConfigOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	/**
	 * Whether to merge the project's `.sigpi/config.toml` override. Project
	 * config is trust-gated (ADR 0022): callers pass `false` when the project
	 * is not trusted (headless default, or a saved/per-run decline) and `true`
	 * once trust is granted. Defaults to `true` so callers that don't gate
	 * (and existing tests) keep merging project overrides.
	 */
	readProjectConfig?: boolean;
}

export interface InitializeUserConfigOptions {
	homeDir?: string;
	overwrite?: boolean;
}

/**
 * Reads the global `default_project_trust` preference without validating the
 * full config. Used by the pre-trust load in `resolveConfigAndTrust`: the only
 * configuration source may be the still-gated project config, which must not be
 * validated (and would fail model validation) before trust is resolved.
 */
export function readDefaultProjectTrust(
	homeDir: string = os.homedir(),
): ProjectTrustPreference {
	try {
		const userConfigPath = path.join(homeDir, ".sigpi", "config.toml");
		const fileConfig = readConfigFile(userConfigPath);
		return fileConfig.trust?.defaultProjectTrust ?? "ask";
	} catch {
		return "ask";
	}
}

export function loadAppConfig(options: LoadAppConfigOptions = {}): AppConfig {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? os.homedir();

	const userConfigPath = path.join(homeDir, ".sigpi", "config.toml");
	const projectConfigPath = path.join(cwd, ".sigpi", "config.toml");

	// Project config is trust-gated (ADR 0022): only merged once the project
	// is trusted. Callers pass `readProjectConfig: false` for the pre-trust
	// load (to read the global `defaultProjectTrust`) and `true` once trust
	// is granted. Defaults to `true` for backward compatibility.
	const readProjectConfig = options.readProjectConfig ?? true;

	const fileConfig = mergeConfigs(
		readConfigFile(userConfigPath),
		readProjectConfig ? readConfigFile(projectConfigPath) : {},
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
			trust: {
				defaultProjectTrust: merged.trust?.defaultProjectTrust ?? "ask",
			},
			tools: {
				...merged.tools,
			},
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
		"# hard_context_limit = 200000  # model's total token budget (physical ceiling)",
		"# reserve_tokens = 16384  # headroom reserved for the model's response",
		"# keep_recent_tokens = 20000  # recent tokens kept un-summarized",
		"",
		"# [models.remote]",
		'# base_url = "https://api.example.com/v1"',
		'# api_key = "your-api-key"',
		'# name = "remote-model"',
		'# api_format = "responses"',
		"# hard_context_limit = 128000",
		"# reserve_tokens = 16384",
		"# keep_recent_tokens = 20000",
		"",
		"[agent]",
		"# Token-based context management. The budget is model-bound: each model's",
		"# hard_context_limit / reserve_tokens / keep_recent_tokens live under",
		"# [models.<id>] (see above). The compact trigger fires when",
		"# `tokens > hard_context_limit - reserve_tokens`.",
		"max_steps = 20",
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
		"[trust]",
		"# How SigPi treats project-local resources (skills + project .sigpi/config.toml).",
		"#   ask (default): prompt in the REPL; headless one-shot skips them unless trusted.",
		"#   always:        load project resources without prompting.",
		"#   never:         ignore project resources (global config + global skills only).",
		"# A per-run --approve / --no-approve overrides this for a single run.",
		'default_project_trust = "ask"',
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

/**
 * Execution-guard keys removed by ADR 0023. A config that still carries them
 * must fail to load with a clear, actionable error rather than being silently
 * stripped (which would mask a now-invalid setup).
 */
const REMOVED_BASH_KEYS = new Set(["mode", "allowed_roots"]);

/**
 * Validate parsed TOML against `tomlRootSchema`, which is `.strict()` on the
 * `tools` section and its `bash` subsection. On an unrecognized-key error,
 * rewrite the message so removed execution guards point the user at the
 * replacement (`[trust] default_project_trust`) instead of a bare Zod error.
 */
function parseTrustedSchema(parsed: unknown): z.infer<typeof tomlRootSchema> {
	try {
		return tomlRootSchema.parse(parsed);
	} catch (error) {
		if (error instanceof z.ZodError) {
			throw new Error(describeConfigSchemaError(error));
		}
		throw error;
	}
}

function describeConfigSchemaError(error: z.ZodError): string {
	const removed: string[] = [];
	const others: string[] = [];
	for (const issue of error.issues) {
		if (issue.code === "unrecognized_keys") {
			const keys = (issue as { keys?: string[] }).keys ?? [];
			for (const key of keys) {
				if (REMOVED_BASH_KEYS.has(key)) {
					removed.push(key);
				} else {
					others.push([...issue.path, key].join("."));
				}
			}
		} else {
			others.push(`${issue.path.join(".") || "<root>"}: ${issue.message}`);
		}
	}
	const parts: string[] = [];
	if (removed.length > 0) {
		parts.push(
			`Config contains removed execution-guard keys that can no longer be loaded: ${removed.join(", ")}. These guards were removed (ADR 0023); SigPi now runs with the account's own permissions. ` +
				'Control project-resource loading with [trust] default_project_trust = "ask" | "always" | "never" instead.',
		);
	}
	if (others.length > 0) {
		parts.push(`Unrecognized config keys: ${others.join(", ")}.`);
	}
	return parts.join(" ");
}

export function parseTomlConfig(content: string): PartialConfig {
	const parsed = parse(content);
	const validated = parseTrustedSchema(parsed);

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
		...(validated.trust
			? { trust: mapSection<TrustConfig>(validated.trust, TRUST_ALIASES) }
			: {}),
		tools: validated.tools
			? {
					bash: validated.tools.bash
						? mapSection<RunShellConfig>(validated.tools.bash, BASH_ALIASES)
						: undefined,
				}
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
			proxy: env.MODEL_PROXY,
			hardContextLimit: parseOptionalInt(env.MODEL_HARD_CONTEXT_LIMIT),
			reserveTokens: parseOptionalInt(env.MODEL_RESERVE_TOKENS),
			keepRecentTokens: parseOptionalInt(env.MODEL_KEEP_RECENT_TOKENS),
		},
		agent: {
			maxSteps: parseOptionalInt(env.AGENT_MAX_STEPS),
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
		const resolved = modelConfigSchema.parse(dropUndefined(model));
		validateModelBudget(id, resolved);
		models[id] = resolved;
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
	validateModelBudget(modelId, model);
	models[modelId] = model;

	return {
		model,
		modelId,
		models,
	};
}

function validateModelBudget(modelId: string, model: ModelConfig): void {
	if (
		model.maxTokens != null &&
		model.hardContextLimit != null &&
		model.maxTokens > model.hardContextLimit
	) {
		throw new Error(
			`Model "${modelId}": max_tokens (${model.maxTokens}) must not exceed hard_context_limit (${model.hardContextLimit}).`,
		);
	}
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

function parseOptionalProcessOutputMode(
	raw: string | undefined,
): ProcessOutputMode | undefined {
	switch (raw) {
		case "compact":
		case "detailed":
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

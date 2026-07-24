import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type CompactionHookRegistry,
	createCompactionHookRegistry,
} from "./agent/compaction-hook.js";
import { ConversationContext } from "./agent/context.js";
import { AgentRunner } from "./agent/runner.js";
import { type AgentTurn, createAgentTurn } from "./agent/turn.js";
import {
	type AppConfig,
	getDefaultSessionsRoot,
	loadAppConfig,
	type ModelConfig,
} from "./config.js";
import { buildSystemPrompt, buildSystemPromptSections } from "./defaults.js";
import { createChildLogger, createLogger } from "./logger.js";
import { createModelProvider } from "./model/provider.js";
import { resolveSessionStoragePaths } from "./session/paths.js";
import {
	hydrateRuntimeFromSession,
	SessionRuntime,
} from "./session/runtime.js";
import {
	createSystemPromptFingerprint,
	DiskSessionStore,
	type SessionStore,
} from "./session/store.js";
import { captureRcDefinitions, detectShellRuntime } from "./shell.js";
import { loadSkillCatalog } from "./skills/catalog.js";
import { BackgroundTaskManager } from "./tools/background.js";
import { createDefaultToolRegistry } from "./tools/index.js";
import type {
	LoadedSession,
	LoadedSkill,
	PersistedSession,
	ProgressReporter,
	RuntimeLogger,
	SkillWarning,
	SystemPromptSection,
	ToolSchema,
} from "./types.js";

export interface AgentRuntime {
	runner: AgentRunner;
	context: ConversationContext;
	compactionHooks: CompactionHookRegistry;
	logger: RuntimeLogger;
	shellRuntime: ReturnType<typeof detectShellRuntime>;
	workingDirectory: string;
	systemPrompt: string;
	systemPromptSections: SystemPromptSection[];
	systemPromptFingerprint: string;
	toolSchemas: ToolSchema[];
	store: SessionStore; // interface; concrete DiskSessionStore in production
	session: PersistedSession | null;
	sessionRuntime: SessionRuntime | null;
	turn: AgentTurn;
	sessionWarnings: string[];
	loadedSkills: LoadedSkill[];
	skillWarnings: SkillWarning[];
	skillsFingerprint: string | null;
	config: AppConfig;
	runId: string;
	backgroundTasks: import("./tools/background.js").BackgroundTaskManager;
	tools: import("./tools/registry.js").ToolRegistry;
	/**
	 * Point the conversation context's budget getter at a newly selected
	 * model. Called by `/model switch` so the compaction trigger tracks the
	 * active model each turn (ADR-0021).
	 */
	setActiveModel: (model: ModelConfig) => void;
}

export interface CreateAgentRuntimeArgs {
	progressReporter?: ProgressReporter;
	sessionId?: string;
	sessionTitle?: string;
	createSession?: boolean;
	config?: AppConfig;
	/**
	 * Whether to scan project skill roots (`.sigpi/skills`, `.agents/skills`
	 * walked up from cwd). Gated by project trust (ADR 0022): the CLI passes
	 * `false` when the project is not trusted and `true` once trust is granted.
	 * Defaults to `true` so callers that don't gate (and existing tests) keep
	 * loading project skills.
	 */
	includeProjectRoots?: boolean;
	/** Override the session store (e.g. an in-memory store for `--no-session`). */
	store?: SessionStore;
}

export function createRuntimeLogger(config: AppConfig): RuntimeLogger {
	return createLogger(config.logging);
}

export function createRuntimeSessionStore(args?: {
	cwd?: string;
	config?: Pick<AppConfig, "storage">;
	homeDir?: string;
	sessionsRoot?: string;
	logger?: RuntimeLogger;
}): SessionStore {
	const cwd = args?.cwd ?? process.cwd();
	const sessionsRoot =
		args?.sessionsRoot ??
		args?.config?.storage.sessionsRoot ??
		getDefaultSessionsRoot(args?.homeDir);

	return new DiskSessionStore({
		storagePaths: resolveSessionStoragePaths({
			cwd,
			sessionsRoot,
		}),
		logger: args?.logger,
	});
}

export async function loadRuntimeSkillCatalog(args: {
	cwd?: string;
	homeDir?: string;
	logger?: RuntimeLogger;
	includeProjectRoots?: boolean;
}): Promise<{
	loadedSkills: LoadedSkill[];
	warnings: SkillWarning[];
	fingerprint: string | null;
}> {
	const cwd = args.cwd ?? process.cwd();
	const homeDir = args.homeDir ?? process.env.HOME ?? "";

	const catalog = await loadSkillCatalog({
		cwd,
		homeDir,
		includeProjectRoots: args.includeProjectRoots ?? true,
	});

	args.logger?.info("skills_loaded", {
		loadedSkillCount: catalog.loadedSkills.length,
		warningCount: catalog.warnings.length,
	});
	for (const warning of catalog.warnings) {
		args.logger?.warn("skill_warning", {
			skillName: warning.skillName,
			message: warning.message,
		});
	}

	return catalog;
}

export async function bootstrapSessionState(args: {
	store: SessionStore;
	context: ConversationContext;
	systemPromptFingerprint: string;
	loadedSkillNames: string[];
	skillsFingerprint: string | null;
	sessionId?: string;
	sessionTitle?: string;
	createSession?: boolean;
	logger?: RuntimeLogger;
	cwd?: string;
}): Promise<{
	loadedSession: LoadedSession | null;
	session: PersistedSession | null;
	warnings: string[];
}> {
	const cwd = args.cwd ?? process.cwd();
	let loadedSession: LoadedSession | null = null;
	let session: PersistedSession | null = null;

	if (args.sessionId) {
		loadedSession = await args.store.loadSession({
			sessionId: args.sessionId,
			cwd,
			systemPromptFingerprint: args.systemPromptFingerprint,
			loadedSkillNames: args.loadedSkillNames,
			skillsFingerprint: args.skillsFingerprint,
		});
		session = await hydrateRuntimeFromSession({
			context: args.context,
			store: args.store,
			loadedSession,
		});
	} else if (args.createSession) {
		session = await args.store.createSession({
			cwd,
			systemPromptFingerprint: args.systemPromptFingerprint,
			title: args.sessionTitle,
			loadedSkillNames: args.loadedSkillNames,
			skillsFingerprint: args.skillsFingerprint,
		});
	}

	for (const warning of loadedSession?.warnings ?? []) {
		args.logger?.warn("session_restore_warning", {
			sessionId: session?.sessionId ?? args.sessionId ?? null,
			message: warning,
		});
	}

	return {
		loadedSession,
		session,
		warnings: loadedSession?.warnings ?? [],
	};
}

export async function createAgentRuntime(
	args: CreateAgentRuntimeArgs = {},
): Promise<AgentRuntime> {
	const cwd = process.cwd();
	const config = args.config ?? loadAppConfig();
	const runId = randomUUID();
	const baseLogger = createRuntimeLogger(config);
	const runLogger = createChildLogger(baseLogger, { runId });
	const shellRuntime = detectShellRuntime(config.shell);
	const homeDir = process.env.HOME ?? os.homedir();
	const skillCatalog = await loadRuntimeSkillCatalog({
		cwd,
		homeDir,
		logger: runLogger,
		includeProjectRoots: args.includeProjectRoots ?? true,
	});
	const systemPromptSections = buildSystemPromptSections(
		shellRuntime,
		skillCatalog.loadedSkills,
	);
	const systemPrompt = buildSystemPrompt(
		shellRuntime,
		skillCatalog.loadedSkills,
	);
	const systemPromptFingerprint = createSystemPromptFingerprint(systemPrompt);
	const store =
		args.store ??
		createRuntimeSessionStore({
			cwd,
			config,
			logger: runLogger,
		});
	const compactionHooks = createCompactionHookRegistry();
	const tools = createDefaultToolRegistry(shellRuntime, config.tools.bash);
	// Holder for the *active* model so the context budget getter can track
	// `/model switch` each turn (ADR-0021). The context never caches a budget;
	// it re-reads this holder on every compaction / estimate.
	const activeModelRef: { current: ModelConfig } = { current: config.model };
	const conversationContext = new ConversationContext({
		summaryEnabled: true,
		getContextBudget: () => ({
			hardContextLimit: activeModelRef.current.hardContextLimit ?? 200_000,
			reserveTokens: activeModelRef.current.reserveTokens ?? 16_384,
			keepRecentTokens: activeModelRef.current.keepRecentTokens ?? 20_000,
		}),
		logger: runLogger,
		runId,
		sessionId: args.sessionId ?? null,
		compactionHooks,
		ledgerRecorder: (toolCall, result, ledger) =>
			tools.recordLedger(toolCall, result, ledger),
	});
	const sessionState = await bootstrapSessionState({
		store,
		context: conversationContext,
		systemPromptFingerprint,
		loadedSkillNames: skillCatalog.loadedSkills.map((skill) => skill.name),
		skillsFingerprint: skillCatalog.fingerprint,
		sessionId: args.sessionId,
		sessionTitle: args.sessionTitle,
		createSession: args.createSession,
		logger: runLogger,
		cwd,
	});
	conversationContext.bindSession(sessionState.session?.sessionId ?? null);
	const runtimeLogger = createChildLogger(runLogger, {
		sessionId: sessionState.session?.sessionId ?? null,
	});
	const provider = createModelProvider(config.model, runtimeLogger);
	const toolSchemas = tools.getSchemas();

	const sessionStoragePaths = resolveSessionStoragePaths({
		cwd,
		sessionsRoot: config.storage.sessionsRoot,
	});
	const bashSessionId = sessionState.session?.sessionId ?? null;
	const bashOutputDir = bashSessionId
		? path.join(sessionStoragePaths.sessionsDir, bashSessionId, "bash-outputs")
		: path.join(os.tmpdir(), "sigpi-bash-outputs");
	const backgroundTaskManager = new BackgroundTaskManager();
	const rcDefinitions = await captureRcDefinitions(shellRuntime).catch(
		() => "",
	);
	const rcDefinitionsFile = rcDefinitions
		? path.join(os.tmpdir(), `sigpi-rc-${randomUUID()}.sh`)
		: undefined;
	if (rcDefinitionsFile) {
		writeFileSync(rcDefinitionsFile, rcDefinitions);
	}
	const bashToolContext = {
		workingDir: {
			current: cwd,
			projectDir: cwd,
			maintainProjectWorkingDir:
				config.tools.bash.maintainProjectWorkingDir ?? false,
		},
		outputDir: bashOutputDir,
		rcDefinitionsFile,
		tasks: backgroundTaskManager,
	};

	const runner = new AgentRunner({
		provider,
		tools,
		context: conversationContext,
		systemPrompt,
		options: {
			maxSteps: config.agent.maxSteps,
			workingDirectory: cwd,
			logger: runtimeLogger,
			progressReporter: args.progressReporter,
			runId,
			sessionId: sessionState.session?.sessionId ?? null,
			bashToolContext,
		},
	});

	const sessionRuntime = sessionState.session
		? new SessionRuntime(
				runner,
				conversationContext,
				store,
				sessionState.session,
			)
		: null;

	const turn = createAgentTurn({
		runner,
		context: conversationContext,
		store,
		session:
			sessionState.session ??
			(await store.createSession({
				cwd,
				systemPromptFingerprint,
				loadedSkillNames: skillCatalog.loadedSkills.map((skill) => skill.name),
				skillsFingerprint: skillCatalog.fingerprint,
			})),
	});

	return {
		runner,
		context: conversationContext,
		compactionHooks,
		logger: runtimeLogger,
		shellRuntime,
		workingDirectory: cwd,
		systemPrompt,
		systemPromptSections,
		systemPromptFingerprint,
		toolSchemas,
		tools,
		store,
		session: sessionState.session,
		sessionRuntime,
		turn,
		sessionWarnings: sessionState.warnings,
		loadedSkills: skillCatalog.loadedSkills,
		skillWarnings: skillCatalog.warnings,
		skillsFingerprint: skillCatalog.fingerprint,
		config,
		runId,
		backgroundTasks: backgroundTaskManager,
		setActiveModel: (model: ModelConfig) => {
			activeModelRef.current = model;
		},
	};
}

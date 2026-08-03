import type { ModelConfig } from "./config.js";
import { estimateContextTokens } from "./context-window.js";
import { getGitBranch } from "./git.js";
import { type AgentRuntime, createAgentRuntime } from "./runtime.js";
import type { SessionStore } from "./session/store.js";
import {
	prepareSessionChoices,
	selectSessionInteractive,
} from "./session-selector.js";
import type { ReplView } from "./tui/chat-renderer.js";
import {
	getStatusEventLabel,
	StatusBarComponent,
	type StatusBarModel,
} from "./tui/status-bar.js";
import type {
	ModelUsage,
	ProgressReporter,
	SessionSummary,
	ShellRuntime,
	TurnProgressEvent,
} from "./types.js";

export interface ChatReplState {
	/** The agent runtime this REPL session is driving. Most state lives here. */
	runtime: AgentRuntime;
	shellRuntime: ShellRuntime;
	loadedSkillNames: readonly string[];
	modelId: string;
	modelName: string;
	models: Record<string, ModelConfig>;
	view: ReplView | null;
}

export interface AttachSessionResult {
	updatedState: ChatReplState;
	selectedSessionId: string;
	warnings: string[];
}

export type ResumeAvailability = { ok: true } | { ok: false; message: string };

export async function attachSessionFromSelector(
	state: ChatReplState,
	store: SessionStore,
	progressReporter?: ProgressReporter,
): Promise<AttachSessionResult | null> {
	const availability = getResumeAvailability(state);
	if (!availability.ok) {
		return null;
	}

	const sessions = prepareSessionChoices(await store.listSessions());
	const sessionId = await selectSessionInteractive(sessions, {
		parentTui: state.view?.getTuiInstance(),
	});

	if (!sessionId) {
		return null;
	}

	return attachSessionById(sessionId, progressReporter);
}

export async function attachSessionById(
	sessionId: string,
	progressReporter?: ProgressReporter,
): Promise<AttachSessionResult> {
	const runtime = await createAgentRuntime({
		progressReporter,
		sessionId,
	});

	return {
		updatedState: runtimeToChatReplState(runtime),
		selectedSessionId: sessionId,
		warnings: runtime.sessionWarnings,
	};
}

export async function attachNewSession(
	progressReporter?: ProgressReporter,
): Promise<AttachSessionResult> {
	const runtime = await createAgentRuntime({
		progressReporter,
		createSession: true,
	});

	const sessionId = runtime.session?.sessionId ?? "";
	return {
		updatedState: runtimeToChatReplState(runtime),
		selectedSessionId: sessionId,
		warnings: runtime.sessionWarnings,
	};
}

export function runtimeToChatReplState(runtime: AgentRuntime): ChatReplState {
	return {
		runtime,
		shellRuntime: runtime.shellRuntime,
		loadedSkillNames: runtime.loadedSkills.map((skill) => skill.name),
		modelId: runtime.config.modelId,
		modelName: runtime.config.model.name,
		models: runtime.config.models,
		view: null,
	};
}

export function getResumeAvailability(
	state: ChatReplState,
): ResumeAvailability {
	void state;
	return { ok: true };
}

export function getActiveSessionSummary(
	state: ChatReplState,
): SessionSummary | null {
	const session = state.runtime.turn.getCurrentSession();
	if (!session) {
		return null;
	}

	return {
		sessionId: session.sessionId,
		title: session.title,
		lastCompletedUserInput: session.lastCompletedUserInput,
		updatedAt: session.updatedAt,
		cwd: session.cwd,
		turnCount: session.turnCount,
		lastTurnStatus: session.lastTurn?.status ?? null,
		estimatedTokens: null,
	};
}

export async function formatStatusBar(
	state: ChatReplState,
): Promise<StatusBarModel> {
	const lastUsage = state.runtime.context.getLastUsage();
	const usage = lastUsage?.usage ?? null;
	// Prefer the provider-reported ground-truth token count from the last
	// response. When the provider never reports usage on the streaming path
	// (e.g. DeepSeek's responses API omits usage in streams even with
	// `include: ["usage"]`) or a compaction dropped the measured message, fall
	// back to the same context-token estimate the runner feeds the status bar
	// during the turn — so a completed turn keeps showing a token count
	// instead of regressing to `?`. A brand-new conversation with no content
	// yet still renders the honest `?` via `null`.
	const model = await buildStatusBarModel(
		state,
		usage ? usage.totalTokens : estimateIdleContextTokens(state),
		usage,
		null,
	);
	return model;
}

/**
 * Estimate the current context size from the live context state, mirroring
 * the runner's in-turn estimate (`estimatedContextTokens` on progress events).
 * Returns `null` when the conversation has no content yet (no summary and no
 * recent messages), so a fresh session keeps the honest `?` instead of
 * reporting a system-prompt-only figure as if it were measured usage.
 */
function estimateIdleContextTokens(state: ChatReplState): number | null {
	const context = state.runtime.context;
	if (!context.getSummary() && context.getRecentMessages().length === 0) {
		return null;
	}
	return estimateContextTokens({
		systemPrompt: state.runtime.systemPrompt,
		summary: context.getSummary(),
		recentMessages: context.getRecentMessages(),
		toolSchemas: state.runtime.toolSchemas,
	}).totalTokens;
}

export function getCurrentWorkingDirectory(state: ChatReplState): string {
	return (
		state.runtime.turn.getCurrentSession()?.cwd ??
		state.runtime.workingDirectory
	);
}

export async function formatStatusBarForEvent(
	state: ChatReplState,
	event: TurnProgressEvent | null,
): Promise<StatusBarModel> {
	if (typeof event?.estimatedContextTokens === "number") {
		// A live, in-flight estimate of the request being built. It has no
		// completed `usage` payload yet, so no cache-hit segment.
		const model = await buildStatusBarModel(
			state,
			event.estimatedContextTokens,
			null,
			getStatusEventLabel(event),
		);
		return model;
	}

	const base = await formatStatusBar(state);
	const suffix = getStatusEventLabel(event);
	if (!suffix) {
		return base;
	}
	base.eventLabel = suffix;
	return base;
}

/**
 * Build the status bar view-model for `state`: resolve the usable context
 * budget, the working directory, and the async git branch lookup. The result
 * is handed to {@link StatusBarComponent} for rendering.
 */
export async function buildStatusBarModel(
	state: ChatReplState,
	usedTokens: number | null,
	usage: ModelUsage | null,
	eventLabel: string | null = null,
): Promise<StatusBarModel> {
	const budget = state.runtime.context.getContextBudget();
	const limit = Math.max(1, budget.hardContextLimit - budget.reserveTokens);
	const cwd = getCurrentWorkingDirectory(state);
	const branch = await getGitBranch(cwd);
	return {
		modelName: state.modelName,
		limit,
		usedTokens,
		usage,
		cwd,
		branch,
		eventLabel,
	};
}

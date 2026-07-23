import type { ModelConfig } from "./config.js";
import { getGitBranch } from "./git.js";
import { setCurrentPlan } from "./plan-tracker.js";
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
	const sessionId = await selectSessionInteractive(sessions);

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
	// A new or resumed session starts with no active plan; clear any plan
	// left over from a previous session so the footer does not show stale
	// steps from another conversation.
	setCurrentPlan(null);

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
		status: session.status,
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
	// Use the provider-reported ground-truth token count from the last
	// response. Before the first response (no usage yet) we show `?` rather
	// than a drift-prone estimate.
	const model = await buildStatusBarModel(
		state,
		usage ? usage.totalTokens : null,
		usage,
		null,
	);
	return model;
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

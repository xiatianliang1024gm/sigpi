import type { ModelConfig } from "./config.js";
import { estimateContextTokens } from "./context-window.js";
import { getCachedBranch } from "./git.js";
import { type AgentRuntime, createAgentRuntime } from "./runtime.js";
import type { SessionStore } from "./session/store.js";
import {
	prepareSessionChoices,
	selectSessionInteractive,
} from "./session-selector.js";
import type { ReplView } from "./tui/chat-renderer.js";
import {
	getStatusEventLabel,
	type LastTurnStats,
	StatusBarComponent,
	type StatusBarModel,
} from "./tui/status-bar.js";
import type { ModelUsage, ShellRuntime, TurnProgressEvent } from "./types.js";

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

interface AttachSessionResult {
	updatedState: ChatReplState;
	selectedSessionId: string;
	warnings: string[];
}

type ResumeAvailability = { ok: true } | { ok: false; message: string };

export async function attachSessionFromSelector(
	state: ChatReplState,
	store: SessionStore,
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

	return attachSessionById(sessionId);
}

export async function attachSessionById(
	sessionId: string,
): Promise<AttachSessionResult> {
	const runtime = await createAgentRuntime({
		sessionId,
	});

	return {
		updatedState: runtimeToChatReplState(runtime),
		selectedSessionId: sessionId,
		warnings: runtime.sessionWarnings,
	};
}

export async function attachNewSession(): Promise<AttachSessionResult> {
	const runtime = await createAgentRuntime({
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

/**
 * Live turn state the REPL loop threads into the status bar: the turn clock
 * (started at user submit, stopped at the terminal event) and the stats of
 * the most recent finished turn, which stay visible while idle.
 */
interface StatusBarTurnContext {
	/** Epoch ms when the current turn started; `null`/absent while idle. */
	turnStartedAt?: number | null;
	/** Stats of the last finished turn, shown while idle until the next turn. */
	lastTurnStats?: LastTurnStats | null;
}

export async function formatStatusBarForEvent(
	state: ChatReplState,
	event: TurnProgressEvent | null,
	turnContext: StatusBarTurnContext = {},
): Promise<StatusBarModel> {
	let model: StatusBarModel;
	if (typeof event?.estimatedContextTokens === "number") {
		// A live, in-flight estimate of the request being built. It has no
		// completed `usage` payload yet, so no cache-hit segment.
		model = await buildStatusBarModel(
			state,
			event.estimatedContextTokens,
			null,
			getStatusEventLabel(event),
		);
	} else {
		const base = await formatStatusBar(state);
		const suffix = getStatusEventLabel(event);
		if (!suffix) {
			model = base;
		} else {
			base.eventLabel = suffix;
			model = base;
		}
	}

	// Merge live turn timing / last-turn stats into whatever the event built.
	const lastTurn = turnContext.lastTurnStats ?? null;
	model.turnStartedAt = turnContext.turnStartedAt ?? null;
	model.lastTurnStats = lastTurn;
	if (lastTurn && !model.eventLabel) {
		// The terminal event has been cleared from `latestProgressEvent`, but
		// the finished turn's label ("done", "interrupted", ...) should stay
		// on the bar alongside its time/token totals until the next turn.
		model.eventLabel = lastTurn.label;
	}
	return model;
}

/**
 * Build the status bar view-model for `state`: resolve the usable context
 * budget, the working directory, and the cached git branch. The result is
 * handed to {@link StatusBarComponent} for rendering.
 */
async function buildStatusBarModel(
	state: ChatReplState,
	usedTokens: number | null,
	usage: ModelUsage | null,
	eventLabel: string | null = null,
): Promise<StatusBarModel> {
	const budget = state.runtime.context.getContextBudget();
	const limit = Math.max(1, budget.hardContextLimit - budget.reserveTokens);
	const cwd = getCurrentWorkingDirectory(state);
	// Read the branch sampled by the background watcher (see git.ts). This is
	// synchronous: a status-bar redraw never spawns or awaits git, so a slow
	// git process cannot stall the turn clock or input handling.
	const branch = getCachedBranch();
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

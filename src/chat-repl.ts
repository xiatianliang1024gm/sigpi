import { homedir } from "node:os";
import type { ModelConfig } from "./config.js";
import { getGitBranch } from "./git.js";
import { setCurrentPlan } from "./plan-tracker.js";
import { type AgentRuntime, createAgentRuntime } from "./runtime.js";
import type { SessionStore } from "./session/store.js";
import {
	prepareSessionChoices,
	selectSessionInteractive,
} from "./session-selector.js";
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

export async function formatStatusBar(state: ChatReplState): Promise<string> {
	const lastUsage = state.runtime.context.getLastUsage();
	const usage = lastUsage?.usage ?? null;
	// Use the provider-reported ground-truth token count from the last
	// response. Before the first response (no usage yet) we show `?` rather
	// than a drift-prone estimate.
	return renderStatusBar(state, usage ? usage.totalTokens : null, usage);
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
): Promise<string> {
	const base =
		typeof event?.estimatedContextTokens === "number"
			? // A live, in-flight estimate of the request being built. It has no
				// completed `usage` payload yet, so no cache-hit segment.
				renderStatusBar(state, event.estimatedContextTokens, null)
			: await formatStatusBar(state);
	const suffix = getStatusEventLabel(event);
	if (!suffix) {
		return base;
	}
	return `${base} | ${suffix}`;
}

async function renderStatusBar(
	state: ChatReplState,
	usedTokens: number | null,
	usage: ModelUsage | null,
): Promise<string> {
	const budget = state.runtime.context.getContextBudget();
	const limit = Math.max(1, budget.hardContextLimit - budget.reserveTokens);
	const cwd = getCurrentWorkingDirectory(state);
	const branch = await getGitBranch(cwd);
	const cwdSegment = branch
		? `${shortenWorkingDirectory(cwd)} (${branch})`
		: shortenWorkingDirectory(cwd);

	const segments: string[] = [];
	const limitStr = formatCompactNumber(limit);
	if (usedTokens === null) {
		// No provider-reported usage yet (fresh session, after /recover, or a
		// legacy resume with no `usage`). Honest `?` beats a wrong estimate.
		segments.push(`tokens ?/${limitStr}`);
	} else {
		const usedStr = formatCompactNumber(usedTokens);
		const percentUsed = Math.round((usedTokens / limit) * 100);
		const tokenSegment = `tokens ${usedStr}/${limitStr} (${percentUsed}%)`;
		const cacheHitRate = usage ? computeCacheHitRate(usage) : null;
		segments.push(
			cacheHitRate ? `${tokenSegment} Hit(${cacheHitRate}%)` : tokenSegment,
		);
	}
	segments.push(cwdSegment);

	return segments.join(" | ");
}

/**
 * Compute the cache hit rate as a percentage of input tokens that came from
 * the prompt cache. Returns `null` when there is no input to measure against
 * (so we never render `Hit(NaN%)` or `Hit(0.0%)` for a fresh conversation).
 * The result is rounded to one decimal place and formatted as a string so
 * the status bar always renders a consistent `Hit(80.0%)` shape.
 */
function computeCacheHitRate(usage: ModelUsage): string | null {
	const input = usage.input;
	const cacheRead = usage.cacheRead;
	const denominator = input + cacheRead;
	if (denominator <= 0) {
		return null;
	}
	const percent = Math.round((cacheRead / denominator) * 1000) / 10;
	return percent.toFixed(1);
}

function getStatusEventLabel(event: TurnProgressEvent | null): string | null {
	if (!event) {
		return null;
	}

	switch (event.type) {
		case "turn_started":
			return "working";
		case "step_started":
			return null;
		case "interrupt_requested":
			return event.interruptStage === "model"
				? "cancelling"
				: "interrupt requested";
		case "model_request_started":
			return "thinking";
		case "model_delta":
			return null;
		case "model_request_finished":
			return null;
		case "assistant_message":
			return null;
		case "context_checkpoint":
			return "checkpoint";
		case "tool_calls_received":
			return null;
		case "tool_execution_started":
			return (
				event.message ?? (event.toolName ? `tool ${event.toolName}` : "tool")
			);
		case "tool_execution_finished":
			return event.toolOk
				? null
				: event.toolName
					? `failed ${event.toolName}`
					: "tool failed";
		case "turn_finished":
			return "done";
		case "turn_interrupted":
			return "interrupted";
		case "turn_max_steps_reached":
			return "max steps";
		case "turn_failed":
			return "failed";
	}
}

function formatCompactNumber(value: number): string {
	if (!Number.isFinite(value)) {
		return "0";
	}
	if (Math.abs(value) < 1000) {
		return String(Math.round(value));
	}
	const formatter = new Intl.NumberFormat("en", {
		notation: "compact",
		maximumFractionDigits: 1,
	});
	return formatter.format(value);
}

function shortenWorkingDirectory(value: string): string {
	const home = homedir();
	if (!home) {
		return value;
	}
	if (value === home) {
		return "~";
	}
	return value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
}

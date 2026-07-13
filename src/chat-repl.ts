import { homedir } from "node:os";
import type { ModelConfig } from "./config.js";
import { estimateContextTokens } from "./context-window.js";
import { setCurrentPlan } from "./plan-tracker.js";
import { type AgentRuntime, createAgentRuntime } from "./runtime.js";
import type { SessionStore } from "./session/store.js";
import {
	prepareSessionChoices,
	selectSessionInteractive,
} from "./session-selector.js";
import type {
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
	contextWindow: {
		contextWindow: number;
		reserveTokens: number;
	};
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
		contextWindow: {
			contextWindow: runtime.config.agent.contextWindow,
			reserveTokens: runtime.config.agent.reserveTokens,
		},
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

export function formatStatusBar(state: ChatReplState): string {
	const lastUsage = state.runtime.context.getLastUsage();
	const tokens = estimateContextTokens({
		systemPrompt: state.runtime.systemPromptSections
			.map((section) => section.content)
			.join(" "),
		summary: state.runtime.context.getSummary(),
		recentMessages: state.runtime.context.getRecentMessages(),
		toolSchemas: state.runtime.toolSchemas,
		lastUsage: lastUsage?.usage ?? null,
		lastUsageMessageIndex: lastUsage?.messageIndex ?? null,
	});
	return formatStatusBarWithUsedTokens(state, tokens.totalTokens);
}

export function getCurrentWorkingDirectory(state: ChatReplState): string {
	return (
		state.runtime.turn.getCurrentSession()?.cwd ?? state.runtime.workingDirectory
	);
}

export function formatStatusBarForEvent(
	state: ChatReplState,
	event: TurnProgressEvent | null,
): string {
	const base =
		typeof event?.estimatedContextTokens === "number"
			? formatStatusBarWithUsedTokens(state, event.estimatedContextTokens)
			: formatStatusBar(state);
	const suffix = getStatusEventLabel(event);
	if (!suffix) {
		return base;
	}
	return `${base} | ${suffix}`;
}

function formatStatusBarWithUsedTokens(
	state: ChatReplState,
	usedTokens: number,
): string {
	const contextWindow = state.contextWindow.contextWindow;
	const reserveTokens = state.contextWindow.reserveTokens;
	const limit = Math.max(1, contextWindow - reserveTokens);
	const percentUsed = Math.round((usedTokens / limit) * 100);

	return [
		`model ${state.modelName}`,
		`tokens ${formatCompactNumber(usedTokens)}/${formatCompactNumber(limit)} (${percentUsed}%)`,
		shortenWorkingDirectory(getCurrentWorkingDirectory(state)),
	].join(" | ");
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

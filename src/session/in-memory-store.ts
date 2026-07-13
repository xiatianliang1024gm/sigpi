import { randomUUID } from "node:crypto";
import { formatLocalTimestamp } from "../time.js";
import type {
	ConversationContextState,
	ExecutedToolCall,
	InterruptSource,
	InterruptStage,
	LoadedSession,
	PersistedSession,
	SessionSummary,
} from "../types.js";
import { deriveTitle, nextTurnId } from "./store.js";
import type { SessionStore } from "./store.js";

/**
 * In-memory `SessionStore` used for `--no-session` runs. It satisfies the same
 * contract as `DiskSessionStore` but keeps everything in a Map and never touches
 * disk, so an ephemeral one-shot prompt still goes through the single
 * `AgentTurn` path without persisting anything.
 */
export class InMemorySessionStore implements SessionStore {
	private readonly sessions = new Map<string, PersistedSession>();

	async createSession(args: {
		cwd: string;
		systemPromptFingerprint: string;
		title?: string;
		loadedSkillNames?: string[];
		skillsFingerprint?: string | null;
	}): Promise<PersistedSession> {
		const now = formatLocalTimestamp(new Date());
		const session: PersistedSession = {
			version: 4,
			sessionId: randomUUID(),
			title: args.title?.trim() ? args.title.trim() : null,
			createdAt: now,
			updatedAt: now,
			cwd: args.cwd,
			systemPromptFingerprint: args.systemPromptFingerprint,
			loadedSkillNames: [...(args.loadedSkillNames ?? [])],
			skillsFingerprint: args.skillsFingerprint ?? null,
			entries: [],
			explorationLedger: undefined,
			turnCount: 0,
			lastCompletedUserInput: null,
			status: "active",
			lastTurn: null,
			turns: [],
		};
		this.sessions.set(session.sessionId, session);
		return session;
	}

	async loadSession(args: {
		sessionId: string;
		cwd: string;
		systemPromptFingerprint: string;
		loadedSkillNames?: string[];
		skillsFingerprint?: string | null;
	}): Promise<LoadedSession> {
		const session = this.sessions.get(args.sessionId);
		if (!session) {
			throw new Error(`Session ${args.sessionId} not found.`);
		}
		if (args.cwd !== session.cwd) {
			throw new Error(
				`Session ${args.sessionId} was created for ${session.cwd}, not ${args.cwd}.`,
			);
		}
		return { session, warnings: [] };
	}

	async listSessions(): Promise<SessionSummary[]> {
		return [...this.sessions.values()]
			.map(toSessionSummary)
			.sort((left, right) =>
				compareTimestampDescending(left.updatedAt, right.updatedAt),
			);
	}

	async getSession(sessionId: string): Promise<PersistedSession> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found.`);
		}
		return session;
	}

	async pruneEmptySessions(): Promise<number> {
		return 0;
	}

	async markTurnStarted(args: {
		sessionId: string;
		userInput: string;
	}): Promise<PersistedSession> {
		const session = this.requireSession(args.sessionId);
		const startedAt = formatLocalTimestamp(new Date());
		const updated: PersistedSession = {
			...session,
			updatedAt: startedAt,
			status: "active",
			lastTurn: {
				startedAt,
				finishedAt: null,
				status: "in_progress",
				userInput: args.userInput,
				assistantOutput: null,
				toolExecutionCount: 0,
				interruptSource: null,
				interruptStage: null,
			},
		};
		this.sessions.set(updated.sessionId, updated);
		return updated;
	}

	async markTurnCompleted(args: {
		sessionId: string;
		userInput: string;
		assistantOutput: string;
		steps: number;
		toolExecutions: ExecutedToolCall[];
		contextState: ConversationContextState;
	}): Promise<PersistedSession> {
		const session = this.requireSession(args.sessionId);
		const finishedAt = formatLocalTimestamp(new Date());
		const title = session.title ?? deriveTitle(args.userInput);
		const startedAt = session.lastTurn?.startedAt ?? finishedAt;
		const turnId = nextTurnId(session.turns);
		const updated: PersistedSession = {
			...session,
			title,
			updatedAt: finishedAt,
			entries: args.contextState.entries ?? session.entries,
			explorationLedger: args.contextState.explorationLedger,
			turnCount: session.turnCount + 1,
			lastCompletedUserInput: args.userInput,
			status: "active",
			lastTurn: {
				startedAt,
				finishedAt,
				status: "completed",
				userInput: args.userInput,
				assistantOutput: args.assistantOutput,
				toolExecutionCount: args.toolExecutions.length,
				errorMessage: null,
				interruptSource: null,
				interruptStage: null,
			},
			turns: [
				...session.turns,
				{
					turnId,
					startedAt,
					finishedAt,
					status: "completed",
					userInput: args.userInput,
					assistantOutput: args.assistantOutput,
					steps: args.steps,
					toolExecutions: args.toolExecutions,
					errorMessage: null,
					interruptSource: null,
					interruptStage: null,
				},
			],
		};
		this.sessions.set(updated.sessionId, updated);
		return updated;
	}

	async markTurnFailed(args: {
		sessionId: string;
		userInput: string;
		errorMessage: string;
		assistantOutput?: string | null;
		steps?: number;
		toolExecutions?: ExecutedToolCall[];
		contextState?: ConversationContextState;
	}): Promise<PersistedSession> {
		const session = this.requireSession(args.sessionId);
		const finishedAt = formatLocalTimestamp(new Date());
		const startedAt = session.lastTurn?.startedAt ?? finishedAt;
		const userInput = session.lastTurn?.userInput ?? args.userInput;
		const assistantOutput =
			args.assistantOutput ?? session.lastTurn?.assistantOutput ?? null;
		const toolExecutionCount =
			args.toolExecutions?.length ?? session.lastTurn?.toolExecutionCount ?? 0;
		const turnId = nextTurnId(session.turns);
		const updated: PersistedSession = {
			...session,
			updatedAt: finishedAt,
			entries: args.contextState?.entries ?? session.entries,
			explorationLedger:
				args.contextState?.explorationLedger ?? session.explorationLedger,
			status: "active",
			lastTurn: session.lastTurn
				? {
						...session.lastTurn,
						finishedAt,
						status: "failed",
						userInput,
						assistantOutput,
						toolExecutionCount,
						errorMessage: args.errorMessage,
						interruptSource: null,
						interruptStage: null,
					}
				: {
						startedAt,
						finishedAt,
						status: "failed",
						userInput,
						assistantOutput,
						toolExecutionCount,
						errorMessage: args.errorMessage,
						interruptSource: null,
						interruptStage: null,
					},
			turns: [
				...session.turns,
				{
					turnId,
					startedAt,
					finishedAt,
					status: "failed",
					userInput,
					assistantOutput,
					steps: args.steps ?? 0,
					toolExecutions: args.toolExecutions ?? [],
					errorMessage: args.errorMessage,
					interruptSource: null,
					interruptStage: null,
				},
			],
		};
		this.sessions.set(updated.sessionId, updated);
		return updated;
	}

	async markTurnInterrupted(args: {
		sessionId: string;
		userInput: string;
		steps?: number;
		toolExecutions?: ExecutedToolCall[];
		contextState?: ConversationContextState;
		assistantOutput?: string | null;
		interruptSource: InterruptSource;
		interruptStage: InterruptStage;
	}): Promise<PersistedSession> {
		const session = this.requireSession(args.sessionId);
		const finishedAt = formatLocalTimestamp(new Date());
		const startedAt = session.lastTurn?.startedAt ?? finishedAt;
		const userInput = session.lastTurn?.userInput ?? args.userInput;
		const toolExecutionCount =
			args.toolExecutions?.length ?? session.lastTurn?.toolExecutionCount ?? 0;
		const assistantOutput = args.assistantOutput ?? null;
		const turnId = nextTurnId(session.turns);
		const updated: PersistedSession = {
			...session,
			updatedAt: finishedAt,
			entries: args.contextState?.entries ?? session.entries,
			explorationLedger:
				args.contextState?.explorationLedger ?? session.explorationLedger,
			status: "interrupted",
			lastTurn: {
				startedAt,
				finishedAt,
				status: "interrupted",
				userInput,
				assistantOutput,
				toolExecutionCount,
				errorMessage: null,
				interruptSource: args.interruptSource,
				interruptStage: args.interruptStage,
			},
			turns: [
				...session.turns,
				{
					turnId,
					startedAt,
					finishedAt,
					status: "interrupted",
					userInput,
					assistantOutput,
					steps: args.steps ?? 0,
					toolExecutions: args.toolExecutions ?? [],
					errorMessage: null,
					interruptSource: args.interruptSource,
					interruptStage: args.interruptStage,
				},
			],
		};
		this.sessions.set(updated.sessionId, updated);
		return updated;
	}

	async updateSnapshot(args: {
		sessionId: string;
		contextState: ConversationContextState;
	}): Promise<PersistedSession> {
		const session = this.requireSession(args.sessionId);
		const updatedAt = formatLocalTimestamp(new Date());
		const updated: PersistedSession = {
			...session,
			updatedAt,
			entries: args.contextState.entries ?? session.entries,
			explorationLedger: args.contextState.explorationLedger,
		};
		this.sessions.set(updated.sessionId, updated);
		return updated;
	}

	private requireSession(sessionId: string): PersistedSession {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found.`);
		}
		return session;
	}
}

function toSessionSummary(session: PersistedSession): SessionSummary {
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

function compareTimestampDescending(left: string, right: string): number {
	return left < right ? 1 : left > right ? -1 : 0;
}

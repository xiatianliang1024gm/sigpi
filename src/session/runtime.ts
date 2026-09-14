import type { ConversationContext } from "../agent/context.js";
import type { AgentRunner } from "../agent/runner.js";
import type { TurnInterruptController } from "../interrupt.js";
import type {
	ContextUpdateResult,
	LoadedSession,
	PersistedSession,
	RunTurnResult,
} from "../types.js";
import { type SessionStore, sessionToContextState } from "./store.js";

export class SessionRuntime {
	private readonly persistedListeners = new Set<() => void>();

	constructor(
		private readonly runner: AgentRunner,
		private readonly context: ConversationContext,
		private readonly store: SessionStore,
		private session: PersistedSession,
	) {
		// Messaging-level persistence (ADR 0026, D5): the runner flushes each
		// message batch the moment it is complete — the user input at turn
		// start and one checkpoint per agent-loop step — so the store is kept
		// current incrementally instead of only at turn boundaries. The
		// snapshot commit is incremental on the entry stream
		// (`entries.slice(prevCount)`), so a mid-turn flush is cheap.
		this.runner.setPersistContext(async () => {
			this.session = await this.store.updateSnapshot({
				sessionId: this.session.sessionId,
				contextState: this.context.exportState(),
			});
			this.notifyPersisted();
		});
	}

	/**
	 * Register a listener invoked after each successful persistence flush. The
	 * `SessionManager` uses it to advance a session's event-log watermark, so a
	 * reconnecting client can resume its SSE stream exactly where the persisted
	 * history ends (see `SessionEventLog.markPersisted`).
	 */
	onPersisted(listener: () => void): () => void {
		this.persistedListeners.add(listener);
		return () => {
			this.persistedListeners.delete(listener);
		};
	}

	private notifyPersisted(): void {
		// Snapshot so a listener that unsubscribes mid-delivery can't perturb it.
		for (const listener of [...this.persistedListeners]) {
			listener();
		}
	}

	getCurrentSession(): PersistedSession {
		return this.session;
	}

	async compactContext(options?: {
		instructions?: string;
		abortSignal?: AbortSignal;
	}): Promise<ContextUpdateResult> {
		const updated = await this.runner.compactContext(options);

		// No `trimmed` guard: compaction either summarized (persist the new
		// summary + entry stream) or threw (D4/D6 — nothing to persist, the
		// context is untouched on failure).
		if (updated.summarized) {
			this.session = await this.store.updateSnapshot({
				sessionId: this.session.sessionId,
				contextState: this.context.exportState(),
			});
			this.notifyPersisted();
		}

		return updated;
	}

	async runTurn(
		userInput: string,
		interruptController?: TurnInterruptController,
	): Promise<RunTurnResult> {
		this.session = await this.store.markTurnStarted({
			sessionId: this.session.sessionId,
			userInput,
		});

		try {
			const result = await this.runner.runTurn(userInput, interruptController);
			if (result.completionStatus === "interrupted") {
				this.session = await this.store.markTurnInterrupted({
					sessionId: this.session.sessionId,
					userInput,
					assistantOutput: null,
					toolExecutions: result.toolExecutions,
					contextState: this.context.exportState(),
					interruptSource: result.interruptSource ?? "user_escape",
					interruptStage: result.interruptStage ?? "tool",
				});
				return result;
			}

			this.session = await this.store.markTurnCompleted({
				sessionId: this.session.sessionId,
				userInput,
				assistantOutput: result.outputText ?? "",
				toolExecutions: result.toolExecutions,
				contextState: this.context.exportState(),
			});
			return result;
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.session = await this.store.markTurnFailed({
				sessionId: this.session.sessionId,
				userInput,
				errorMessage,
				assistantOutput: null,
				toolExecutions: [],
				contextState: this.context.exportState(),
			});
			throw error;
		}
	}
}

export async function hydrateRuntimeFromSession(args: {
	context: ConversationContext;
	store: SessionStore;
	loadedSession: LoadedSession;
}): Promise<PersistedSession> {
	args.context.reset();
	args.context.hydrateState(sessionToContextState(args.loadedSession.session));
	return args.loadedSession.session;
}

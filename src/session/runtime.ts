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
	constructor(
		private readonly runner: AgentRunner,
		private readonly context: ConversationContext,
		private readonly store: SessionStore,
		private session: PersistedSession,
	) {}

	getCurrentSession(): PersistedSession {
		return this.session;
	}

	async compactContext(options?: {
		instructions?: string;
		abortSignal?: AbortSignal;
	}): Promise<ContextUpdateResult> {
		const updated = await this.runner.compactContext(options);

		if (updated.summarized || updated.trimmed) {
			this.session = await this.store.updateSnapshot({
				sessionId: this.session.sessionId,
				contextState: this.context.exportState(),
			});
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
					steps: result.steps,
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
				steps: result.steps,
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
				steps: 0,
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

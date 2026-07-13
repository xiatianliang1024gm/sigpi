import type { AgentRunner } from "./runner.js";
import type { TurnInterruptController } from "../interrupt.js";
import { formatModelErrorMessage } from "../model/error-format.js";
import type { ModelProvider } from "../model/provider.js";
import { SessionRuntime } from "../session/runtime.js";
import type {
	ContextUpdateResult,
	ExecutedToolCall,
	PersistedSession,
	RuntimeLogger,
} from "../types.js";

export type TurnResult =
	| {
			ok: true;
			completionStatus: "completed" | "interrupted";
			outputText: string | null;
			toolExecutions: ExecutedToolCall[];
	  }
	| {
			ok: false;
			errorMessage: string;
	  };

/**
 * The single deep module that drives an agent turn. It owns the
 * `SessionRuntime` (which binds `AgentRunner` + `ConversationContext` +
 * `SessionStore` + `PersistedSession`) and is the only turn interface the REPL
 * and one-shot paths hold. Replaces the old `runner | sessionRuntime` dual
 * state and the `executeChatTurn` wrapper (ADR-0010).
 */
export class AgentTurn {
	constructor(
		private readonly runner: AgentRunner,
		private readonly runtime: SessionRuntime,
	) {}

	getCurrentSession(): PersistedSession {
		return this.runtime.getCurrentSession();
	}

	setProvider(provider: ModelProvider): void {
		this.runner.setProvider(provider);
	}

	async compactContext(options?: {
		instructions?: string;
		abortSignal?: AbortSignal;
	}): Promise<ContextUpdateResult> {
		return this.runtime.compactContext(options);
	}

	async runTurn(
		input: string,
		logger: RuntimeLogger,
		interruptController?: TurnInterruptController,
	): Promise<TurnResult> {
		try {
			const result = await this.runtime.runTurn(input, interruptController);
			return {
				ok: true,
				completionStatus: result.completionStatus,
				outputText: result.outputText,
				toolExecutions: result.toolExecutions,
			};
		} catch (error) {
			const rawMessage = error instanceof Error ? error.message : String(error);
			logger.error("chat_turn_failed", {
				input,
				errorMessage: rawMessage,
			});
			return {
				ok: false,
				errorMessage: formatModelErrorMessage(error),
			};
		}
	}
}

export function createAgentTurn(args: {
	runner: AgentRunner;
	context: import("./context.js").ConversationContext;
	store: import("../session/store.js").SessionStore;
	session: PersistedSession;
}): AgentTurn {
	return new AgentTurn(
		args.runner,
		new SessionRuntime(args.runner, args.context, args.store, args.session),
	);
}

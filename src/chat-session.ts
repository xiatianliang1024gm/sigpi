import type { AgentRunner } from "./agent/runner.js";
import type { TurnInterruptController } from "./interrupt.js";
import type { SessionRuntime } from "./session/runtime.js";
import type { ExecutedToolCall, RuntimeLogger } from "./types.js";

export async function executeChatTurn(
	runner: AgentRunner | SessionRuntime,
	input: string,
	logger: RuntimeLogger,
	interruptController?: TurnInterruptController,
): Promise<
	| {
			ok: true;
			completionStatus: "completed" | "interrupted";
			outputText: string | null;
			toolExecutions: ExecutedToolCall[];
	  }
	| {
			ok: false;
			errorMessage: string;
	  }
> {
	try {
		const result = await runner.runTurn(input, interruptController);
		return {
			ok: true,
			completionStatus: result.completionStatus,
			outputText: result.outputText,
			toolExecutions: result.toolExecutions,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error("chat_turn_failed", {
			input,
			errorMessage,
		});
		return {
			ok: false,
			errorMessage,
		};
	}
}

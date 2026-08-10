import type { AgentRunner } from "./agent/runner.js";
import type { ModelUsage, RuntimeLogger, TurnProgressEvent } from "./types.js";

/**
 * Turn-progress events the runner used to log inline, now logged from a
 * single listener wired once per runtime (see `createAgentRuntime`). The
 * runner stays a pure emitter; the dated log file keeps the same entries.
 */
export function wireProgressLogging(
	runner: AgentRunner,
	logger: RuntimeLogger,
): void {
	// The turn id is carried once on `turn_started`; subsequent events in the
	// same turn reuse it until the terminal event clears it.
	let turnId: string | null = null;
	const tokenFields = (usage: ModelUsage | null) => ({
		inputTokens: usage?.input ?? 0,
		outputTokens: usage?.output ?? 0,
		cacheReadTokens: usage?.cacheRead ?? 0,
		cacheWriteTokens: usage?.cacheWrite ?? 0,
		turnTotalTokens: usage?.totalTokens ?? 0,
	});

	runner.onProgress((event: TurnProgressEvent) => {
		switch (event.type) {
			case "turn_started":
				turnId = event.turnId;
				logger.info("turn_started", {
					turnId: event.turnId,
					input: event.userInput,
				});
				break;
			case "context_compacted":
				logger.info("turn_context_compacted", {
					turnId: turnId ?? undefined,
					step: event.step,
					trigger: event.trigger,
					tokensBefore: event.tokensBefore,
					tokensAfter: event.tokensAfter,
				});
				break;
			case "context_checkpoint":
				logger.warn("turn_empty_response_retry", {
					turnId: turnId ?? undefined,
					step: event.step,
				});
				break;
			case "tool_calls_received":
				logger.info("tool_calls_received", {
					turnId: turnId ?? undefined,
					step: event.step,
					toolCallCount: event.count,
				});
				break;
			case "tool_execution_started":
				logger.info("tool_execution_started", {
					turnId: turnId ?? undefined,
					step: event.step,
					toolName: event.toolName,
					arguments: event.arguments
						? JSON.stringify(event.arguments)
						: undefined,
				});
				break;
			case "tool_execution_finished":
				if (event.ok) {
					logger.info("tool_execution_finished", {
						turnId: turnId ?? undefined,
						step: event.step,
						toolName: event.toolName,
						ok: true,
						elapsedMs: event.elapsedMs,
					});
				} else {
					logger.error("tool_execution_failed", {
						turnId: turnId ?? undefined,
						step: event.step,
						toolName: event.toolName,
						error: event.result ?? null,
						elapsedMs: event.elapsedMs,
					});
				}
				break;
			case "turn_finished":
				logger.info("turn_finished", {
					turnId: turnId ?? undefined,
					steps: event.step,
					turnElapsedMs: event.elapsedMs,
					...tokenFields(event.usage),
				});
				turnId = null;
				break;
			case "turn_interrupted":
				logger.info("turn_interrupted", {
					turnId: turnId ?? undefined,
					step: event.step,
					stage: event.stage,
					turnElapsedMs: event.elapsedMs,
					...tokenFields(event.usage),
				});
				turnId = null;
				break;
			case "turn_failed":
				logger.error("turn_failed", {
					turnId: turnId ?? undefined,
					step: event.step,
					failureType: event.failureType,
					error: event.message,
					turnElapsedMs: event.elapsedMs,
					...tokenFields(event.usage),
				});
				turnId = null;
				break;
			case "turn_max_steps_reached":
				logger.warn("turn_max_steps_reached", {
					turnId: turnId ?? undefined,
					step: event.step,
					turnElapsedMs: event.elapsedMs,
					...tokenFields(event.usage),
				});
				turnId = null;
				break;
		}
	});
}

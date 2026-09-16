import type { SessionEntry, TurnProgressEvent } from "../types.js";
import type { ProgressEventSource } from "./event-log.js";

/**
 * Session-level statistics for the web frontend's info line, in two halves that
 * come from different places because only one of them survives a process
 * restart:
 *
 * - {@link PersistedSessionStats} is summed from the session's persisted entry
 *   stream, so it covers every turn ever recorded (a resumed session included).
 * - {@link LiveSessionStats} is measured while *this* process drives the
 *   session's turns. Per-request wall-clock timing is not persisted anywhere, so
 *   it is only available for the turns this process actually observed.
 *
 * Kept UI-neutral (no DOM, no HTTP) so the derivation and the tracker are unit
 * testable and the browser client stays a dumb renderer.
 */

/** Token/turn totals folded out of a session's persisted entry stream. */
export interface PersistedSessionStats {
	/** Completed user turns (one user message per turn). */
	turns: number;
	/** Model steps (one assistant message per step). */
	steps: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
}

/** Wall-clock metrics measured while this process drives the session. */
export interface LiveSessionStats {
	/** Sum of the measured model-request durations, in ms. */
	llmMs: number;
	/** Sum of the reported tool-execution durations, in ms. */
	toolMs: number;
	/** Mean time from request start to first streamed token, in ms (`null` before any). */
	firstTokenAvgMs: number | null;
	/** Output tokens per second over the measured model time (`null` before any). */
	tokensPerSecond: number | null;
}

export interface SessionStats extends PersistedSessionStats, LiveSessionStats {}

const EMPTY_PERSISTED: PersistedSessionStats = {
	turns: 0,
	steps: 0,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
};

/**
 * Fold a session's entry stream into its durable totals. `turns` counts user
 * messages, `steps` counts assistant messages (one per model request), and the
 * token fields sum the provider usage recorded on assistant entries. Compaction
 * entries are skipped: their `usage` describes the summarize call, not a turn.
 */
export function derivePersistedStats(
	entries: readonly SessionEntry[],
): PersistedSessionStats {
	const stats: PersistedSessionStats = { ...EMPTY_PERSISTED };
	for (const entry of entries) {
		if (entry.kind !== "message") {
			continue;
		}
		const role = entry.message.role;
		if (role === "user") {
			stats.turns += 1;
			continue;
		}
		if (role !== "assistant") {
			continue;
		}
		stats.steps += 1;
		const usage = entry.usage;
		if (usage) {
			stats.inputTokens += usage.input;
			stats.outputTokens += usage.output;
			stats.cacheReadTokens += usage.cacheRead;
			stats.cacheWriteTokens += usage.cacheWrite;
			stats.totalTokens += usage.totalTokens;
		}
	}
	return stats;
}

/**
 * Subscribes to a session's progress stream and measures the timings the entry
 * stream does not retain: per-request duration (LLM time), first-token latency,
 * and per-tool duration. Subscribing to the controller (rather than a browser
 * connection) means the numbers keep accruing even while no client is watching.
 */
export class SessionStatsTracker {
	private requestStartedAt: number | null = null;
	private firstTokenRecorded = false;
	private llmMs = 0;
	private toolMs = 0;
	private outputTokens = 0;
	private firstTokenSumMs = 0;
	private firstTokenCount = 0;
	private readonly unsubscribe: () => void;

	constructor(
		source: ProgressEventSource,
		private readonly now: () => number = Date.now,
	) {
		this.unsubscribe = source.onProgress((event) => this.record(event));
	}

	private record(event: TurnProgressEvent): void {
		switch (event.type) {
			case "model_request_started":
				this.requestStartedAt = this.now();
				this.firstTokenRecorded = false;
				break;
			case "model_delta":
				if (this.requestStartedAt !== null && !this.firstTokenRecorded) {
					this.firstTokenRecorded = true;
					this.firstTokenSumMs += this.now() - this.requestStartedAt;
					this.firstTokenCount += 1;
				}
				break;
			case "model_request_finished":
				if (this.requestStartedAt !== null) {
					this.llmMs += this.now() - this.requestStartedAt;
					this.requestStartedAt = null;
				}
				break;
			case "tool_execution_finished":
				this.toolMs += event.elapsedMs;
				break;
			case "turn_finished":
			case "turn_interrupted":
			case "turn_failed":
			case "turn_max_steps_reached":
				if (event.usage) {
					this.outputTokens += event.usage.output;
				}
				break;
			default:
				break;
		}
	}

	/** The live metrics measured so far. */
	snapshot(): LiveSessionStats {
		const firstTokenAvgMs =
			this.firstTokenCount > 0
				? Math.round(this.firstTokenSumMs / this.firstTokenCount)
				: null;
		const tokensPerSecond =
			this.llmMs > 0 && this.outputTokens > 0
				? this.outputTokens / (this.llmMs / 1000)
				: null;
		return {
			llmMs: this.llmMs,
			toolMs: this.toolMs,
			firstTokenAvgMs,
			tokensPerSecond,
		};
	}

	/** Stop measuring. Idempotent. */
	dispose(): void {
		this.unsubscribe();
	}
}

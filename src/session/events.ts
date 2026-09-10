import { formatCompactNumber, formatElapsed } from "../format.js";
import type {
	ModelUsage,
	TurnProgressEvent,
	TurnTerminalEvent,
} from "../types.js";

/**
 * UI-neutral presentation layer for an agent turn. A frontend supplies a
 * {@link TurnTranscriptView} (the TUI's transcript, or a web client's message
 * list) and this module folds the runner's `TurnProgressEvent` stream into it.
 * Nothing here depends on `pi-tui`, `stdout`, or any transport, so the TUI and
 * a future web/SSE consumer share one reducer and one set of event semantics.
 */

/** A streaming assistant message the reducer appends deltas to. */
export interface AssistantMessageView {
	appendReasoning(text: string): void;
	appendContent(text: string): void;
	finalize(): void;
}

/** Handle for an in-flight tool-call line in the activity log. */
export interface ToolLineHandle {
	/** Mark the tool line as succeeded. */
	finish(): void;
	/** Append a red error summary to the same line. */
	fail(error: string): void;
}

/**
 * The minimal output surface {@link applyTurnProgress} writes to. `ReplView`
 * (the TUI) and any web transcript sink both satisfy this, which is what lets
 * the same event reducer drive every frontend.
 */
export interface TurnTranscriptView {
	/** Create a new streaming assistant message (one per model response). */
	beginAssistantMessage(): AssistantMessageView;
	/** Open a tool-call line that resolves in place when the tool finishes. */
	beginToolLine(id: string, label: string): ToolLineHandle;
	/** Append a system line (errors, notices, interruptions). */
	appendSystem(text: string, tone?: "error" | "info"): void;
}

/** The turn events that end a turn and carry final elapsed/token stats. */
export function isTurnTerminalEvent(
	event: TurnProgressEvent,
): event is TurnTerminalEvent {
	return (
		event.type === "turn_finished" ||
		event.type === "turn_interrupted" ||
		event.type === "turn_failed" ||
		event.type === "turn_max_steps_reached"
	);
}

/**
 * Render a compaction notice that highlights the context-window size change
 * (the number users actually care about) instead of a verbose recap. The
 * token snapshot is always present on `context_compacted`, so this is the
 * primary branch.
 */
export function formatCompactionMessage(
	event: Extract<TurnProgressEvent, { type: "context_compacted" }>,
): string {
	const { tokensBefore, tokensAfter } = event;
	if (tokensBefore > 0 || tokensAfter > 0) {
		return `Context compacted: context window ${formatCompactNumber(tokensBefore)} → ${formatCompactNumber(tokensAfter)} tokens.`;
	}
	return "Context compacted.";
}

/**
 * Apply one turn-progress event to a persistent transcript view. Returns the
 * current in-flight assistant-message view so the caller can thread it across
 * events within a turn, and a map of in-flight tool-line handles keyed by
 * tool-call id so the caller can resolve them on finish/fail.
 *
 * Each model response (one per agent step) gets its OWN assistant component,
 * created lazily on the first content/reasoning delta and finalized at the
 * step boundary (`model_request_finished` / `assistant_message` / terminal
 * events). This keeps every step's answer in a component appended in
 * chronological order — so the final conclusion lands AFTER the step's tool
 * results — and, crucially, never leaves a finalized component receiving a
 * later step's deltas. `AssistantMessageView.finalize()` locks the component
 * so further `appendContent`/`appendReasoning` calls are silently dropped; an
 * earlier design created a single component at turn start and finalized it
 * after the first step, so every later step's text (including the final
 * answer) was dropped and never rendered.
 */
export function applyTurnProgress(
	view: TurnTranscriptView,
	event: TurnProgressEvent,
	currentAssistant: AssistantMessageView | null,
	toolLines: Map<string, ToolLineHandle>,
): AssistantMessageView | null {
	if (event.type === "model_delta") {
		const assistant = currentAssistant ?? view.beginAssistantMessage();
		if (event.reasoningDelta) {
			assistant.appendReasoning(event.reasoningDelta);
		}
		if (event.contentDelta) {
			assistant.appendContent(event.contentDelta);
		}
		return assistant;
	}

	if (event.type === "interrupt_requested") {
		// The status bar alone ("cancelling") is easy to miss; surface the
		// interruption as a transcript line so the user sees the Esc/Ctrl+C
		// was acknowledged.
		view.appendSystem(event.message ?? "Interrupt requested.", "info");
		return currentAssistant;
	}

	if (event.type === "context_compacted") {
		view.appendSystem(formatCompactionMessage(event), "info");
		return currentAssistant;
	}

	if (event.type === "tool_execution_started" && event.toolName) {
		const id = event.toolCallId;
		if (id) {
			const handle = view.beginToolLine(id, event.message ?? event.toolName);
			toolLines.set(id, handle);
		}
		return currentAssistant;
	}

	if (event.type === "tool_execution_finished" && event.toolName) {
		const id = event.toolCallId || "";
		const handle = toolLines.get(id);
		if (handle) {
			toolLines.delete(id);
			handle.finish();
			if (event.ok !== true) {
				view.appendSystem(event.result ?? "failed", "error");
			}
		}
		return currentAssistant;
	}

	if (
		event.type === "model_request_finished" ||
		event.type === "assistant_message" ||
		event.type === "turn_interrupted" ||
		event.type === "turn_failed" ||
		event.type === "turn_max_steps_reached"
	) {
		currentAssistant?.finalize();
		// Finalize any remaining in-flight tool lines on terminal events.
		for (const handle of toolLines.values()) {
			handle.fail("interrupted");
		}
		toolLines.clear();
		if (event.type === "turn_interrupted") {
			view.appendSystem("Turn interrupted.", "info");
		}
		return null;
	}

	return currentAssistant;
}

/**
 * Cumulative agent usage across one REPL run (sigpi start → exit). Every
 * terminal turn event folds its elapsed/token totals in; when the loop exits
 * the totals are printed as a single summary line. Token fields mirror the
 * per-turn log fields, so `inputTokens + outputTokens` is the billed figure.
 */
export interface ReplRunStats {
	/** Number of turns that reached a terminal event in this run. */
	turnCount: number;
	/** Sum of each turn's user-submit → terminal-event elapsed time, in ms. */
	elapsedMs: number;
	/** Provider-reported usage summed across every turn's model requests. */
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
}

export function createReplRunStats(): ReplRunStats {
	return {
		turnCount: 0,
		elapsedMs: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
	};
}

/**
 * Fold a terminal turn event's stats into the run accumulator. Non-terminal
 * events, and turns that never emit a terminal event, are not counted.
 */
export function accumulateTurnStats(
	stats: ReplRunStats,
	event: TurnTerminalEvent,
): ReplRunStats {
	stats.turnCount += 1;
	stats.elapsedMs += event.elapsedMs;
	const tokens = event.usage;
	if (tokens) {
		stats.inputTokens += tokens.input;
		stats.outputTokens += tokens.output;
		stats.cacheReadTokens += tokens.cacheRead;
		stats.cacheWriteTokens += tokens.cacheWrite;
		stats.totalTokens += tokens.totalTokens;
	}
	return stats;
}

/**
 * One-line summary printed when the REPL exits: total turns, wall-clock agent
 * time, and billed tokens (cumulative `input + output` across every turn).
 * Returns `null` when no turn ran, so an empty session prints nothing.
 */
export function formatReplRunSummary(stats: ReplRunStats): string | null {
	if (stats.turnCount === 0) {
		return null;
	}
	const turns = `${stats.turnCount} ${stats.turnCount === 1 ? "turn" : "turns"}`;
	let line = `Session: ${turns} · ${formatElapsed(stats.elapsedMs)}`;
	const billed = stats.inputTokens + stats.outputTokens;
	if (billed > 0) {
		line = `${line} · ${formatCompactNumber(billed)} billed`;
	}
	return line;
}

/** The provider usage of a finished turn, or `null` when none was reported. */
export type TurnUsage = ModelUsage | null;

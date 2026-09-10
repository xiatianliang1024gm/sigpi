/**
 * UI-neutral turn-progress reducer for the browser client. This is a near
 * verbatim port of `applyTurnProgress` in `src/session/events.ts` (the same
 * reducer that drives the TUI): the SSE `message` frames carry `TurnProgressEvent`
 * objects, so a browser transcript sink that implements the same
 * `TurnTranscriptView` surface (`beginAssistantMessage` / `beginToolLine` /
 * `appendSystem`) gets identical behavior to the terminal.
 *
 * Kept dependency-free and DOM-free so the pure parts are unit-testable in Node
 * (see test/web-reducer.test.ts) while still loading directly in the browser as
 * an ES module.
 */

/** Compact number formatting, mirroring `src/format.ts`. */
export function formatCompactNumber(value) {
	if (!Number.isFinite(value)) {
		return "0";
	}
	if (Math.abs(value) < 1000) {
		return String(Math.round(value));
	}
	return new Intl.NumberFormat("en", {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(value);
}

/** Human-readable compaction notice highlighting the context-window change. */
export function formatCompactionMessage(event) {
	const { tokensBefore, tokensAfter } = event;
	if (tokensBefore > 0 || tokensAfter > 0) {
		return `Context compacted: context window ${formatCompactNumber(tokensBefore)} → ${formatCompactNumber(tokensAfter)} tokens.`;
	}
	return "Context compacted.";
}

/** True for the four events that end a turn. */
export function isTurnTerminalEvent(event) {
	return (
		event.type === "turn_finished" ||
		event.type === "turn_interrupted" ||
		event.type === "turn_failed" ||
		event.type === "turn_max_steps_reached"
	);
}

/**
 * Fold one `TurnProgressEvent` into a transcript `view`. Returns the current
 * in-flight assistant-message view (to thread across events within a turn) and
 * mutates `toolLines` (keyed by tool-call id) as tool lines resolve. Mirrors
 * `applyTurnProgress` in `src/session/events.ts`.
 */
export function applyTurnProgress(view, event, currentAssistant, toolLines) {
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
		if (currentAssistant) {
			currentAssistant.finalize();
		}
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

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

/**
 * Micro-compaction notice: how much tool output the *request* lost. Mirrors
 * `formatElisionMessage` in `src/session/events.ts`, including the reassurance
 * that the transcript is complete — elision is a view over the request, not a
 * deletion.
 */
export function formatElisionMessage(event) {
	const count = event.elidedToolResults;
	const results = `${count} tool result${count === 1 ? "" : "s"}`;
	const pronoun = count === 1 ? "Its" : "Their";
	const reclaimed =
		event.elidedTokens > 0
			? ` (${formatCompactNumber(event.elidedTokens)} tokens)`
			: "";
	const budget =
		event.budget > 0
			? ` to fit the ${formatCompactNumber(event.budget)}-token tool-result budget`
			: "";
	return (
		`Context elided: ${results}${reclaimed} left out of this request${budget}. ` +
		`${pronoun} full output stays in the session record.`
	);
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
 * The scope each in-flight assistant component was opened for, keyed by the
 * component handle the view handed back. Mirrors `assistantScopes` in
 * `src/session/events.ts`: a delta whose scope differs from the in-flight
 * component's finalizes it and opens a fresh one instead of appending, so a
 * child's streamed text can never land in the parent's answer (or the reverse).
 *
 * Keyed by marker `id`, not by marker identity: every SSE frame arrives as
 * freshly parsed JSON, so each tagged event carries a new object for one run.
 */
const assistantScopes = new WeakMap();

/**
 * Fold one `TurnProgressEvent` into a transcript `view`. Returns the current
 * in-flight assistant-message view (to thread across events within a turn) and
 * mutates `toolLines` (keyed by tool-call id) as tool lines resolve. Mirrors
 * `applyTurnProgress` in `src/session/events.ts`.
 *
 * The optional third argument of each view method is the line's scope: an
 * event carrying `subAgent` comes from a delegated sub-agent run, and the view
 * presents it as nested, labelled activity (see `transcript.js`). Child runs
 * never emit turn lifecycle events, so they can never end the parent's turn
 * here — `isTurnTerminalEvent` stays false for every tagged frame.
 */
export function applyTurnProgress(view, event, currentAssistant, toolLines) {
	const scope = { subAgent: event.subAgent };

	if (event.type === "model_delta") {
		const scopeKey = event.subAgent?.id ?? null;
		let current = currentAssistant;
		if (current && (assistantScopes.get(current) ?? null) !== scopeKey) {
			current.finalize();
			current = null;
		}
		const assistant = current ?? view.beginAssistantMessage(scope);
		assistantScopes.set(assistant, scopeKey);
		if (event.reasoningDelta) {
			assistant.appendReasoning(event.reasoningDelta);
		}
		if (event.contentDelta) {
			assistant.appendContent(event.contentDelta);
		}
		return assistant;
	}

	if (event.type === "interrupt_requested") {
		view.appendSystem(event.message ?? "Interrupt requested.", "info", scope);
		return currentAssistant;
	}

	if (event.type === "context_compacted") {
		view.appendSystem(formatCompactionMessage(event), "info", scope);
		return currentAssistant;
	}

	if (event.type === "context_elided") {
		view.appendSystem(formatElisionMessage(event), "info", scope);
		return currentAssistant;
	}

	if (event.type === "tool_execution_started" && event.toolName) {
		const id = event.toolCallId;
		if (id) {
			const handle = view.beginToolLine(
				id,
				event.message ?? event.toolName,
				scope,
			);
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
				view.appendSystem(event.result ?? "failed", "error", scope);
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
		// Skipped for a sub-agent step boundary: the child's own tool lines
		// resolve through their own finish events, while the parent's
		// `SubAgent` line is still running — failing it here would mark the
		// delegate call interrupted. Mirrors `applyTurnProgress` in
		// `src/session/events.ts`.
		if (!event.subAgent) {
			for (const handle of toolLines.values()) {
				handle.fail("interrupted");
			}
			toolLines.clear();
		}
		if (event.type === "turn_failed" && event.userMessage) {
			// Surface the failure as a transcript error line; without this the
			// web client showed no reaction at all when a turn failed.
			view.appendSystem(event.userMessage, "error");
		}
		if (event.type === "turn_interrupted") {
			view.appendSystem("Turn interrupted.", "info");
		}
		return null;
	}

	return currentAssistant;
}

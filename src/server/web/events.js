// SSE event handling and the live transport.

import { sessionBase } from "./api.js";
import { els, setConnection } from "./dom.js";
import { loadSessions, resetModelState } from "./sessions.js";
import { state } from "./state.js";
import { clearTurnNodes, view } from "./transcript.js";
import { applyTurnProgress, isTurnTerminalEvent } from "./reducer.js";

export function handleEvent(event) {
	if (event.type === "ready") {
		setTurnActive(Boolean(event.turnActive));
		return;
	}
	if (event.type === "turn_started") {
		// A (re)played turn_started begins a fresh in-flight turn: drop whatever
		// partial copy the transcript holds so a reconnect rebuilds in place.
		clearTurnNodes();
		state.currentAssistant = null;
		state.toolLines.clear();
		setTurnActive(true);
		return;
	}
	state.currentAssistant = applyTurnProgress(
		view,
		event,
		state.currentAssistant,
		state.toolLines,
	);
	if (isTurnTerminalEvent(event)) {
		// The turn is committed to history now; stop tracking its nodes so the
		// next turn's turn_started does not remove it.
		state.turnNodes = [];
		setTurnActive(false);
		void loadSessions();
	}
}

export function setTurnActive(active) {
	state.turnActive = active;
	document.body.classList.toggle("busy", active);
	updateSubmitButton();
}

/**
 * Fold the session/turn state into the single composer button: sending is
 * offered when idle, interrupting while a turn runs. The icon (up arrow vs.
 * stop square) and label track the same state.
 */
export function updateSubmitButton() {
	const ready = Boolean(state.sessionId);
	const canSend = ready && !state.turnActive;
	const canInterrupt = ready && state.turnActive;
	els.submit.disabled = !(canSend || canInterrupt);
	els.submit.classList.toggle("is-stop", state.turnActive);
	const label = state.turnActive ? "中断" : "发送";
	els.submit.title = label;
	els.submit.setAttribute("aria-label", label);
	// The model can only be switched while no turn is in flight.
	els.modelSelect.disabled = !ready || state.turnActive || state.models.length === 0;
}

// --- transport -------------------------------------------------------------

export function connect() {
	disconnect();
	if (!state.projectKey || !state.sessionId) return;
		// Resume strictly after the last applied frame. `seq` starts at the history
	// cursor, so the initial connect skips the frames history already rendered
	// and receives the in-flight turn from exactly where it left off.
	const source = new EventSource(`${sessionBase()}/events?after=${state.seq}`);
	state.source = source;
	setConnection("connecting…");
	source.addEventListener("message", (event) => {
		let parsed;
		try {
			parsed = JSON.parse(event.data);
		} catch {
			return;
		}
		const seq = Number(event.lastEventId);
		if (Number.isFinite(seq) && seq > state.seq) {
			state.seq = seq;
		}
		handleEvent(parsed);
	});
	source.addEventListener("open", () => setConnection("connected"));
	source.addEventListener("error", () => setConnection("reconnecting…"));
}

export function disconnect() {
	if (state.source) {
		state.source.close();
		state.source = null;
	}
	setTurnActive(false);
	resetModelState();
}

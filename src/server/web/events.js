// SSE event handling and the live transport.

import { sessionBase } from "./api.js";
import { loadContextUsage, setContextUsedTokens } from "./context.js";
import { els, setConnection } from "./dom.js";
import { applyTurnProgress, isTurnTerminalEvent } from "./reducer.js";
import { loadSessions, resetModelState } from "./sessions.js";
import { state } from "./state.js";
import { loadSessionStats, refreshSessionStats } from "./stats.js";
import { refreshTasks, resetTasks } from "./tasks.js";
import { clearTurnNodes, view } from "./transcript.js";

export function handleEvent(event) {
	// Every in-flight frame carries the runner's live request-token estimate;
	// fold it into the composer's context indicator so the count tracks the turn.
	setContextUsedTokens(event.estimatedContextTokens);
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
	if (event.type === "step_started") {
		// A step boundary means the previous step's messages are now persisted, so
		// the durable step count has advanced. Refresh the info line now instead
		// of waiting for the whole turn to finish.
		void refreshSessionStats();
		// A step may have launched a background task (the `bash` tool), so keep
		// the badge current mid-turn rather than only at the turn's end.
		void refreshTasks();
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
		// The turn's measured usage is on the runtime now; refetch so the
		// indicator shows ground truth rather than the in-flight estimate.
		void loadContextUsage();
		// The turn's stats are final now too; refresh the session info line.
		void loadSessionStats();
		// Background tasks the turn started (or finished) may have changed; the
		// turn boundary is the natural point to refresh the badge.
		void refreshTasks();
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
	els.modelSelect.disabled =
		!ready || state.turnActive || state.models.length === 0;
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
	resetTasks();
}

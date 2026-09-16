// Session info line for the topbar: cumulative turn/step/token totals plus the
// wall-clock timings the server measured while driving the session.
//
// The durable totals (turns, steps, tokens) are folded server-side from the
// persisted entry stream (`src/server/session-stats.ts`), so a resumed session
// shows its whole history; the timings cover the turns this server process
// observed. The client only formats and renders — it does no accumulation of
// its own, so the numbers never disagree with the server.

import { requestJson, sessionBase } from "./api.js";
import { els } from "./dom.js";
import {
	formatSessionInfo,
	normalizeSessionStats,
} from "./session-format.js";
import { state } from "./state.js";

/**
 * Fetch the active session's statistics and render the info line. Cleared first
 * so a session switch never shows the previous session's numbers while the
 * request is in flight; any failure (server without stats, offline) hides it.
 */
export async function loadSessionStats() {
	if (!state.sessionId) {
		resetSessionStats();
		return;
	}
	const sessionId = state.sessionId;
	const projectKey = state.projectKey;
	state.sessionStats = null;
	renderSessionInfo();
	try {
		const body = await requestJson(`${sessionBase()}/stats`);
		// Drop the result if the user switched sessions mid-flight.
		if (state.sessionId !== sessionId || state.projectKey !== projectKey) return;
		state.sessionStats = normalizeSessionStats(body);
	} catch {
		state.sessionStats = null;
	}
	renderSessionInfo();
}

/** Clear the info line when no session is active. */
export function resetSessionStats() {
	state.sessionStats = null;
	renderSessionInfo();
}

/** Render the formatted line from {@link state}, hiding it when there is none. */
export function renderSessionInfo() {
	const el = els.sessionInfo;
	if (!el) return;
	const text = formatSessionInfo(state.sessionStats);
	if (!text) {
		el.textContent = "";
		el.hidden = true;
		return;
	}
	el.textContent = text;
	el.hidden = false;
}

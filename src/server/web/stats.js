// Session info line for the composer: cumulative turn/step/token totals plus the
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

/** A refresh is in flight; further requests coalesce into one trailing fetch. */
let refreshInFlight = false;
/** A refresh was requested while one was in flight, so run one more at the end. */
let refreshQueued = false;

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
	state.sessionStats = null;
	renderSessionInfo();
	await fetchSessionStats(state.sessionId, state.projectKey);
}

/**
 * Refresh the info line mid-turn without blanking it first, so the per-step
 * update does not flicker the line away. Coalesced: while a fetch is in flight,
 * further requests collapse into a single trailing refresh, so a reconnect that
 * replays many `step_started` frames does not fan out into a burst of requests.
 */
export async function refreshSessionStats() {
	if (!state.sessionId) return;
	if (refreshInFlight) {
		refreshQueued = true;
		return;
	}
	refreshInFlight = true;
	try {
		do {
			refreshQueued = false;
			await fetchSessionStats(state.sessionId, state.projectKey);
		} while (refreshQueued);
	} finally {
		refreshInFlight = false;
	}
}

/**
 * Fetch and render the stats for one session. On success the payload is stored
 * and the line re-rendered; a failure (or a session switch mid-flight) leaves
 * the current value untouched.
 */
async function fetchSessionStats(sessionId, projectKey) {
	try {
		const body = await requestJson(`${sessionBase()}/stats`);
		// Drop the result if the user switched sessions mid-flight.
		if (state.sessionId !== sessionId || state.projectKey !== projectKey) return;
		state.sessionStats = normalizeSessionStats(body);
	} catch {
		return;
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

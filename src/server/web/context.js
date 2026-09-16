// Context-window usage indicator shown next to the model picker, mirroring the
// TUI status bar's `{used}/{limit} ({pct}%)` segment.

import { requestJson, sessionBase } from "./api.js";
import { els } from "./dom.js";
import { formatCompactNumber } from "./reducer.js";
import { state } from "./state.js";

/**
 * Fetch the active session's usable context window and used tokens, then
 * render the indicator. The display is cleared first so a session switch never
 * shows the previous session's numbers while the request is in flight. Any
 * failure (server without context reporting, offline) just hides the indicator.
 */
export async function loadContextUsage() {
	if (!state.sessionId) {
		resetContextUsage();
		return;
	}
	const sessionId = state.sessionId;
	const projectKey = state.projectKey;
	state.contextLimit = null;
	state.contextUsedTokens = null;
	renderContextUsage();
	try {
		const body = await requestJson(`${sessionBase()}/context`);
		// Drop the result if the user switched sessions mid-flight.
		if (state.sessionId !== sessionId || state.projectKey !== projectKey) return;
		state.contextLimit = Number.isFinite(body?.limit) ? body.limit : null;
		state.contextUsedTokens = Number.isFinite(body?.usedTokens)
			? body.usedTokens
			: null;
	} catch {
		state.contextLimit = null;
		state.contextUsedTokens = null;
	}
	renderContextUsage();
}

/**
 * Fold a live in-turn estimate (`estimatedContextTokens` on a progress event)
 * into the indicator so the count advances while the model streams.
 */
export function setContextUsedTokens(tokens) {
	if (!Number.isFinite(tokens)) return;
	state.contextUsedTokens = tokens;
	renderContextUsage();
}

/** Clear the indicator when no session is active. */
export function resetContextUsage() {
	state.contextLimit = null;
	state.contextUsedTokens = null;
	renderContextUsage();
}

/**
 * Render `used/limit (pct%)` from {@link state}, or the honest `?/limit` before
 * any usage is known. Hidden entirely when the window size is unknown.
 */
export function renderContextUsage() {
	const el = els.contextUsage;
	if (!el) return;
	const limit = state.contextLimit;
	if (!state.sessionId || !Number.isFinite(limit) || limit <= 0) {
		el.textContent = "";
		el.hidden = true;
		return;
	}
	const limitStr = formatCompactNumber(limit);
	if (state.contextUsedTokens === null) {
		el.textContent = `?/${limitStr}`;
		el.title = `上下文窗口 ${limit} tokens`;
	} else {
		const usedStr = formatCompactNumber(state.contextUsedTokens);
		const percent = Math.round((state.contextUsedTokens / limit) * 100);
		el.textContent = `${usedStr}/${limitStr} (${percent}%)`;
		el.title = `上下文窗口 ${limit} tokens，已用 ${state.contextUsedTokens} (${percent}%)`;
	}
	el.hidden = false;
}

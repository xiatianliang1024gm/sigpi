// Context-window usage indicator shown next to the model picker as a ring whose
// filled arc is the used fraction of the window (the TUI renders the equivalent
// `{used}/{limit} ({pct}%)` segment); the token figures live in its tooltip.

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
		if (state.sessionId !== sessionId || state.projectKey !== projectKey)
			return;
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

// The ring's radius is chosen so the circumference is exactly 100, letting the
// stroke dash-array be read as a percentage directly (2πr = 100 → r ≈ 15.915).
const RING_RADIUS = 15.915;
const RING_CIRCUMFERENCE = 100;
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Render the context-window usage as a ring: the filled arc is the used
 * fraction of the window and the label beside it is the rounded percentage.
 * The exact `used/limit` token figures live in the hover title. Hidden entirely
 * when the window size is unknown.
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
	const { value, label } = ensureRing(el);
	const limitStr = formatCompactNumber(limit);
	if (state.contextUsedTokens === null) {
		// Honest `?`: the window is known but nothing has been measured yet.
		setRingFraction(value, 0);
		label.textContent = "?";
		const title = `上下文窗口 ${limitStr} tokens`;
		el.title = title;
		el.setAttribute("aria-label", title);
		el.hidden = false;
		return;
	}
	const usedStr = formatCompactNumber(state.contextUsedTokens);
	const fraction = Math.max(0, Math.min(1, state.contextUsedTokens / limit));
	const percent = Math.round(fraction * 100);
	setRingFraction(value, fraction);
	label.textContent = `${percent}%`;
	const title = `上下文窗口 ${limitStr} tokens，已用 ${usedStr} (${percent}%)`;
	el.title = title;
	el.setAttribute("aria-label", title);
	el.hidden = false;
}

/**
 * Build (once) the SVG ring + percentage label inside the container and return
 * the parts that change per render. Reuses the existing nodes so repeated
 * renders do not rebuild the DOM.
 */
function ensureRing(el) {
	const existing = el.querySelector("svg.context-ring");
	if (existing) {
		return {
			value: existing.querySelector(".context-ring-value"),
			label: el.querySelector(".context-ring-label"),
		};
	}
	el.textContent = "";
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", "context-ring");
	svg.setAttribute("viewBox", "0 0 36 36");
	svg.setAttribute("width", "16");
	svg.setAttribute("height", "16");
	svg.setAttribute("aria-hidden", "true");

	const track = document.createElementNS(SVG_NS, "circle");
	track.setAttribute("class", "context-ring-track");
	track.setAttribute("cx", "18");
	track.setAttribute("cy", "18");
	track.setAttribute("r", String(RING_RADIUS));
	track.setAttribute("fill", "none");

	const value = document.createElementNS(SVG_NS, "circle");
	value.setAttribute("class", "context-ring-value");
	value.setAttribute("cx", "18");
	value.setAttribute("cy", "18");
	value.setAttribute("r", String(RING_RADIUS));
	value.setAttribute("fill", "none");
	value.setAttribute(
		"stroke-dasharray",
		`${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`,
	);
	setRingFraction(value, 0);

	svg.append(track, value);
	const label = document.createElement("span");
	label.setAttribute("class", "context-ring-label");
	el.append(svg, label);
	return { value, label };
}

/** Point the value arc at `fraction` (0..1) of the ring. */
function setRingFraction(value, fraction) {
	if (!value) return;
	const offset = RING_CIRCUMFERENCE * (1 - fraction);
	value.setAttribute("stroke-dashoffset", String(offset));
}

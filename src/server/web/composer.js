// Composer: sending turns, interrupting, drafts.

import { sessionBase } from "./api.js";
import { els, showError } from "./dom.js";
import { setTurnActive } from "./events.js";
import { truncateTitle } from "./format.js";
import { state } from "./state.js";
import { addUserMessage } from "./transcript.js";
import { renderProjects } from "./tree.js";

export async function sendMessage(text) {
	if (!state.sessionId || state.turnActive) return;
	addUserMessage(text);
	setTurnActive(true);
	// The server titles untitled sessions from their first user message; mirror
	// that locally so the sidebar updates immediately instead of waiting for the
	// turn to finish.
	const bucket = state.sessionsByProject.get(state.projectKey);
	const summary = bucket?.stored.find((s) => s.sessionId === state.sessionId);
	if (summary && !summary.title) {
		summary.title = truncateTitle(text);
		renderProjects();
	}
	try {
		const response = await fetch(`${sessionBase()}/message`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: text }),
		});
		if (response.status === 409) {
			showError("A turn is already running.");
			setTurnActive(false);
			return;
		}
		if (!response.ok) {
			showError(`Failed to send (HTTP ${response.status}).`);
			setTurnActive(false);
		}
	} catch (error) {
		showError(error.message);
		setTurnActive(false);
	}
}

export async function interrupt() {
	if (!state.sessionId) return;
	try {
		await fetch(`${sessionBase()}/interrupt`, { method: "POST" });
	} catch (error) {
		showError(error.message);
	}
}

// --- composer drafts -------------------------------------------------------

/**
 * The composer's unsubmitted text is remembered per session. Switching away
 * saves the box against the session it belongs to and switching back restores
 * it, so a half-typed prompt neither leaks into another session nor is lost.
 */

/** The draft key for a session, or null when no session is active. */
export function draftKey(projectKey, sessionId) {
	if (!projectKey || !sessionId) return null;
	return `${projectKey}\u0000${sessionId}`;
}

/** Persist the composer box against the active session (if any). */
export function saveDraft() {
	const key = draftKey(state.projectKey, state.sessionId);
	if (!key) return;
	const text = els.input.value;
	if (text) state.drafts.set(key, text);
	else state.drafts.delete(key);
}

/** Repopulate the composer box from the active session's saved draft. */
export function restoreDraft() {
	const key = draftKey(state.projectKey, state.sessionId);
	els.input.value = (key && state.drafts.get(key)) || "";
}

export function submitComposer() {
	if (!state.sessionId || state.turnActive) return;
	const text = els.input.value.trim();
	if (!text) return;
	els.input.value = "";
	saveDraft();
	void sendMessage(text);
}

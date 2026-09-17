// Session lifecycle and per-session model picker.

import { postJson, requestJson, sessionBase } from "./api.js";
import { restoreDraft, saveDraft } from "./composer.js";
import { loadContextUsage, resetContextUsage } from "./context.js";
import { els, showError } from "./dom.js";
import { connect, disconnect, updateSubmitButton } from "./events.js";
import { loadProjects } from "./projects.js";
import { state } from "./state.js";
import { loadSessionStats, resetSessionStats } from "./stats.js";
import { refreshTasks } from "./tasks.js";
import { clearTranscript, loadHistory } from "./transcript.js";
import { renderProjects } from "./tree.js";

/** Refresh the session list for every project (the tree shows them all). */
export async function loadSessions() {
	const results = await Promise.all(
		state.projects.map(async (project) => {
			try {
				const body = await requestJson(
					`/projects/${encodeURIComponent(project.key)}/sessions`,
				);
				return [
					project.key,
					{ stored: body?.stored ?? [], live: body?.live ?? [] },
				];
			} catch {
				return [project.key, { stored: [], live: [] }];
			}
		}),
	);
	state.sessionsByProject = new Map(results);
	renderProjects();
}

export async function createSession(projectKey) {
	const created = await postJson(
		`/projects/${encodeURIComponent(projectKey)}/sessions`,
		{},
	);
	await loadSessions();
	await selectSession(projectKey, created.sessionId, { resume: false });
}

/** Rename a workspace's display name (blank clears it back to the folder). */
export async function renameProject(projectKey, name) {
	await requestJson(`/projects/${encodeURIComponent(projectKey)}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name }),
	});
	await loadProjects();
}

/** Rename one session's display title. */
export async function renameSession(projectKey, sessionId, title) {
	await requestJson(
		`/projects/${encodeURIComponent(projectKey)}/sessions/${encodeURIComponent(sessionId)}`,
		{
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title }),
		},
	);
	await loadSessions();
}

/**
 * Archive a session: its messages stay on disk but it is hidden from the tree.
 * If it was the active session, clear the transcript and stop streaming.
 */
export async function archiveSession(projectKey, sessionId) {
	await requestJson(
		`/projects/${encodeURIComponent(projectKey)}/sessions/${encodeURIComponent(sessionId)}`,
		{
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ archived: true }),
		},
	);
	if (state.projectKey === projectKey && state.sessionId === sessionId) {
		saveDraft();
		state.sessionId = null;
		disconnect();
		clearTranscript();
		restoreDraft();
	}
	await loadSessions();
}

export async function selectSession(projectKey, sessionId, { resume }) {
	saveDraft();
	state.projectKey = projectKey;
	state.collapsed.delete(projectKey);
	if (resume) {
		await postJson(`/projects/${encodeURIComponent(projectKey)}/sessions`, {
			sessionId,
		});
		await loadSessions();
	}
	state.sessionId = sessionId;
	clearTranscript();
	restoreDraft();
	renderProjects();
	// Load persisted history *before* opening the event stream. The stream
	// replays any in-flight turn from its start, so awaiting history keeps the
	// rebuilt turn below its user message instead of racing the fetch and
	// rendering out of order.
	await loadHistory();
	// Abandon the connect when the user switched again while history loaded.
	if (state.sessionId !== sessionId || state.projectKey !== projectKey) return;
	connect();
	els.input.disabled = false;
	els.input.focus();
	void loadModelState();
	void loadContextUsage();
	void loadSessionStats();
	void refreshTasks();
}

/** Delete one session and its stored messages; stop it first if it is live. */
export async function deleteSession(projectKey, sessionId) {
	await requestJson(
		`/projects/${encodeURIComponent(projectKey)}/sessions/${encodeURIComponent(sessionId)}`,
		{ method: "DELETE" },
	);
	if (state.projectKey === projectKey && state.sessionId === sessionId) {
		saveDraft();
		state.sessionId = null;
		disconnect();
		clearTranscript();
		restoreDraft();
	}
	await loadSessions();
}

// --- models ----------------------------------------------------------------

/**
 * Fetch the active session's configured models and its current model id, then
 * render the picker. A server that does not expose model control (or any error)
 * simply hides the dropdown rather than surfacing noise.
 */
export async function loadModelState() {
	if (!state.sessionId) {
		resetModelState();
		return;
	}
	const sessionId = state.sessionId;
	const projectKey = state.projectKey;
	try {
		const body = await requestJson(`${sessionBase()}/model`);
		// Drop the result if the user switched sessions mid-flight.
		if (state.sessionId !== sessionId || state.projectKey !== projectKey)
			return;
		state.models = Array.isArray(body?.models) ? body.models : [];
		state.modelId = typeof body?.current === "string" ? body.current : null;
	} catch {
		state.models = [];
		state.modelId = null;
	}
	renderModelSelect();
	updateSubmitButton();
}

/** Clear the picker when no session is active. */
export function resetModelState() {
	state.models = [];
	state.modelId = null;
	renderModelSelect();
	updateSubmitButton();
	resetContextUsage();
	resetSessionStats();
}

/** Rebuild the model dropdown's options from the current model list. */
export function renderModelSelect() {
	els.modelSelect.textContent = "";
	if (state.models.length === 0) {
		const option = document.createElement("option");
		option.value = "";
		option.textContent = "无可用模型";
		els.modelSelect.append(option);
		return;
	}
	for (const model of state.models) {
		const option = document.createElement("option");
		option.value = model.id;
		option.textContent = model.name || model.id;
		option.title = model.id;
		els.modelSelect.append(option);
	}
	if (state.modelId) {
		els.modelSelect.value = state.modelId;
	}
}

/** Switch the active session's model via the server. */
export async function switchModel(modelId) {
	if (!state.sessionId || !modelId || modelId === state.modelId) return;
	try {
		const body = await postJson(`${sessionBase()}/model`, { modelId });
		state.modelId = typeof body?.current === "string" ? body.current : modelId;
	} catch (error) {
		showError(error.message);
	}
	renderModelSelect();
	// The usable context window is per-model, so refresh the indicator too.
	void loadContextUsage();
}

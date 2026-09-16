// Workspace (project) actions.

import { postJson, requestJson } from "./api.js";
import { restoreDraft, saveDraft } from "./composer.js";
import { els } from "./dom.js";
import { disconnect } from "./events.js";
import { loadSessions } from "./sessions.js";
import { state } from "./state.js";
import { clearTranscript } from "./transcript.js";
import { renderProjects } from "./tree.js";

export async function loadProjects() {
	const body = await requestJson("/projects");
	state.projects = body?.projects ?? [];
	// Drop the active session if its project vanished (e.g. deleted elsewhere).
	if (
		state.projectKey &&
		!state.projects.some((p) => p.key === state.projectKey)
	) {
		resetActive();
	}
	renderProjects();
	await loadSessions();
}

export async function addProject(path) {
	const created = await postJson("/projects", { path });
	await loadProjects();
	if (created?.key) {
		await selectProject(created.key);
	}
}

/**
 * Ask the server to open its native folder chooser, then register whatever the
 * user picked. The chooser runs on the server because the browser cannot expose
 * a real absolute path; `null` means the user cancelled.
 */
export async function pickAndAddProject() {
	if (els.addProject.disabled) return;
	els.addProject.disabled = true;
	try {
		const picked = await postJson("/projects/pick");
		if (!picked?.path) return;
		await addProject(picked.path);
	} finally {
		els.addProject.disabled = false;
	}
}

export function toggleProject(key) {
	if (state.collapsed.has(key)) {
		state.collapsed.delete(key);
	} else {
		state.collapsed.add(key);
	}
	renderProjects();
}

/** Collapse every workspace's session list at once. */
export function collapseAllProjects() {
	for (const project of state.projects) state.collapsed.add(project.key);
	renderProjects();
}

/** Expand every workspace's session list at once. */
export function expandAllProjects() {
	state.collapsed.clear();
	renderProjects();
}

export async function selectProject(key) {
	saveDraft();
	state.projectKey = key;
	state.sessionId = null;
	state.collapsed.delete(key);
	disconnect();
	clearTranscript();
	restoreDraft();
	renderProjects();
	await loadSessions();
}

/** Delete a project and all of its sessions (and their stored messages). */
export async function deleteProject(key) {
	await requestJson(`/projects/${encodeURIComponent(key)}`, {
		method: "DELETE",
	});
	state.collapsed.delete(key);
	state.sessionsByProject.delete(key);
	if (state.projectKey === key) {
		resetActive();
	}
	await loadProjects();
}

/** Clear the active project/session and stop streaming its events. */
export function resetActive() {
	saveDraft();
	state.projectKey = null;
	state.sessionId = null;
	disconnect();
	clearTranscript();
	restoreDraft();
}

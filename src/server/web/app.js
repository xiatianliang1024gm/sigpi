/**
 * Browser client for the multi-session `sigpi serve` frontend. It speaks the
 * same wire protocol as the TUI: `GET /events` is an SSE stream of
 * `TurnProgressEvent` frames, and the transcript is folded by the shared
 * reducer (`./reducer.js`, a verbatim port of `applyTurnProgress`). Everything
 * else — listing/adding projects, listing/creating/resuming sessions, submitting
 * a turn, interrupting — is a thin `fetch` wrapper over the HTTP routes in
 * `src/server/multi.ts`.
 *
 * No build step: this loads directly as an ES module. All asset requests are
 * same-origin (the server hosts this page), so there is no CORS surface.
 */
import { applyTurnProgress, isTurnTerminalEvent } from "./reducer.js";

const els = {
	status: document.getElementById("status"),
	projects: document.getElementById("projects"),
	addProject: document.getElementById("add-project"),
	sessions: document.getElementById("sessions"),
	newSession: document.getElementById("new-session"),
	transcript: document.getElementById("transcript"),
	loadEarlier: document.getElementById("load-earlier"),
	composer: document.getElementById("composer"),
	input: document.getElementById("input"),
	send: document.getElementById("send"),
	interrupt: document.getElementById("interrupt"),
	error: document.getElementById("error"),
};

const state = {
	projects: [],
	projectKey: null,
	sessions: { stored: [], live: [] },
	sessionId: null,
	source: null,
	turnActive: false,
	currentAssistant: null,
	toolLines: new Map(),
	/** Exclusive end index for the next older history page; null when none. */
	historyCursor: null,
	historyLoading: false,
};

/** Entries fetched per history page when resuming a session. */
const HISTORY_PAGE_SIZE = 30;

// --- transcript view -------------------------------------------------------

/** The DOM-backed {@link TurnTranscriptView} the shared reducer writes to. */
const view = {
	beginAssistantMessage() {
		const root = document.createElement("div");
		root.className = "msg assistant";
		const reasoning = document.createElement("div");
		reasoning.className = "reasoning";
		reasoning.hidden = true;
		const content = document.createElement("div");
		content.className = "content";
		root.append(reasoning, content);
		els.transcript.append(root);
		scrollToEnd();
		let done = false;
		return {
			appendReasoning(text) {
				if (done) return;
				reasoning.hidden = false;
				reasoning.textContent += text;
				scrollToEnd();
			},
			appendContent(text) {
				if (done) return;
				content.textContent += text;
				scrollToEnd();
			},
			finalize() {
				done = true;
				if (!reasoning.textContent) reasoning.remove();
				scrollToEnd();
			},
		};
	},
	beginToolLine(id, label) {
		const line = document.createElement("div");
		line.className = "tool running";
		const labelEl = document.createElement("span");
		labelEl.className = "tool-label";
		labelEl.textContent = `⚙ ${label}`;
		line.append(labelEl);
		els.transcript.append(line);
		scrollToEnd();
		return {
			finish() {
				line.classList.remove("running");
				line.classList.add("ok");
				labelEl.textContent = `✓ ${label}`;
				scrollToEnd();
			},
			fail(error) {
				line.classList.remove("running");
				line.classList.add("failed");
				labelEl.textContent = `✗ ${label}`;
				if (error) {
					const detail = document.createElement("span");
					detail.textContent = ` ${error}`;
					line.append(detail);
				}
				scrollToEnd();
			},
		};
	},
	appendSystem(text, tone) {
		const line = document.createElement("div");
		line.className = tone ? `system ${tone}` : "system";
		line.textContent = text;
		els.transcript.append(line);
		scrollToEnd();
	},
};

function scrollToEnd() {
	els.transcript.scrollTop = els.transcript.scrollHeight;
}

function clearTranscript() {
	state.currentAssistant = null;
	state.toolLines.clear();
	els.transcript.textContent = "";
	resetHistory();
}

function addUserMessage(text) {
	const el = document.createElement("div");
	el.className = "msg user";
	el.textContent = text;
	els.transcript.append(el);
	scrollToEnd();
}

// --- history ---------------------------------------------------------------

/** Build the DOM node for one server-projected history item. */
function historyItemToElement(item) {
	if (item.kind === "user") {
		const el = document.createElement("div");
		el.className = "msg user";
		el.textContent = item.text;
		return el;
	}
	if (item.kind === "assistant") {
		const root = document.createElement("div");
		root.className = "msg assistant";
		if (item.reasoning) {
			const reasoning = document.createElement("div");
			reasoning.className = "reasoning";
			reasoning.textContent = item.reasoning;
			root.append(reasoning);
		}
		const content = document.createElement("div");
		content.className = "content";
		content.textContent = item.text;
		root.append(content);
		return root;
	}
	if (item.kind === "tool") {
		const line = document.createElement("div");
		line.className = "tool ok";
		const label = document.createElement("span");
		label.className = "tool-label";
		label.textContent = `✓ ${item.name}`;
		line.append(label);
		return line;
	}
	const line = document.createElement("div");
	line.className = "system info";
	line.textContent = item.text;
	return line;
}

/** Render a history page, either newest-page (append) or older (prepend). */
function renderHistory(items, { prepend }) {
	const fragment = document.createDocumentFragment();
	for (const item of items) {
		fragment.append(historyItemToElement(item));
	}
	if (!prepend) {
		els.transcript.append(fragment);
		scrollToEnd();
		return;
	}
	// Prepending older content grows the scroll height above the viewport;
	// shift scrollTop by the delta so the reader's position stays put.
	const previousHeight = els.transcript.scrollHeight;
	els.transcript.insertBefore(fragment, els.transcript.firstChild);
	els.transcript.scrollTop += els.transcript.scrollHeight - previousHeight;
}

function resetHistory() {
	state.historyCursor = null;
	state.historyLoading = false;
	updateLoadEarlier();
}

function updateLoadEarlier() {
	els.loadEarlier.hidden = !state.sessionId || state.historyCursor === null;
	els.loadEarlier.disabled = state.historyLoading;
}

/**
 * Load a page of persisted history for the active session. The newest page is
 * fetched on session select; `older` walks backwards using the server cursor.
 */
async function loadHistory({ older = false } = {}) {
	if (!state.projectKey || !state.sessionId) return;
	if (state.historyLoading) return;
	if (older && state.historyCursor === null) return;
	const sessionId = state.sessionId;
	const projectKey = state.projectKey;
	state.historyLoading = true;
	updateLoadEarlier();
	try {
		const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
		if (older && state.historyCursor !== null) {
			params.set("before", String(state.historyCursor));
		}
		const page = await requestJson(`${sessionBase()}/messages?${params}`);
		// Drop the result if the user switched sessions mid-flight.
		if (state.sessionId !== sessionId || state.projectKey !== projectKey) return;
		state.historyCursor = page?.cursor ?? null;
		renderHistory(page?.items ?? [], { prepend: older });
	} catch (error) {
		showError(error.message);
	} finally {
		state.historyLoading = false;
		updateLoadEarlier();
	}
}

// --- event handling --------------------------------------------------------

function handleEvent(event) {
	if (event.type === "ready") {
		setTurnActive(Boolean(event.turnActive));
		return;
	}
	if (event.type === "turn_started") {
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
		setTurnActive(false);
		void loadSessions();
	}
}

function setTurnActive(active) {
	state.turnActive = active;
	els.send.disabled = active;
	els.interrupt.disabled = !active;
	document.body.classList.toggle("busy", active);
}

function setConnection(text) {
	els.status.textContent = text;
}

// --- HTTP ------------------------------------------------------------------

async function requestJson(path, options) {
	const response = await fetch(path, options);
	const text = await response.text();
	let body = null;
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = null;
		}
	}
	if (!response.ok) {
		const message = body?.error ?? `HTTP ${response.status}`;
		throw new Error(message);
	}
	return body;
}

function postJson(path, body) {
	return requestJson(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
}

const sessionBase = () =>
	`/projects/${encodeURIComponent(state.projectKey)}/sessions/${encodeURIComponent(state.sessionId)}`;

// --- projects --------------------------------------------------------------

async function loadProjects() {
	const body = await requestJson("/projects");
	state.projects = body?.projects ?? [];
	if (!state.projectKey && state.projects.length > 0) {
		state.projectKey = state.projects[0].key;
	}
	if (
		state.projectKey &&
		!state.projects.some((p) => p.key === state.projectKey)
	) {
		state.projectKey = null;
	}
	renderProjects();
	await loadSessions();
}

function renderProjects() {
	els.projects.textContent = "";
	for (const project of state.projects) {
		const el = document.createElement("button");
		el.type = "button";
		el.className =
			project.key === state.projectKey ? "list-item active" : "list-item";
		el.textContent = project.cwd;
		el.title = project.cwd;
		el.addEventListener("click", () => void selectProject(project.key));
		els.projects.append(el);
	}
	els.newSession.disabled = !state.projectKey;
}

async function addProject(path) {
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
async function pickAndAddProject() {
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

async function selectProject(key) {
	state.projectKey = key;
	state.sessionId = null;
	disconnect();
	clearTranscript();
	renderProjects();
	await loadSessions();
}

// --- sessions --------------------------------------------------------------

async function loadSessions() {
	if (!state.projectKey) {
		state.sessions = { stored: [], live: [] };
		renderSessions();
		return;
	}
	const body = await requestJson(
		`/projects/${encodeURIComponent(state.projectKey)}/sessions`,
	);
	state.sessions = { stored: body?.stored ?? [], live: body?.live ?? [] };
	renderSessions();
}

function renderSessions() {
	els.sessions.textContent = "";
	const liveIds = new Set(state.sessions.live.map((s) => s.sessionId));

	for (const session of state.sessions.live) {
		const el = document.createElement("button");
		el.type = "button";
		el.className =
			session.sessionId === state.sessionId ? "list-item active" : "list-item";
		el.textContent = `${session.turnActive ? "● " : ""}${shortId(session.sessionId)} · live`;
		el.title = session.sessionId;
		el.addEventListener("click", () =>
			void selectSession(session.sessionId, { resume: false }),
		);
		els.sessions.append(el);
	}

	for (const session of state.sessions.stored) {
		if (liveIds.has(session.sessionId)) continue;
		const el = document.createElement("button");
		el.type = "button";
		el.className = "list-item";
		const label =
			session.title || session.lastCompletedUserInput || "(empty session)";
		el.textContent = `${label} · ${session.turnCount} turns`;
		el.title = session.sessionId;
		el.addEventListener("click", () =>
			void selectSession(session.sessionId, { resume: true }),
		);
		els.sessions.append(el);
	}
}

async function createSession() {
	if (!state.projectKey) return;
	const created = await postJson(
		`/projects/${encodeURIComponent(state.projectKey)}/sessions`,
		{},
	);
	await loadSessions();
	await selectSession(created.sessionId, { resume: false });
}

async function selectSession(sessionId, { resume }) {
	if (resume) {
		await postJson(`/projects/${encodeURIComponent(state.projectKey)}/sessions`, {
			sessionId,
		});
		await loadSessions();
	}
	state.sessionId = sessionId;
	clearTranscript();
	renderSessions();
	connect();
	els.input.disabled = false;
	els.input.focus();
	void loadHistory();
}

// --- transport -------------------------------------------------------------

function connect() {
	disconnect();
	if (!state.projectKey || !state.sessionId) return;
	const source = new EventSource(`${sessionBase()}/events`);
	state.source = source;
	setConnection("connecting…");
	source.addEventListener("message", (event) => {
		let parsed;
		try {
			parsed = JSON.parse(event.data);
		} catch {
			return;
		}
		handleEvent(parsed);
	});
	source.addEventListener("open", () => setConnection("connected"));
	source.addEventListener("error", () => setConnection("reconnecting…"));
}

function disconnect() {
	if (state.source) {
		state.source.close();
		state.source = null;
	}
	setTurnActive(false);
}

// --- actions ---------------------------------------------------------------

async function sendMessage(text) {
	if (!state.sessionId || state.turnActive) return;
	addUserMessage(text);
	setTurnActive(true);
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

async function interrupt() {
	if (!state.sessionId) return;
	try {
		await fetch(`${sessionBase()}/interrupt`, { method: "POST" });
	} catch (error) {
		showError(error.message);
	}
}

function showError(message) {
	els.error.textContent = message;
	els.error.hidden = false;
	clearTimeout(showError.timer);
	showError.timer = setTimeout(() => {
		els.error.hidden = true;
	}, 6000);
}

function shortId(id) {
	return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/** Turn a picker failure into something a person can act on. */
function projectErrorMessage(error) {
	if (error?.message === "picker_unavailable") {
		return "The server has no folder chooser available.";
	}
	return error?.message ?? "Failed to add the project.";
}

// --- wiring ----------------------------------------------------------------

els.addProject.addEventListener("click", () => {
	pickAndAddProject().catch((error) => showError(projectErrorMessage(error)));
});

els.newSession.addEventListener("click", () => {
	createSession().catch((error) => showError(error.message));
});

els.loadEarlier.addEventListener("click", () => {
	void loadHistory({ older: true });
});

// Auto-load the next older page when the reader reaches the top of the scroll.
els.transcript.addEventListener("scroll", () => {
	if (els.transcript.scrollTop > 64) return;
	if (state.historyCursor === null || state.historyLoading) return;
	void loadHistory({ older: true });
});

function submitComposer() {
	if (!state.sessionId || state.turnActive) return;
	const text = els.input.value.trim();
	if (!text) return;
	els.input.value = "";
	void sendMessage(text);
}

els.composer.addEventListener("submit", (event) => {
	event.preventDefault();
	submitComposer();
});

// Enter sends; Shift+Enter keeps its newline so multi-line prompts still work.
// IME composition (candidate selection) must not submit mid-word.
els.input.addEventListener("keydown", (event) => {
	if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
	event.preventDefault();
	submitComposer();
});

els.interrupt.addEventListener("click", () => {
	void interrupt();
});

loadProjects().catch((error) => showError(error.message));

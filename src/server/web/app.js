/**
 * Browser client for the multi-session `sigpi serve` frontend. It speaks the
 * same wire protocol as the TUI: `GET /events` is an SSE stream of
 * `TurnProgressEvent` frames, and the transcript is folded by the shared
 * reducer (`./reducer.js`, a verbatim port of `applyTurnProgress`). Everything
 * else — a collapsible workspace → session tree (list/add/rename/delete
 * workspaces; list/create/resume/rename/archive sessions) driven by per-row
 * "⋯" menus, plus submitting a turn and interrupting — is a thin `fetch`
 * wrapper over the HTTP routes in `src/server/multi.ts`.
 *
 * No build step: this loads directly as an ES module. All asset requests are
 * same-origin (the server hosts this page), so there is no CORS surface.
 */
import { renderMarkdown } from "./markdown.js";
import { applyTurnProgress, isTurnTerminalEvent } from "./reducer.js";

const els = {
	status: document.getElementById("status"),
	projects: document.getElementById("projects"),
	addProject: document.getElementById("add-project"),
	layout: document.querySelector(".layout"),
	resizer: document.getElementById("resizer"),
	transcript: document.getElementById("transcript"),
	loadEarlier: document.getElementById("load-earlier"),
	composer: document.getElementById("composer"),
	input: document.getElementById("input"),
	submit: document.getElementById("submit"),
	modelSelect: document.getElementById("model-select"),
	error: document.getElementById("error"),
};

const state = {
	projects: [],
	/** projectKey → { stored: SessionSummary[], live: LiveSession[] }. */
	sessionsByProject: new Map(),
	/** Project keys whose session list is collapsed in the tree. */
	collapsed: new Set(),
	/** Active project directory key (the session below belongs to it). */
	projectKey: null,
	sessionId: null,
	source: null,
	turnActive: false,
	/** Configured models for the active session: `{ id, name }`. */
	models: [],
	/** The active session's current model id, or null when unknown. */
	modelId: null,
	currentAssistant: null,
	toolLines: new Map(),
	/** Exclusive end index for the next older history page; null when none. */
	historyCursor: null,
	historyLoading: false,
};

/** Entries fetched per history page when resuming a session. */
const HISTORY_PAGE_SIZE = 30;

// --- transcript view -------------------------------------------------------

/**
 * Build the shared skeleton for an assistant message: a collapsible reasoning
 * panel above the rendered markdown content. The reasoning panel is a native
 * `<details>` so expand/collapse and keyboard access come for free; it starts
 * hidden and stays collapsed — a single summary line — until the model emits
 * reasoning.
 */
function createAssistantMessage() {
	const root = document.createElement("div");
	root.className = "msg assistant";

	const reasoning = document.createElement("details");
	reasoning.className = "reasoning";
	reasoning.hidden = true;
	const summary = document.createElement("summary");
	summary.className = "reasoning-summary";
	const label = document.createElement("span");
	label.className = "reasoning-label";
	label.textContent = "💭 思考";
	const preview = document.createElement("span");
	preview.className = "reasoning-preview";
	summary.append(label, preview);
	const body = document.createElement("div");
	body.className = "reasoning-body";
	reasoning.append(summary, body);

	const content = document.createElement("div");
	content.className = "content";

	root.append(reasoning, content);
	return { root, reasoning, preview, body, content };
}

/** The one-line preview shown in a collapsed reasoning summary. */
function reasoningPreviewText(text) {
	const line = text.split(/\r?\n/).find((candidate) => candidate.trim());
	return line ? line.trim() : "…";
}

/** Replace a `.content` node's children with freshly rendered markdown. */
function renderContent(element, text) {
	element.replaceChildren(renderMarkdown(text));
}

/** The DOM-backed {@link TurnTranscriptView} the shared reducer writes to. */
const view = {
	beginAssistantMessage() {
		const { root, reasoning, preview, body, content } =
			createAssistantMessage();
		els.transcript.append(root);
		scrollToEnd();
		let reasoningText = "";
		let contentText = "";
		let done = false;
		return {
			appendReasoning(text) {
				if (done) return;
				reasoning.hidden = false;
				reasoningText += text;
				body.textContent = reasoningText;
				preview.textContent = reasoningPreviewText(reasoningText);
				scrollToEnd();
			},
			appendContent(text) {
				if (done) return;
				contentText += text;
				renderContent(content, contentText);
				scrollToEnd();
			},
			finalize() {
				done = true;
				if (!reasoningText) reasoning.remove();
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
		const { root, reasoning, preview, body, content } = createAssistantMessage();
		if (item.reasoning) {
			reasoning.hidden = false;
			body.textContent = item.reasoning;
			preview.textContent = reasoningPreviewText(item.reasoning);
		}
		renderContent(content, item.text ?? "");
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
	document.body.classList.toggle("busy", active);
	updateSubmitButton();
}

/**
 * Fold the session/turn state into the single composer button: sending is
 * offered when idle, interrupting while a turn runs. The icon (up arrow vs.
 * stop square) and label track the same state.
 */
function updateSubmitButton() {
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

function toggleProject(key) {
	if (state.collapsed.has(key)) {
		state.collapsed.delete(key);
	} else {
		state.collapsed.add(key);
	}
	renderProjects();
}

async function selectProject(key) {
	state.projectKey = key;
	state.sessionId = null;
	state.collapsed.delete(key);
	disconnect();
	clearTranscript();
	renderProjects();
	await loadSessions();
}

/** Delete a project and all of its sessions (and their stored messages). */
async function deleteProject(key) {
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
function resetActive() {
	state.projectKey = null;
	state.sessionId = null;
	disconnect();
	clearTranscript();
}

// --- sessions --------------------------------------------------------------

/** Refresh the session list for every project (the tree shows them all). */
async function loadSessions() {
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

async function createSession(projectKey) {
	const created = await postJson(
		`/projects/${encodeURIComponent(projectKey)}/sessions`,
		{},
	);
	await loadSessions();
	await selectSession(projectKey, created.sessionId, { resume: false });
}

/** Rename a workspace's display name (blank clears it back to the folder). */
async function renameProject(projectKey, name) {
	await requestJson(`/projects/${encodeURIComponent(projectKey)}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name }),
	});
	await loadProjects();
}

/** Rename one session's display title. */
async function renameSession(projectKey, sessionId, title) {
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
async function archiveSession(projectKey, sessionId) {
	await requestJson(
		`/projects/${encodeURIComponent(projectKey)}/sessions/${encodeURIComponent(sessionId)}`,
		{
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ archived: true }),
		},
	);
	if (state.projectKey === projectKey && state.sessionId === sessionId) {
		state.sessionId = null;
		disconnect();
		clearTranscript();
	}
	await loadSessions();
}

async function selectSession(projectKey, sessionId, { resume }) {
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
	renderProjects();
	connect();
	els.input.disabled = false;
	els.input.focus();
	void loadModelState();
	void loadHistory();
}

/** Delete one session and its stored messages; stop it first if it is live. */
async function deleteSession(projectKey, sessionId) {
	await requestJson(
		`/projects/${encodeURIComponent(projectKey)}/sessions/${encodeURIComponent(sessionId)}`,
		{ method: "DELETE" },
	);
	if (state.projectKey === projectKey && state.sessionId === sessionId) {
		state.sessionId = null;
		disconnect();
		clearTranscript();
	}
	await loadSessions();
}

// --- models ----------------------------------------------------------------

/**
 * Fetch the active session's configured models and its current model id, then
 * render the picker. A server that does not expose model control (or any error)
 * simply hides the dropdown rather than surfacing noise.
 */
async function loadModelState() {
	if (!state.sessionId) {
		resetModelState();
		return;
	}
	const sessionId = state.sessionId;
	const projectKey = state.projectKey;
	try {
		const body = await requestJson(`${sessionBase()}/model`);
		// Drop the result if the user switched sessions mid-flight.
		if (state.sessionId !== sessionId || state.projectKey !== projectKey) return;
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
function resetModelState() {
	state.models = [];
	state.modelId = null;
	renderModelSelect();
	updateSubmitButton();
}

/** Rebuild the model dropdown's options from the current model list. */
function renderModelSelect() {
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
async function switchModel(modelId) {
	if (!state.sessionId || !modelId || modelId === state.modelId) return;
	try {
		const body = await postJson(`${sessionBase()}/model`, { modelId });
		state.modelId = typeof body?.current === "string" ? body.current : modelId;
	} catch (error) {
		showError(error.message);
	}
	renderModelSelect();
}

// --- draggable workspace divider -------------------------------------------

/** Bounds (px) the workspace column may be dragged between. */
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 640;
/** Minimum width (px) always left for the conversation column. */
const CHAT_MIN_WIDTH = 240;
const SIDEBAR_WIDTH_KEY = "sigpi.sidebarWidth";
const DEFAULT_SIDEBAR_WIDTH = 280;

/** The workspace column width, mirrored to the `--sidebar-width` CSS variable. */
let sidebarWidth = DEFAULT_SIDEBAR_WIDTH;

/** Clamp a candidate width to the allowed range (and the layout's width). */
function clampSidebarWidth(width) {
	const layoutWidth = els.layout?.clientWidth ?? 0;
	const max =
		layoutWidth > 0
			? Math.max(
					SIDEBAR_MIN_WIDTH,
					Math.min(SIDEBAR_MAX_WIDTH, layoutWidth - CHAT_MIN_WIDTH),
				)
			: SIDEBAR_MAX_WIDTH;
	return Math.round(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), max));
}

/** Set the workspace column width and reflect it in the layout. */
function setSidebarWidth(width) {
	sidebarWidth = clampSidebarWidth(width);
	document.documentElement.style.setProperty(
		"--sidebar-width",
		`${sidebarWidth}px`,
	);
	return sidebarWidth;
}

/** Remember the width so it survives a reload (best-effort). */
function persistSidebarWidth(width) {
	try {
		localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
	} catch {
		// Storage can be unavailable (private mode); the width just won't stick.
	}
}

function restoreSidebarWidth() {
	let stored = Number.NaN;
	try {
		stored = Number.parseFloat(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? "");
	} catch {
		stored = Number.NaN;
	}
	setSidebarWidth(Number.isFinite(stored) ? stored : DEFAULT_SIDEBAR_WIDTH);
}

/** Pointer/keyboard handling for the workspace ⇄ conversation divider. */
function initSidebarResizer() {
	let dragStartX = 0;
	let dragStartWidth = sidebarWidth;
	const isDragging = () => els.resizer.classList.contains("dragging");

	els.resizer.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		dragStartX = event.clientX;
		dragStartWidth = sidebarWidth;
		els.resizer.classList.add("dragging");
		document.body.classList.add("resizing");
		els.resizer.setPointerCapture?.(event.pointerId);
	});

	els.resizer.addEventListener("pointermove", (event) => {
		if (!isDragging()) return;
		setSidebarWidth(dragStartWidth + (event.clientX - dragStartX));
	});

	const endDrag = (event) => {
		if (!isDragging()) return;
		els.resizer.classList.remove("dragging");
		document.body.classList.remove("resizing");
		els.resizer.releasePointerCapture?.(event.pointerId);
		persistSidebarWidth(sidebarWidth);
	};
	els.resizer.addEventListener("pointerup", endDrag);
	els.resizer.addEventListener("pointercancel", endDrag);

	// Keyboard nudge for accessibility: arrows resize, Shift+arrow is coarser.
	els.resizer.addEventListener("keydown", (event) => {
		const step = event.shiftKey ? 24 : 8;
		let delta = 0;
		if (event.key === "ArrowLeft") delta = -step;
		else if (event.key === "ArrowRight") delta = step;
		else return;
		event.preventDefault();
		persistSidebarWidth(setSidebarWidth(sidebarWidth + delta));
	});
}

// --- tree rendering --------------------------------------------------------

/** Re-draw the whole workspace → session tree from current state. */
function renderProjects() {
	closeMenu();
	els.projects.textContent = "";
	if (state.projects.length === 0) {
		const empty = document.createElement("div");
		empty.className = "empty";
		empty.textContent = "尚无工作区 — 点击 ＋ 添加。";
		els.projects.append(empty);
		return;
	}
	for (const project of state.projects) {
		els.projects.append(buildProjectNode(project));
	}
}

/** The label shown for a workspace: its custom name, else the folder name. */
function projectLabel(project) {
	return project.name || baseName(project.cwd);
}

/** One workspace group: a collapsible header row plus its nested session rows. */
function buildProjectNode(project) {
	const collapsed = state.collapsed.has(project.key);
	const group = document.createElement("div");
	group.className = "project";
	if (project.key === state.projectKey) group.classList.add("active");

	const header = document.createElement("div");
	header.className = "project-header";

	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "project-toggle";
	// Closed (📁) vs open (📂) folder: two distinct icons for the two states.
	toggle.textContent = collapsed ? "📁" : "📂";
	toggle.setAttribute("aria-expanded", String(!collapsed));
	toggle.title = collapsed ? "展开会话" : "收起会话";
	toggle.addEventListener("click", () => toggleProject(project.key));

	const name = document.createElement("button");
	name.type = "button";
	name.className = "project-name";
	name.textContent = projectLabel(project);
	// Keep the full path discoverable on hover, even though only the leaf shows.
	name.title = project.cwd;
	name.addEventListener("click", () => void selectProject(project.key));

	const menu = buildMenuButton(header, () => [
		menuItem("新会话", "menu-new-session", () => {
			closeMenu();
			createSession(project.key).catch((error) => showError(error.message));
		}),
		menuItem("重命名", "menu-rename", () => {
			closeMenu();
			beginRenameProject(project, name);
		}),
		menuDeleteItem("删除工作区", "确认删除？", () => deleteProject(project.key)),
	]);

	header.append(toggle, name, menu);
	group.append(header);

	if (!collapsed) {
		const list = document.createElement("div");
		list.className = "sessions";
		const bucket = state.sessionsByProject.get(project.key) ?? {
			stored: [],
			live: [],
		};
		// Live and stored sessions share one chronologically ordered list, keyed
		// on each session's persisted `updatedAt` (its last submitted message).
		// Opening a session makes it live but must not move it to the top, so a
		// row never reorders merely because it was selected.
		const liveIds = new Set(bucket.live.map((session) => session.sessionId));
		const rows = [
			...bucket.live.map((session) => ({
				session,
				resume: false,
				time: session.updatedAt ?? session.lastActivityAt,
			})),
			...bucket.stored
				.filter((session) => !liveIds.has(session.sessionId))
				.map((session) => ({
					session,
					resume: true,
					time: session.updatedAt,
				})),
		]
			.filter(({ session }) => !session.archived)
			.sort(
				(a, b) => (toEpochMillis(b.time) ?? 0) - (toEpochMillis(a.time) ?? 0),
			);
		for (const { session, resume, time } of rows) {
			list.append(
				buildSessionRow({
					projectKey: project.key,
					sessionId: session.sessionId,
					label: resume
						? `${sessionLabel(session)} · ${session.turnCount} turns`
						: `${session.turnActive ? "● " : ""}${sessionLabel(session)}`,
					updatedAt: time,
					resume,
				}),
			);
		}
		if (list.childElementCount === 0) {
			const empty = document.createElement("div");
			empty.className = "empty";
			empty.textContent = "暂无会话";
			list.append(empty);
		}
		group.append(list);
	}
	return group;
}

/**
 * A selectable session row: the session button, its "⋯" menu, and the
 * last-update time pinned to the row's right edge.
 */
function buildSessionRow({ projectKey, sessionId, label, updatedAt, resume }) {
	const active =
		projectKey === state.projectKey && sessionId === state.sessionId;
	const row = document.createElement("div");
	row.className = active ? "session-row active" : "session-row";

	const item = document.createElement("button");
	item.type = "button";
	item.className = "list-item session";
	item.textContent = label;
	item.title = sessionId;
	item.addEventListener("click", () =>
		void selectSession(projectKey, sessionId, { resume }),
	);

	const menu = buildMenuButton(row, () => [
		menuItem("重命名", "menu-rename", () => {
			closeMenu();
			beginRenameSession({ projectKey, sessionId, label }, item);
		}),
		menuItem("归档", "menu-archive", () => {
			closeMenu();
			archiveSession(projectKey, sessionId).catch((error) =>
				showError(error.message),
			);
		}),
	]);

	// Trailing the menu keeps the time flush against the right edge; the label
	// absorbs all shrinking, so the time is never clipped or ellipsized.
	const time = document.createElement("span");
	time.className = "session-time";
	setRelativeTime(time, updatedAt);

	row.append(item, menu, time);
	return row;
}

// --- row menus -------------------------------------------------------------

/** The dropdown currently open, if any. */
let openMenu = null;

/** Remove the open dropdown (safe to call when none is open). */
function closeMenu() {
	if (openMenu) {
		openMenu.remove();
		openMenu = null;
	}
}

// A click anywhere outside a menu dismisses it; menu item clicks stop
// propagation so they do not immediately close the menu behind them.
document.addEventListener("click", () => closeMenu());

/** The right-aligned "⋯" trigger that toggles a dropdown built on demand. */
function buildMenuButton(container, buildItems) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "menu-button";
	button.textContent = "⋯";
	button.title = "更多操作";
	button.setAttribute("aria-haspopup", "menu");
	button.addEventListener("click", (event) => {
		event.stopPropagation();
		const wasOpen = openMenu !== null && openMenu.parentElement === container;
		closeMenu();
		if (wasOpen) return;
		const menu = document.createElement("div");
		menu.className = "menu";
		for (const item of buildItems()) {
			menu.append(item);
		}
		container.append(menu);
		openMenu = menu;
	});
	return button;
}

/** Build one dropdown item button. */
function menuItem(label, className, onSelect) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = className ? `menu-item ${className}` : "menu-item";
	button.textContent = label;
	button.addEventListener("click", (event) => {
		event.stopPropagation();
		onSelect(button);
	});
	return button;
}

/** How long a delete item stays "armed" waiting for its confirming click. */
const CONFIRM_WINDOW_MS = 5000;

/** A destructive dropdown item: the first click arms it, the second runs it. */
function menuDeleteItem(label, confirmLabel, action) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "menu-item danger menu-delete";
	button.textContent = label;
	let armed = false;
	let timer = null;
	button.addEventListener("click", (event) => {
		event.stopPropagation();
		if (!armed) {
			armed = true;
			button.textContent = confirmLabel;
			button.classList.add("armed");
			timer = setTimeout(() => {
				armed = false;
				button.textContent = label;
				button.classList.remove("armed");
			}, CONFIRM_WINDOW_MS);
			return;
		}
		clearTimeout(timer);
		closeMenu();
		void Promise.resolve()
			.then(action)
			.catch((error) => showError(error.message));
	});
	return button;
}

// --- inline rename ---------------------------------------------------------

/** Swap a workspace's name for an editable input; Enter commits, Esc cancels. */
function beginRenameProject(project, nameEl) {
	const current = projectLabel(project);
	swapForInput(nameEl, current, (value) => {
		if (!value || value === current) {
			renderProjects();
			return;
		}
		void renameProject(project.key, value).catch((error) =>
			showError(error.message),
		);
	});
}

/** Swap a session label for an editable input; Enter commits, Esc cancels. */
function beginRenameSession({ projectKey, sessionId, label }, labelEl) {
	swapForInput(labelEl, label, (value) => {
		if (!value || value === label) {
			renderProjects();
			return;
		}
		void renameSession(projectKey, sessionId, value).catch((error) =>
			showError(error.message),
		);
	});
}

/** Replace `el` with a text input seeded with `initial`; commit on Enter/blur. */
function swapForInput(el, initial, commit) {
	const input = document.createElement("input");
	input.type = "text";
	input.className = "rename-input";
	input.value = initial;
	el.replaceWith(input);
	input.focus();
	if (typeof input.select === "function") input.select();
	let done = false;
	const finish = (save) => {
		if (done) return;
		done = true;
		commit(save ? input.value.trim() : "");
	};
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			finish(true);
		} else if (event.key === "Escape") {
			event.preventDefault();
			finish(false);
		}
	});
	input.addEventListener("blur", () => finish(true));
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
	resetModelState();
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

/** The last path segment, so a project shows just its folder name. */
function baseName(p) {
	if (!p) return "";
	const parts = p.split(/[\\/]+/).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : p;
}

/**
 * A human-readable session label: the derived title, else the last user input,
 * else a placeholder for a session that has not recorded anything yet. The raw
 * session id is never shown.
 */
function sessionLabel(session) {
	return session.title || session.lastCompletedUserInput || "新会话";
}

// --- relative time ---------------------------------------------------------

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/**
 * Coerce a timestamp — an ISO string (stored sessions' `updatedAt`) or epoch
 * milliseconds (live sessions' `lastActivityAt`) — into epoch ms, or `null`
 * when it is missing/unparseable.
 */
function toEpochMillis(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value) {
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? ms : null;
	}
	return null;
}

/**
 * A coarse "time since" label: 刚刚, then minutes, hours, days, months and years
 * as the gap widens. Deliberately compact so it fits the narrow tree column.
 */
function formatRelativeTime(ms, now = Date.now()) {
	const diff = now - ms;
	if (diff < MINUTE_MS) return "刚刚";
	const minutes = Math.floor(diff / MINUTE_MS);
	if (minutes < 60) return `${minutes}分钟`;
	const hours = Math.floor(diff / HOUR_MS);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(diff / DAY_MS);
	if (days < 30) return `${days}天`;
	const months = Math.floor(diff / MONTH_MS);
	if (months < 12) return `${months}月`;
	const years = Math.floor(diff / YEAR_MS);
	return `${years}年`;
}

/** Stamp a row's time element from a timestamp; blank when there is none. */
function setRelativeTime(el, value) {
	const ms = toEpochMillis(value);
	if (ms === null) {
		el.textContent = "";
		delete el.dataset.time;
		return;
	}
	el.dataset.time = String(ms);
	el.textContent = formatRelativeTime(ms);
	el.title = new Date(ms).toLocaleString();
}

/** Repaint every visible time label as the clock advances. */
function refreshRelativeTimes() {
	for (const el of els.projects.querySelectorAll(".session-time")) {
		const ms = Number(el.dataset.time);
		if (Number.isFinite(ms)) el.textContent = formatRelativeTime(ms);
	}
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

// The one composer button interrupts while a turn runs; when idle it is a
// `submit` button, so the form's submit handler below sends the message.
els.submit.addEventListener("click", (event) => {
	if (!state.turnActive) return;
	event.preventDefault();
	void interrupt();
});

els.modelSelect.addEventListener("change", () => {
	void switchModel(els.modelSelect.value);
});

restoreSidebarWidth();
initSidebarResizer();

// Keep the tree's "time since" labels honest without a full re-render (which
// would close any open row menu). `unref` keeps the timer from pinning the
// process open under the jsdom test harness.
const timeTicker = setInterval(refreshRelativeTimes, MINUTE_MS);
if (timeTicker && typeof timeTicker.unref === "function") timeTicker.unref();

loadProjects().catch((error) => showError(error.message));

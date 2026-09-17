// Background shell tasks: the composer badge plus a list/detail popover.
//
// The badge leads the composer action row (the blank space on its left) and
// shows how many background tasks the active session has. Clicking it opens a
// popover that lists every task (label, status, runtime); clicking a row shows
// the task's captured output and, while it is still running, a button to stop
// it. The list is fetched on session open and after each turn, and re-polled on
// a short timer while the popover is open, so a task that starts or finishes
// mid-turn shows up without a manual reload.

import { postJson, requestJson, sessionBase } from "./api.js";
import { els, showError } from "./dom.js";
import { state } from "./state.js";

/** How often the popover re-fetches while it is open. */
const TASK_REFRESH_MS = 2000;

/** Popover visibility and the task whose detail page is open, if any. */
let panelOpen = false;
let openTaskId = null;
/** The most recent `GET .../tasks/:id` payload for {@link openTaskId}. */
let detailData = null;
/** Interval that keeps the open popover fresh; `null` while it is closed. */
let pollTimer = null;

/** Wire the badge/close buttons and the outside-click dismissal. */
export function initTasks() {
	els.tasksButton?.addEventListener("click", (event) => {
		event.stopPropagation();
		toggleTasksPanel();
	});
	// The close button lives inside the popover, whose own click handler stops
	// propagation; wire it directly so it always closes regardless.
	els.tasksClose?.addEventListener("click", (event) => {
		event.stopPropagation();
		closeTasksPanel();
	});
	els.tasksPanel?.addEventListener("click", (event) => {
		event.stopPropagation();
	});
}

/** Toggle the popover from the badge. */
export function toggleTasksPanel() {
	if (panelOpen) {
		closeTasksPanel();
	} else {
		openTasksPanel();
	}
}

/** Open the popover, fetch the current task list, and start polling it. */
export function openTasksPanel() {
	if (panelOpen) return;
	panelOpen = true;
	openTaskId = null;
	detailData = null;
	showPanel();
	renderPanel();
	void refreshTasks();
	startPoll();
}

/** Close the popover, stop polling, and forget the open detail. */
export function closeTasksPanel() {
	if (!panelOpen) return;
	panelOpen = false;
	openTaskId = null;
	detailData = null;
	hidePanel();
	stopPoll();
}

/**
 * Fetch the active session's background tasks and re-render. Failures (a server
 * without task reporting, or offline) collapse to an empty list rather than
 * surfacing noise; a session switch mid-flight drops the stale result.
 */
export async function refreshTasks() {
	if (!state.sessionId) {
		setTasks([]);
		return;
	}
	const projectKey = state.projectKey;
	const sessionId = state.sessionId;
	let tasks = [];
	try {
		const body = await requestJson(`${sessionBase()}/tasks`);
		if (state.sessionId !== sessionId || state.projectKey !== projectKey)
			return;
		tasks = Array.isArray(body?.tasks) ? body.tasks : [];
	} catch {
		if (state.sessionId !== sessionId || state.projectKey !== projectKey)
			return;
		tasks = [];
	}
	setTasks(tasks);
}

/** Clear the badge and close the popover when no session is active. */
export function resetTasks() {
	closeTasksPanel();
	setTasks([]);
}

/** Store the task list and re-render the badge (and popover when open). */
function setTasks(tasks) {
	state.backgroundTasks = tasks;
	// A task the detail view was showing may be gone (the session ended, or the
	// list turned over); fall back to the list so the popover never strands.
	if (openTaskId && !tasks.some((task) => task.id === openTaskId)) {
		openTaskId = null;
		detailData = null;
	}
	renderBadge();
	if (panelOpen) renderPanel();
}

// --- badge -----------------------------------------------------------------

/** Render the count badge, hiding it entirely when no session is open. */
function renderBadge() {
	const button = els.tasksButton;
	if (!button) return;
	if (!state.sessionId) {
		button.hidden = true;
		return;
	}
	const tasks = state.backgroundTasks;
	const running = tasks.filter((task) => task.status === "running").length;
	button.hidden = false;
	button.classList.toggle("has-tasks", tasks.length > 0);
	button.classList.toggle("has-running", running > 0);
	const title =
		tasks.length > 0
			? `后台任务 ${tasks.length}${running > 0 ? `（运行中 ${running}）` : ""}`
			: "后台任务";
	button.title = title;
	button.setAttribute("aria-label", title);
	if (els.tasksCount) els.tasksCount.textContent = String(tasks.length);
}

// --- popover ---------------------------------------------------------------

function showPanel() {
	if (els.tasksPanel) els.tasksPanel.hidden = false;
}

function hidePanel() {
	if (els.tasksPanel) els.tasksPanel.hidden = true;
}

function renderPanel() {
	if (openTaskId) renderDetail(openTaskId);
	else renderList();
}

/** Render the task list (or an empty hint) into the popover body. */
function renderList() {
	const list = els.tasksList;
	const detail = els.tasksDetail;
	if (!list || !detail) return;
	detail.hidden = true;
	list.hidden = false;
	list.textContent = "";

	if (state.backgroundTasks.length === 0) {
		const empty = document.createElement("div");
		empty.className = "tasks-empty";
		empty.textContent = "暂无后台任务";
		list.append(empty);
		return;
	}

	const now = Date.now();
	for (const task of state.backgroundTasks) {
		const row = document.createElement("button");
		row.type = "button";
		row.className = "task-item";
		if (task.status === "running") row.classList.add("running");

		const label = document.createElement("span");
		label.className = "task-label";
		label.textContent = taskLabel(task);
		label.title = taskLabel(task);

		const meta = document.createElement("span");
		meta.className = "task-meta";
		meta.textContent = `${taskStatus(task)} · ${formatTaskRuntime(taskRuntimeMs(task, now))}`;

		row.append(label, meta);
		row.addEventListener("click", (event) => {
			event.stopPropagation();
			openTaskId = task.id;
			detailData = null;
			renderDetail(task.id);
			void loadTaskDetail(task.id);
		});
		list.append(row);
	}
}

/** Render the detail page for `id`, fetching its output lazily. */
function renderDetail(id) {
	const list = els.tasksList;
	const detail = els.tasksDetail;
	if (!list || !detail) return;
	list.hidden = true;
	detail.hidden = false;
	detail.textContent = "";

	const back = document.createElement("button");
	back.type = "button";
	back.className = "task-back";
	back.textContent = "← 返回列表";
	back.addEventListener("click", (event) => {
		event.stopPropagation();
		openTaskId = null;
		detailData = null;
		renderPanel();
	});
	detail.append(back);

	const task =
		detailData?.task ??
		state.backgroundTasks.find((candidate) => candidate.id === id) ??
		null;
	if (!task) {
		const gone = document.createElement("div");
		gone.className = "tasks-empty";
		gone.textContent = "任务不存在或已结束";
		detail.append(gone);
		return;
	}

	const meta = document.createElement("dl");
	meta.className = "task-detail-meta";
	for (const [key, value] of [
		["状态", taskStatus(task)],
		["运行", formatTaskRuntime(taskRuntimeMs(task))],
		["命令", task.command || ""],
		["目录", task.cwd || ""],
		["Id", task.id],
	]) {
		const dt = document.createElement("dt");
		dt.textContent = key;
		const dd = document.createElement("dd");
		dd.textContent = value;
		dd.title = value;
		meta.append(dt, dd);
	}
	detail.append(meta);

	const outputLabel = document.createElement("div");
	outputLabel.className = "task-output-label";
	outputLabel.textContent = detailData?.truncated
		? "输出（已截断，显示末尾）"
		: "输出";
	const output = document.createElement("pre");
	output.className = "task-output";
	output.textContent = detailData ? detailData.output : "加载中…";
	detail.append(outputLabel, output);

	if (task.status === "running") {
		const kill = document.createElement("button");
		kill.type = "button";
		kill.className = "task-kill";
		kill.textContent = "停止任务";
		kill.addEventListener("click", (event) => {
			event.stopPropagation();
			void killTask(task.id);
		});
		detail.append(kill);
	}

	// Keep the tail visible as the log grows.
	output.scrollTop = output.scrollHeight;
}

/** Fetch one task's metadata + output tail and re-render its detail page. */
async function loadTaskDetail(id) {
	const projectKey = state.projectKey;
	const sessionId = state.sessionId;
	try {
		const body = await requestJson(
			`${sessionBase()}/tasks/${encodeURIComponent(id)}`,
		);
		if (
			state.sessionId !== sessionId ||
			state.projectKey !== projectKey ||
			openTaskId !== id
		) {
			return;
		}
		detailData = {
			task: body?.task ?? null,
			output: typeof body?.output === "string" ? body.output : "",
			truncated: Boolean(body?.truncated),
		};
	} catch (error) {
		if (openTaskId !== id) return;
		detailData = null;
		showError(error.message);
	}
	if (openTaskId === id) renderDetail(id);
}

/** Stop a running task, then refresh the list and the open detail page. */
async function killTask(id) {
	try {
		await postJson(`${sessionBase()}/tasks/${encodeURIComponent(id)}/kill`, {});
	} catch (error) {
		showError(error.message);
	}
	await refreshTasks();
	if (openTaskId === id) await loadTaskDetail(id);
}

// --- polling ---------------------------------------------------------------

function startPoll() {
	stopPoll();
	pollTimer = setInterval(() => {
		if (!panelOpen) {
			stopPoll();
			return;
		}
		void (async () => {
			await refreshTasks();
			if (openTaskId) await loadTaskDetail(openTaskId);
		})();
	}, TASK_REFRESH_MS);
	pollTimer?.unref?.();
}

function stopPoll() {
	if (pollTimer !== null) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

// --- formatting ------------------------------------------------------------

/** The task's human label: its description, else its command, else its id. */
function taskLabel(task) {
	return task.description || task.command || task.id;
}

/** A compact status line: `运行中` / `停止中` / `完成 (exit 0, ...)`. */
function taskStatus(task) {
	if (task.status === "running") {
		return task.killed ? "停止中" : "运行中";
	}
	const bits = [];
	if (task.exitCode != null) bits.push(`exit ${task.exitCode}`);
	if (task.signal) bits.push(`signal ${task.signal}`);
	if (task.timedOut) bits.push("超时");
	return bits.length > 0 ? `完成 (${bits.join(", ")})` : "完成";
}

/**
 * Elapsed time of a task in ms. A running task counts from `startedAt` to now;
 * a finished one freezes at `endedAt`, so its runtime stops moving.
 */
export function taskRuntimeMs(task, now = Date.now()) {
	const end =
		task.status === "done" && task.endedAt != null ? task.endedAt : now;
	return end - task.startedAt;
}

/** Format an elapsed duration as `24s`, `1m 5s`, `1h 2m`, ... */
function formatTaskRuntime(elapsedMs) {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const parts = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
	return parts.join(" ");
}

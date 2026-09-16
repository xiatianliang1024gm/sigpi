// Project/session tree rendering.

import { els, showError } from "./dom.js";
import { baseName, formatRelativeTime, sessionLabel, setRelativeTime, toEpochMillis } from "./format.js";
import { beginRenameProject, beginRenameSession, buildMenuButton, closeMenu, menuDeleteItem, menuItem } from "./menus.js";
import { deleteProject, selectProject, toggleProject } from "./projects.js";
import { archiveSession, createSession, selectSession } from "./sessions.js";
import { state } from "./state.js";

/** Re-draw the whole workspace → session tree from current state. */
export function renderProjects() {
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
export function projectLabel(project) {
	return project.name || baseName(project.cwd);
}

/** One workspace group: a collapsible header row plus its nested session rows. */
export function buildProjectNode(project) {
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
export function buildSessionRow({ projectKey, sessionId, label, updatedAt, resume }) {
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

/** Repaint every visible time label as the clock advances. */
export function refreshRelativeTimes() {
	for (const el of els.projects.querySelectorAll(".session-time")) {
		const ms = Number(el.dataset.time);
		if (Number.isFinite(ms)) el.textContent = formatRelativeTime(ms);
	}
}

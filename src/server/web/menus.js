// Row dropdown menus and inline rename.

import { showError } from "./dom.js";
import { renameProject, renameSession } from "./sessions.js";
import { projectLabel, renderProjects } from "./tree.js";

/** The dropdown currently open, if any. */
export let openMenu = null;

/** Remove the open dropdown (safe to call when none is open). */
export function closeMenu() {
	if (openMenu) {
		openMenu.remove();
		openMenu = null;
	}
}

/** The right-aligned "⋯" trigger that toggles a dropdown built on demand. */
export function buildMenuButton(container, buildItems) {
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
export function menuItem(label, className, onSelect) {
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
export const CONFIRM_WINDOW_MS = 5000;

/** A destructive dropdown item: the first click arms it, the second runs it. */
export function menuDeleteItem(label, confirmLabel, action) {
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
export function beginRenameProject(project, nameEl) {
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
export function beginRenameSession({ projectKey, sessionId, label }, labelEl) {
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
export function swapForInput(el, initial, commit) {
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

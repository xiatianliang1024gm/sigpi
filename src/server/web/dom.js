// DOM element handles and transient status feedback.

function collectEls() {
	return {
		status: document.getElementById("status"),
		projects: document.getElementById("projects"),
		addProject: document.getElementById("add-project"),
		collapseProjects: document.getElementById("collapse-projects"),
		expandProjects: document.getElementById("expand-projects"),
		layout: document.querySelector(".layout"),
		resizer: document.getElementById("resizer"),
		transcript: document.getElementById("transcript"),
		loadEarlier: document.getElementById("load-earlier"),
		composer: document.getElementById("composer"),
		input: document.getElementById("input"),
		submit: document.getElementById("submit"),
		modelSelect: document.getElementById("model-select"),
		contextUsage: document.getElementById("context-usage"),
		sessionInfo: document.getElementById("session-info"),
		error: document.getElementById("error"),
	};
}

/** Element handles for the current document, rebound by {@link initDom}. */
export let els = collectEls();

/** Rebind {@link els} to the current document (called once per app load). */
export function initDom() {
	els = collectEls();
}

export function setConnection(text) {
	els.status.textContent = text;
}

export function showError(message) {
	els.error.textContent = message;
	els.error.hidden = false;
	clearTimeout(showError.timer);
	showError.timer = setTimeout(() => {
		els.error.hidden = true;
	}, 6000);
}

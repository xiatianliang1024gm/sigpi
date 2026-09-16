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

import { interrupt, saveDraft, submitComposer } from "./composer.js";
import { els, initDom, showError } from "./dom.js";
import { MINUTE_MS, projectErrorMessage } from "./format.js";
import { closeMenu } from "./menus.js";
import { loadProjects, pickAndAddProject } from "./projects.js";
import { switchModel } from "./sessions.js";
import { initSidebarResizer, restoreSidebarWidth } from "./sidebar.js";
import { resetState, state } from "./state.js";
import { loadHistory } from "./transcript.js";
import { refreshRelativeTimes } from "./tree.js";

initDom();
resetState();

// A click anywhere outside a menu dismisses it; menu item/trigger clicks stop
// propagation so only genuinely outside clicks reach the document.
document.addEventListener("click", () => closeMenu());

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

els.composer.addEventListener("submit", (event) => {
	event.preventDefault();
	submitComposer();
});

// Keep the active session's draft current as the user types, so switching
// sessions (or a session list refresh) never loses the box contents.
els.input.addEventListener("input", () => saveDraft());

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


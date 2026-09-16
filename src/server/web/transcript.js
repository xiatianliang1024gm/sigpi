// Transcript view and history paging.

import { requestJson, sessionBase } from "./api.js";
import { els, showError } from "./dom.js";
import { state } from "./state.js";
import { renderMarkdown } from "./markdown.js";

/** Entries fetched per history page when resuming a session. */
export const HISTORY_PAGE_SIZE = 30;

// --- transcript view -------------------------------------------------------

/**
 * Build the shared skeleton for an assistant message: a collapsible reasoning
 * panel above the rendered markdown content. The reasoning panel is a native
 * `<details>` so expand/collapse and keyboard access come for free; it starts
 * hidden and stays collapsed — a single summary line — until the model emits
 * reasoning.
 */
export function createAssistantMessage() {
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
export function reasoningPreviewText(text) {
	const line = text.split(/\r?\n/).find((candidate) => candidate.trim());
	return line ? line.trim() : "…";
}

/** Replace a `.content` node's children with freshly rendered markdown. */
export function renderContent(element, text) {
	element.replaceChildren(renderMarkdown(text));
}

/** Append a node to the transcript and remember it as part of the open turn. */
export function appendTurnNode(node) {
	els.transcript.append(node);
	state.turnNodes.push(node);
	scrollToEnd();
}

/**
 * Drop the open turn's transcript nodes. Called when a (re)played
 * `turn_started` arrives so the freshly streamed turn rebuilds in place instead
 * of being appended below a stale partial copy.
 */
export function clearTurnNodes() {
	for (const node of state.turnNodes) node.remove();
	state.turnNodes = [];
}

/** The DOM-backed {@link TurnTranscriptView} the shared reducer writes to. */
export const view = {
	beginAssistantMessage() {
		const { root, reasoning, preview, body, content } =
			createAssistantMessage();
		appendTurnNode(root);
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
		appendTurnNode(line);
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
		appendTurnNode(line);
	},
};

export function scrollToEnd() {
	els.transcript.scrollTop = els.transcript.scrollHeight;
}

export function clearTranscript() {
	state.currentAssistant = null;
	state.toolLines.clear();
	state.turnNodes = [];
	state.seq = 0;
	els.transcript.textContent = "";
	resetHistory();
}

export function addUserMessage(text) {
	const el = document.createElement("div");
	el.className = "msg user";
	el.textContent = text;
	els.transcript.append(el);
	scrollToEnd();
}

// --- history ---------------------------------------------------------------

/** Build the DOM node for one server-projected history item. */
export function historyItemToElement(item) {
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
		// `label` is the server-reconstructed call summary (e.g. `shell git
		// status`), matching the live `tool_execution_started` line; fall back
		// to the bare tool name for older/stored items without one.
		label.textContent = `✓ ${item.label ?? item.name}`;
		line.append(label);
		return line;
	}
	const line = document.createElement("div");
	line.className = "system info";
	line.textContent = item.text;
	return line;
}

/** Render a history page, either newest-page (append) or older (prepend). */
export function renderHistory(items, { prepend }) {
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

export function resetHistory() {
	state.historyCursor = null;
	state.historyLoading = false;
	updateLoadEarlier();
}

export function updateLoadEarlier() {
	els.loadEarlier.hidden = !state.sessionId || state.historyCursor === null;
	els.loadEarlier.disabled = state.historyLoading;
}

/**
 * Load a page of persisted history for the active session. The newest page is
 * fetched on session select; `older` walks backwards using the server cursor.
 */
export async function loadHistory({ older = false } = {}) {
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
		// The newest page reports how far the persisted transcript reaches; the
		// event stream then resumes from there (older pages must not move it).
		if (!older) {
			state.seq = Number(page?.eventsCursor) || 0;
		}
		renderHistory(page?.items ?? [], { prepend: older });
	} catch (error) {
		showError(error.message);
	} finally {
		state.historyLoading = false;
		updateLoadEarlier();
	}
}

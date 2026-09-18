// The single mutable client store.

function createState() {
	return {
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
		/**
		 * Last SSE event sequence applied for the active session. Seeded from the
		 * history response's `eventsCursor`, then advanced by each frame's `id:`, so
		 * a (re)connect can subscribe with `?after=<seq>` and receive only the frames
		 * it has not seen — no duplicate replay, no gap.
		 */
		seq: 0,
		/** Configured models for the active session: `{ id, name }`. */
		models: [],
		/** The active session's current model id, or null when unknown. */
		modelId: null,
		/** Usable context window for the active session (hard limit − reserve), or null. */
		contextLimit: null,
		/** Used context tokens (last usage / live estimate), or null when unknown. */
		contextUsedTokens: null,
		/** Cumulative session statistics for the info line, or null when unknown. */
		sessionStats: null,
		/** Background shell tasks for the active session, oldest first. */
		backgroundTasks: [],
		/**
		 * The active session's `update_plan` snapshot (`{ explanation, updatedAt,
		 * items: [{ step, status, startedAt, completedAt, elapsedMs,
		 * localStartedAt }] }`), or `null` when it has no plan. Folded from the
		 * live SSE frames and restored from `GET .../plan` on session open.
		 */
		plan: null,
		currentAssistant: null,
		toolLines: new Map(),
		/**
		 * Transcript nodes rendered for the currently open turn. Cleared when a
		 * replayed `turn_started` arrives (a cursorless reconnect), so that turn
		 * rebuilds in place instead of appending a duplicate below a stale partial.
		 * The normal resume path replays only frames newer than `seq`, so it never
		 * needs this.
		 */
		turnNodes: [],
		/** Exclusive end index for the next older history page; null when none. */
		historyCursor: null,
		historyLoading: false,
		/** `${projectKey}\u0000${sessionId}` → unsubmitted composer text. */
		drafts: new Map(),
	};
}

/** The one mutable store the UI reads and writes. */
export const state = createState();

/** Rebuild {@link state} in place (called once per app load). */
export function resetState() {
	Object.assign(state, createState());
}

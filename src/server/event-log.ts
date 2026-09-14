import type { TurnProgressEvent } from "../types.js";

/**
 * The minimal surface {@link SessionEventLog} needs from a session: a way to
 * subscribe to its turn-progress stream. `SessionController` satisfies this
 * structurally, so the log records events for the whole lifetime of a session —
 * not merely while a browser is connected.
 */
export interface ProgressEventSource {
	onProgress(listener: (event: TurnProgressEvent) => void): () => void;
}

/** One turn-progress event paired with the sequence number it was logged under. */
export interface LoggedEvent {
	/** Monotonic, per-session, starting at 1. */
	seq: number;
	event: TurnProgressEvent;
}

/** The four events that end a turn (mirrors `isTurnTerminalEvent`). */
const TERMINAL_TYPES: ReadonlySet<TurnProgressEvent["type"]> = new Set([
	"turn_finished",
	"turn_interrupted",
	"turn_failed",
	"turn_max_steps_reached",
]);

/**
 * Default cap on retained events per session. Sized to comfortably hold several
 * full turns — including a long streaming answer — while bounding memory for a
 * process that hosts many sessions at once.
 */
export const DEFAULT_EVENT_BUFFER_SIZE = 2048;

/**
 * A bounded, replayable log of one session's turn-progress events.
 *
 * Why this exists: the SSE stream is a live broadcast that only reaches a
 * browser while its `EventSource` is connected. Because a turn keeps running
 * after the user switches away — and because a torn connection silently drops
 * whatever was emitted during the gap — a client that reconnects later would
 * otherwise miss those frames forever. This log assigns every event a monotonic
 * sequence number and retains the recent ones so that a (re)connecting client
 * can rebuild the in-flight turn from its start (see {@link replayOpenTurn}).
 *
 * The log subscribes to its source once, at construction, so events are retained
 * from the moment the session is created, independent of any SSE client. It also
 * tracks whether a turn is currently *open* (started but not yet terminated),
 * which is what decides whether a fresh connection has anything to replay — a
 * completed turn is already covered by persisted history, so replaying it would
 * only duplicate the transcript.
 */
export class SessionEventLog {
	private readonly buffer: LoggedEvent[] = [];
	private nextSeq = 1;
	private openTurnStartSeq: number | null = null;
	private readonly listeners = new Set<(entry: LoggedEvent) => void>();
	private readonly unsubscribe: () => void;

	constructor(
		source: ProgressEventSource,
		private readonly maxBuffer = DEFAULT_EVENT_BUFFER_SIZE,
	) {
		this.unsubscribe = source.onProgress((event) => this.record(event));
	}

	/** Sequence number of the most recent logged event (`0` when none). */
	get latestSeq(): number {
		return this.nextSeq - 1;
	}

	/** True while the most recent turn has started but not yet terminated. */
	get isTurnOpen(): boolean {
		return this.openTurnStartSeq !== null;
	}

	/**
	 * Every retained event belonging to the still-open turn, from its
	 * `turn_started` inclusive. Empty when no turn is open (idle, or the last
	 * turn already terminated and is therefore reconstructable from history).
	 *
	 * A client (re)opening a session has no cursor to trust — a browser may echo
	 * back a stale `Last-Event-ID` from an earlier connection, which would make it
	 * skip the very frames it is missing — so instead of resuming after a
	 * sequence, the client rebuilds the one turn that is genuinely unpersisted.
	 */
	replayOpenTurn(): LoggedEvent[] {
		if (this.openTurnStartSeq === null) {
			return [];
		}
		const index = this.buffer.findIndex(
			(entry) => entry.seq === this.openTurnStartSeq,
		);
		// The turn start may have been evicted by the bounded buffer; if so, hand
		// back everything retained (a partial rebuild beats nothing).
		return index === -1 ? [...this.buffer] : this.buffer.slice(index);
	}

	/** Subscribe to newly logged events. Returns an unsubscribe function. */
	subscribe(listener: (entry: LoggedEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Stop recording and drop every listener and buffered event. */
	dispose(): void {
		this.unsubscribe();
		this.listeners.clear();
		this.buffer.length = 0;
	}

	private record(event: TurnProgressEvent): void {
		const entry: LoggedEvent = { seq: this.nextSeq, event };
		this.nextSeq += 1;
		this.buffer.push(entry);
		if (this.buffer.length > this.maxBuffer) {
			this.buffer.shift();
		}
		if (event.type === "turn_started") {
			this.openTurnStartSeq = entry.seq;
		} else if (TERMINAL_TYPES.has(event.type)) {
			this.openTurnStartSeq = null;
		}
		// Snapshot so a listener that unsubscribes mid-delivery can't perturb it.
		for (const listener of [...this.listeners]) {
			listener(entry);
		}
	}
}

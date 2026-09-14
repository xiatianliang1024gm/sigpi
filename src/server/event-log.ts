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
 * sequence number and retains the recent ones, so a reconnecting client can be
 * caught up (see {@link replayAfter}) and a client opening a session mid-turn
 * can rebuild the in-flight turn (see {@link replayCurrentTurn}).
 *
 * The log subscribes to its source once, at construction, so events are retained
 * from the moment the session is created, independent of any SSE client.
 */
export class SessionEventLog {
	private readonly buffer: LoggedEvent[] = [];
	private nextSeq = 1;
	private currentTurnStartSeq: number | null = null;
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

	/** Sequence number of the oldest still-retained event (`latestSeq + 1` when empty). */
	get oldestSeq(): number {
		return this.buffer.length > 0 ? this.buffer[0].seq : this.nextSeq;
	}

	/** Every retained event newer than `seq`, oldest first. */
	replayAfter(seq: number): LoggedEvent[] {
		return this.buffer.filter((entry) => entry.seq > seq);
	}

	/**
	 * Every retained event from the start of the most recent turn, inclusive.
	 * Used to rebuild an in-flight turn for a client that (re)opens a session
	 * without a cursor: the earlier turns are already covered by persisted
	 * history, and the current turn is not yet persisted, so replaying just this
	 * turn reconstructs the live view without duplicating history.
	 */
	replayCurrentTurn(): LoggedEvent[] {
		if (this.currentTurnStartSeq === null) {
			return [];
		}
		const index = this.buffer.findIndex(
			(entry) => entry.seq === this.currentTurnStartSeq,
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
			this.currentTurnStartSeq = entry.seq;
		}
		// Snapshot so a listener that unsubscribes mid-delivery can't perturb it.
		for (const listener of [...this.listeners]) {
			listener(entry);
		}
	}
}

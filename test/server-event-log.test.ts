import assert from "node:assert/strict";
import test from "node:test";
import { type LoggedEvent, SessionEventLog } from "../src/server/event-log.js";
import type { TurnProgressEvent } from "../src/types.js";

/** A minimal stand-in for a session's progress bus. */
class FakeBus {
	private readonly listeners = new Set<(event: TurnProgressEvent) => void>();

	onProgress(listener: (event: TurnProgressEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	fire(event: TurnProgressEvent): void {
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}
}

const started = (turnId: string): TurnProgressEvent => ({
	type: "turn_started",
	turnId,
	userInput: "hi",
});

const delta = (contentDelta: string): TurnProgressEvent => ({
	type: "model_delta",
	step: 1,
	contentDelta,
});

test("assigns monotonic sequence numbers starting at 1", () => {
	const bus = new FakeBus();
	const log = new SessionEventLog(bus);

	assert.equal(log.latestSeq, 0, "no events yet");
	bus.fire(started("t1"));
	bus.fire(delta("a"));
	bus.fire(delta("b"));

	assert.equal(log.latestSeq, 3);
	assert.deepEqual(
		log.replayAfter(0).map((entry) => entry.seq),
		[1, 2, 3],
	);
	assert.deepEqual(
		log.replayAfter(2).map((entry) => entry.seq),
		[3],
		"only frames newer than the cursor are replayed",
	);
});

test("replayAfter yields the exact events emitted while no client was attached", () => {
	const bus = new FakeBus();
	const log = new SessionEventLog(bus);
	bus.fire(started("t1"));
	// A client connected and saw seq 1, then dropped; these arrive in the gap.
	bus.fire(delta("Hel"));
	bus.fire(delta("lo"));

	const replayed: LoggedEvent[] = log.replayAfter(1);
	assert.deepEqual(
		replayed.map((entry) => entry.event),
		[delta("Hel"), delta("lo")],
	);
});

test("replayCurrentTurn returns from the most recent turn_started", () => {
	const bus = new FakeBus();
	const log = new SessionEventLog(bus);
	bus.fire(started("t1"));
	bus.fire(delta("first turn"));
	bus.fire(started("t2"));
	bus.fire(delta("second turn"));

	const replayed = log.replayCurrentTurn();
	assert.deepEqual(
		replayed.map((entry) => entry.event),
		[started("t2"), delta("second turn")],
		"an earlier completed turn is left to persisted history",
	);
});

test("replayCurrentTurn is empty before any turn has started", () => {
	const bus = new FakeBus();
	const log = new SessionEventLog(bus);
	assert.deepEqual(log.replayCurrentTurn(), []);
});

test("the bounded buffer evicts the oldest events", () => {
	const bus = new FakeBus();
	const log = new SessionEventLog(bus, 2);
	bus.fire(started("t1"));
	bus.fire(delta("a"));
	bus.fire(delta("b"));

	assert.equal(log.oldestSeq, 2, "seq 1 was evicted");
	assert.deepEqual(
		log.replayAfter(0).map((entry) => entry.seq),
		[2, 3],
	);
});

test("subscribe delivers live entries and stops on unsubscribe", () => {
	const bus = new FakeBus();
	const log = new SessionEventLog(bus);
	const seen: number[] = [];
	const unsubscribe = log.subscribe((entry) => seen.push(entry.seq));

	bus.fire(started("t1"));
	bus.fire(delta("a"));
	unsubscribe();
	bus.fire(delta("b"));

	assert.deepEqual(seen, [1, 2]);
});

test("dispose stops recording and detaches from the source", () => {
	const bus = new FakeBus();
	const log = new SessionEventLog(bus);
	bus.fire(started("t1"));
	log.dispose();
	bus.fire(delta("after dispose"));

	assert.equal(log.latestSeq, 1, "no event is recorded after dispose");
	assert.deepEqual(log.replayAfter(0), [], "the buffer is dropped");
});

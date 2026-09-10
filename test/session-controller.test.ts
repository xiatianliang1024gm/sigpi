import assert from "node:assert/strict";
import test from "node:test";
import { TurnInterruptController } from "../src/interrupt.js";
import type {
	InterruptAck,
	SessionControllerRuntime,
	SessionProgressBus,
	SessionTurnOutcome,
	SessionTurnRunner,
} from "../src/session/controller.js";
import { SessionController } from "../src/session/controller.js";
import type {
	RuntimeLogger,
	TurnProgressEvent,
	TurnProgressEventMap,
} from "../src/types.js";

const noopLogger: RuntimeLogger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** In-memory progress bus: records synthetic emits and fans out to listeners. */
class FakeProgressBus implements SessionProgressBus {
	readonly listeners = new Set<(event: TurnProgressEvent) => void>();
	readonly emitted: Array<{
		type: string;
		payload: TurnProgressEventMap["interrupt_requested"];
	}> = [];

	onProgress(listener: (event: TurnProgressEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	emitProgress(
		type: "interrupt_requested",
		payload: TurnProgressEventMap["interrupt_requested"],
	): void {
		this.emitted.push({ type, payload });
		this.fire({ type, ...payload });
	}

	/** Simulate a runner-originated event (not synthetic). */
	fire(event: TurnProgressEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

/** Turn runner that parks on a gate so tests can observe the in-flight state. */
class FakeTurnRunner implements SessionTurnRunner {
	readonly calls: Array<{
		input: string;
		interruptController?: TurnInterruptController;
	}> = [];
	result: SessionTurnOutcome = {
		ok: true,
		completionStatus: "completed",
		outputText: "ok",
	};
	#gate: Promise<void> | null = null;
	#release: (() => void) | null = null;

	/** Make the next `runTurn` block until {@link release} is called. */
	park(): void {
		const d = deferred();
		this.#gate = d.promise;
		this.#release = d.resolve;
	}

	release(): void {
		this.#release?.();
		this.#gate = null;
		this.#release = null;
	}

	async runTurn(
		input: string,
		_logger: RuntimeLogger,
		interruptController?: TurnInterruptController,
	): Promise<SessionTurnOutcome> {
		this.calls.push({ input, interruptController });
		interruptController?.beginTurn();
		interruptController?.enterModel();
		if (this.#gate) {
			await this.#gate;
		}
		return this.result;
	}
}

function makeRuntime(): {
	runtime: SessionControllerRuntime;
	bus: FakeProgressBus;
	turn: FakeTurnRunner;
} {
	const bus = new FakeProgressBus();
	const turn = new FakeTurnRunner();
	return { runtime: { runner: bus, turn, logger: noopLogger }, bus, turn };
}

/** Wait for the microtask queue to drain so a parked `submit` is in flight. */
async function tick(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

test("onProgress forwards runner events to subscribers and unsubscribes", () => {
	const { runtime, bus } = makeRuntime();
	const controller = new SessionController(runtime);

	const seen: TurnProgressEvent[] = [];
	const unsubscribe = controller.onProgress((event) => seen.push(event));

	bus.fire({ type: "step_started", step: 2 });
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.type, "step_started");

	unsubscribe();
	bus.fire({ type: "step_started", step: 3 });
	assert.equal(seen.length, 1, "no events after unsubscribe");
});

test("submit runs the turn with a fresh interrupt controller and reports idle after", async () => {
	const { runtime, turn } = makeRuntime();
	turn.result = { ok: true, completionStatus: "interrupted", outputText: null };
	const controller = new SessionController(runtime);

	assert.equal(controller.isTurnActive(), false, "idle before submit");
	const outcome = await controller.submit("hello");

	assert.deepEqual(outcome, {
		ok: true,
		completionStatus: "interrupted",
		outputText: null,
	});
	assert.equal(turn.calls.length, 1);
	assert.equal(turn.calls[0]?.input, "hello");
	assert.ok(
		turn.calls[0]?.interruptController instanceof TurnInterruptController,
		"controller supplies an interrupt controller",
	);
	assert.equal(controller.isTurnActive(), false, "idle after submit");
});

test("isTurnActive is true while a submit is in flight", async () => {
	const { runtime, turn } = makeRuntime();
	turn.park();
	const controller = new SessionController(runtime);

	const pending = controller.submit("long turn");
	await tick();
	assert.equal(controller.isTurnActive(), true);

	turn.release();
	await pending;
	assert.equal(controller.isTurnActive(), false);
});

test("requestInterrupt is a no-op when no turn is running", () => {
	const { runtime, bus } = makeRuntime();
	const controller = new SessionController(runtime);

	const ack: InterruptAck = controller.requestInterrupt();
	assert.deepEqual(ack, {
		accepted: false,
		alreadyRequested: false,
		stage: null,
		message: null,
	});
	assert.equal(bus.emitted.length, 0);
});

test("requestInterrupt during a turn emits the synthetic event on the stream", async () => {
	const { runtime, bus, turn } = makeRuntime();
	turn.park();
	const controller = new SessionController(runtime);

	const seen: TurnProgressEvent[] = [];
	controller.onProgress((event) => seen.push(event));

	const pending = controller.submit("long turn");
	await tick();

	const ack = controller.requestInterrupt();
	assert.equal(ack.accepted, true);
	assert.equal(ack.stage, "model");
	assert.equal(ack.message, "Cancelling current model request");
	// The synthetic event is emitted on the runner bus AND re-broadcast to the
	// frontend's subscription (so the web stream and the TUI both see it).
	assert.equal(bus.emitted.length, 1);
	assert.ok(
		seen.some((event) => event.type === "interrupt_requested"),
		"frontend subscription saw interrupt_requested",
	);

	turn.release();
	await pending;
});

test("setRuntime re-binds the subscription and keeps existing listeners", () => {
	const first = makeRuntime();
	const second = makeRuntime();
	const controller = new SessionController(first.runtime);

	const seen: TurnProgressEvent[] = [];
	controller.onProgress((event) => seen.push(event));

	// Before the swap: the first runtime's events are delivered.
	first.bus.fire({ type: "step_started", step: 1 });
	assert.equal(seen.length, 1);

	controller.setRuntime(second.runtime);

	// After the swap: the new runtime's events are delivered, the old runtime's
	// are not, and the frontend never had to re-subscribe.
	second.bus.fire({ type: "step_started", step: 2 });
	assert.equal(seen.length, 2);
	first.bus.fire({ type: "step_started", step: 3 });
	assert.equal(seen.length, 2, "old runtime no longer forwarded");
	assert.equal(controller.getRuntime(), second.runtime);
});

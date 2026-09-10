import { TurnInterruptController } from "../interrupt.js";
import type {
	InterruptStage,
	RuntimeLogger,
	TurnProgressEvent,
	TurnProgressEventMap,
} from "../types.js";

/**
 * The slice of `AgentRuntime` a {@link SessionController} drives. `AgentRuntime`
 * satisfies this structurally, and tests can supply a lightweight fake — the
 * controller never touches the terminal, the session store, or the tool
 * registry directly.
 */
export interface SessionControllerRuntime {
	/** Turn-progress event bus (subscribe + synthetic emit). */
	runner: SessionProgressBus;
	/** The turn driver (wraps the runner + session persistence). */
	turn: SessionTurnRunner;
	logger: RuntimeLogger;
}

/** The progress-event surface the controller needs from the runner. */
export interface SessionProgressBus {
	onProgress(listener: (event: TurnProgressEvent) => void): () => void;
	emitProgress(
		type: "interrupt_requested",
		payload: TurnProgressEventMap["interrupt_requested"],
	): void;
}

/** The turn driver the controller needs (a subset of `AgentTurn`). */
export interface SessionTurnRunner {
	runTurn(
		input: string,
		logger: RuntimeLogger,
		interruptController?: TurnInterruptController,
	): Promise<SessionTurnOutcome>;
}

/**
 * Outcome of one submitted turn. Mirrors `AgentTurn.runTurn`'s result: a
 * frontend only needs the terminal status, the final text, and (on failure)
 * the message to show.
 */
export type SessionTurnOutcome =
	| {
			ok: true;
			completionStatus: "completed" | "interrupted";
			outputText: string | null;
	  }
	| { ok: false; errorMessage: string };

/** Result of a {@link SessionController.requestInterrupt} call. */
export interface InterruptAck {
	/** True when the interrupt was newly accepted (a turn was running). */
	accepted: boolean;
	/** True when an interrupt was already in flight for this turn. */
	alreadyRequested: boolean;
	/** The stage the running turn was in, or `null` when idle. */
	stage: InterruptStage | null;
	/** The acknowledgement message emitted on the progress stream, if any. */
	message: string | null;
}

/**
 * UI-neutral orchestrator for one interactive session. It owns the turn
 * lifecycle and the per-turn interrupt controller — the pieces the REPL loop
 * used to wire by hand — and exposes a single progress-event stream plus an
 * `submit`/`requestInterrupt` control surface. A TUI and an HTTP/SSE frontend
 * can each hold one controller and drive the identical agent loop.
 *
 * The controller subscribes to its runtime's runner internally and re-broadcasts
 * to its own listeners, so a frontend subscribes once and keeps receiving
 * events across `setRuntime` swaps (e.g. `/resume`) without re-wiring.
 */
export class SessionController {
	private runtime: SessionControllerRuntime;
	private readonly listeners = new Set<(event: TurnProgressEvent) => void>();
	private unsubscribeRunner: () => void;
	private currentInterrupt: TurnInterruptController | null = null;

	constructor(runtime: SessionControllerRuntime) {
		this.runtime = runtime;
		this.unsubscribeRunner = this.subscribeToRuntime(runtime);
	}

	/** The runtime currently being driven. */
	getRuntime(): SessionControllerRuntime {
		return this.runtime;
	}

	/**
	 * Swap in a fresh runtime (e.g. after `/new` or `/resume`). Re-binds the
	 * internal runner subscription and drops any in-flight interrupt state;
	 * frontends keep their existing {@link onProgress} subscription.
	 */
	setRuntime(runtime: SessionControllerRuntime): void {
		this.unsubscribeRunner();
		this.runtime = runtime;
		this.currentInterrupt = null;
		this.unsubscribeRunner = this.subscribeToRuntime(runtime);
	}

	/**
	 * Subscribe to the session's turn-progress stream. Returns an unsubscribe
	 * function. The subscription survives {@link setRuntime}.
	 */
	onProgress(listener: (event: TurnProgressEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** True while a {@link submit} turn is in flight. */
	isTurnActive(): boolean {
		return this.currentInterrupt !== null;
	}

	/**
	 * Ask the in-flight turn to stop. Emits the synthetic
	 * `interrupt_requested` progress event the REPL used to emit inline, so any
	 * frontend sees the acknowledgement through the one event stream. A no-op
	 * (with `accepted: false`) when no turn is running.
	 */
	requestInterrupt(): InterruptAck {
		const controller = this.currentInterrupt;
		if (!controller) {
			return {
				accepted: false,
				alreadyRequested: false,
				stage: null,
				message: null,
			};
		}

		const interrupt = controller.requestInterrupt();
		if (!interrupt.accepted || interrupt.alreadyRequested) {
			return {
				accepted: interrupt.accepted,
				alreadyRequested: interrupt.alreadyRequested,
				stage: interrupt.stage,
				message: null,
			};
		}

		const message =
			interrupt.stage === "model"
				? "Cancelling current model request"
				: "Interrupt requested; waiting for current tool to finish";
		this.runtime.runner.emitProgress("interrupt_requested", {
			message,
			stage: interrupt.stage ?? undefined,
		});
		return {
			accepted: true,
			alreadyRequested: false,
			stage: interrupt.stage,
			message,
		};
	}

	/**
	 * Run one agent turn to completion. Owns the per-turn interrupt controller,
	 * so {@link requestInterrupt} targets exactly this turn while it runs.
	 */
	async submit(input: string): Promise<SessionTurnOutcome> {
		const interruptController = new TurnInterruptController();
		this.currentInterrupt = interruptController;
		try {
			const result = await this.runtime.turn.runTurn(
				input,
				this.runtime.logger,
				interruptController,
			);
			return result;
		} finally {
			this.currentInterrupt = null;
		}
	}

	private subscribeToRuntime(runtime: SessionControllerRuntime): () => void {
		return runtime.runner.onProgress((event) => {
			for (const listener of this.listeners) {
				listener(event);
			}
		});
	}
}

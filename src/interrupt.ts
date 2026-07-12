import type { InterruptSource, InterruptStage } from "./types.js";

export type TurnInterruptState =
	| "idle"
	| "running:model"
	| "running:tool"
	| "interrupt_requested"
	| "interrupted";

export class TurnInterruptedError extends Error {
	constructor(
		public readonly source: InterruptSource,
		public readonly stage: InterruptStage,
		message: string = "Turn interrupted.",
	) {
		super(message);
		this.name = "TurnInterruptedError";
	}
}

export class TurnInterruptController {
	private state: TurnInterruptState = "idle";
	private activeStage: InterruptStage | null = null;
	private interruptedStage: InterruptStage | null = null;
	private abortController = new AbortController();

	beginTurn(): void {
		this.state = "idle";
		this.activeStage = null;
		this.interruptedStage = null;
		this.abortController = new AbortController();
	}

	enterModel(): void {
		this.throwIfInterrupted();
		this.activeStage = "model";
		this.state = "running:model";
	}

	enterTool(): void {
		this.throwIfInterrupted();
		this.activeStage = "tool";
		this.state = "running:tool";
	}

	leaveActiveStage(): void {
		if (this.state === "interrupt_requested" && this.activeStage !== null) {
			this.markInterrupted(this.activeStage);
			return;
		}

		this.activeStage = null;
		if (this.state !== "interrupted") {
			this.state = "idle";
		}
	}

	requestInterrupt(): {
		accepted: boolean;
		stage: InterruptStage | null;
		alreadyRequested: boolean;
	} {
		if (this.state === "interrupted" || this.abortController.signal.aborted) {
			return {
				accepted: false,
				stage: this.activeStage ?? this.interruptedStage,
				alreadyRequested: true,
			};
		}

		const stage = this.activeStage;
		if (stage === null) {
			return {
				accepted: false,
				stage: null,
				alreadyRequested: false,
			};
		}

		this.state = "interrupt_requested";
		this.abortController.abort(new TurnInterruptedError("user_escape", stage));
		return {
			accepted: true,
			stage,
			alreadyRequested: false,
		};
	}

	isInterruptRequested(): boolean {
		return this.state === "interrupt_requested" || this.state === "interrupted";
	}

	throwIfInterrupted(): void {
		if (!this.isInterruptRequested()) {
			return;
		}

		throw new TurnInterruptedError(
			"user_escape",
			this.activeStage ?? this.interruptedStage ?? "tool",
		);
	}

	markInterrupted(stage: InterruptStage): void {
		this.interruptedStage = stage;
		this.activeStage = null;
		this.state = "interrupted";
	}

	getAbortSignal(): AbortSignal {
		return this.abortController.signal;
	}

	getState(): TurnInterruptState {
		return this.state;
	}

	getActiveStage(): InterruptStage | null {
		return this.activeStage;
	}

	getInterruptedStage(): InterruptStage | null {
		return this.interruptedStage;
	}
}

export function isTurnInterruptedError(
	error: unknown,
): error is TurnInterruptedError {
	return error instanceof TurnInterruptedError;
}

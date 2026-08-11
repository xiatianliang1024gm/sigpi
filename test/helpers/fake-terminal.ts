import type { Terminal } from "@earendil-works/pi-tui";

/**
 * Minimal in-memory {@link Terminal} for TUI tests: records every write and
 * lets the test drive input, resize, and the Kitty-protocol flag by hand.
 * Replaces the retired xterm-based `VirtualTerminal`.
 */
export class FakeTerminal implements Terminal {
	columns: number;
	rows: number;
	writes: string[] = [];
	inputHandler: ((data: string) => void) | null = null;
	resizeHandler: (() => void) | null = null;
	kittyActive = false;

	constructor(columns = 20, rows = 5) {
		this.columns = columns;
		this.rows = rows;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = null;
		this.resizeHandler = null;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get kittyProtocolActive(): boolean {
		return this.kittyActive;
	}

	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

	/** Simulate a terminal resize, then trigger the engine's resize handler. */
	resize(columns?: number, rows?: number): void {
		if (columns !== undefined) this.columns = columns;
		if (rows !== undefined) this.rows = rows;
		this.resizeHandler?.();
	}
}

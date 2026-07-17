import { stdin, stdout } from "node:process";
import type { ReadStream, WriteStream } from "node:tty";
import type { Terminal as PiTerminal } from "@earendil-works/pi-tui";

/**
 * Absolute 1-indexed cursor-positioning escape sequence (CSI row;col H).
 */
function moveToSequence(row: number, column: number): string {
	return `\x1B[${Math.max(1, row)};${Math.max(1, column)}H`;
}

/**
 * Escape sequence that clears `rows` lines starting at the current cursor and
 * returns the cursor to the starting row.
 */
function clearRenderedRowsSequence(rows: number): string {
	if (rows <= 0) {
		return "";
	}
	let sequence = "";
	for (let index = 0; index < rows; index += 1) {
		sequence += "\x1B[2K";
		if (index < rows - 1) {
			sequence += "\r\n";
		}
	}
	sequence += `\x1B[${rows}A`;
	return sequence;
}

/**
 * SigPi's terminal interface.
 *
 * It extends Pi-tui's {@link PiTerminal} so the same terminal object can be
 * consumed by both SigPi's TUI and Pi-tui's TUI, then adds the two SigPi-specific
 * operations that Pi-tui's Terminal does not provide:
 *
 * - `moveTo(row, column)` — absolute 1-indexed cursor positioning used by
 *   SigPi's frame diffing.
 * - `clearRenderedRows(rows)` — clears lines previously drawn by SigPi's
 *   inline renderer so the next frame can repaint them.
 */
export interface Terminal extends PiTerminal {
	moveTo(row: number, column: number): void;
	clearRenderedRows(rows?: number): void;
}

export class ProcessTerminal implements Terminal {
	private readonly input: ReadStream;
	private readonly output: WriteStream;
	private wasRaw = false;
	private inputHandler?: (chunk: string | Buffer) => void;
	private resizeHandler?: () => void;

	constructor(
		inputStream: ReadStream = stdin,
		outputStream: WriteStream = stdout,
	) {
		this.input = inputStream;
		this.output = outputStream;
	}

	get columns(): number {
		return Math.max(this.output.columns ?? 80, 1);
	}

	get rows(): number {
		return Math.max(this.output.rows ?? 24, 1);
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.wasRaw = this.input.isRaw;
		this.input.setEncoding("utf8");
		this.input.setRawMode(true);
		this.input.resume();

		this.inputHandler = (chunk) => {
			onInput(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		};
		this.resizeHandler = onResize;

		this.input.on("data", this.inputHandler);
		this.output.on("resize", this.resizeHandler);
		this.write("\x1B[?2004h");
		this.showCursor();
	}

	stop(): void {
		if (this.inputHandler) {
			this.input.off("data", this.inputHandler);
		}
		if (this.resizeHandler) {
			this.output.off("resize", this.resizeHandler);
		}

		this.write("\x1B[?2004l");
		this.showCursor();
		this.input.setRawMode(Boolean(this.wasRaw));
		this.input.pause();
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		// SigPi does not yet negotiate Kitty key release events, so there is
		// nothing to flush before exiting. The parameters mirror Pi-tui's
		// Terminal so the seam stays aligned.
		void maxMs;
		void idleMs;
	}

	write(data: string): void {
		this.output.write(data);
	}

	hideCursor(): void {
		this.write("\x1B[?25l");
	}

	showCursor(): void {
		this.write("\x1B[?25h");
	}

	clearScreen(): void {
		this.write("\x1B[2J\x1B[H");
	}

	clearLine(): void {
		this.write("\x1B[2K");
	}

	clearFromCursor(): void {
		this.write("\x1B[J");
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			this.write(`\x1B[${lines}B`);
		} else if (lines < 0) {
			this.write(`\x1B[${-lines}A`);
		}
	}

	setTitle(title: string): void {
		this.write(`\x1B]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		// SigPi does not render a terminal progress indicator yet.
		void active;
	}

	moveTo(row: number, column: number): void {
		this.write(moveToSequence(row, column));
	}

	clearRenderedRows(rows = 0): void {
		this.write(clearRenderedRowsSequence(rows));
	}
}

/**
 * Adapter that exposes SigPi's {@link Terminal} over a Pi-tui {@link PiTerminal}.
 *
 * Pi-tui's Terminal uses relative movement (`moveBy`) and has no notion of
 * SigPi's absolute `moveTo` or `clearRenderedRows`. This adapter delegates every
 * Pi-tui method to the wrapped terminal and implements the two SigPi-specific
 * operations on top, so a Pi-tui Terminal can drive SigPi's TUI unchanged.
 */
export class SigPiTerminal implements Terminal {
	constructor(private readonly inner: PiTerminal) {}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inner.start(onInput, onResize);
	}

	stop(): void {
		this.inner.stop();
	}

	async drainInput(maxMs?: number, idleMs?: number): Promise<void> {
		await this.inner.drainInput(maxMs, idleMs);
	}

	write(data: string): void {
		this.inner.write(data);
	}

	get columns(): number {
		return this.inner.columns;
	}

	get rows(): number {
		return this.inner.rows;
	}

	get kittyProtocolActive(): boolean {
		return this.inner.kittyProtocolActive;
	}

	moveBy(lines: number): void {
		this.inner.moveBy(lines);
	}

	hideCursor(): void {
		this.inner.hideCursor();
	}

	showCursor(): void {
		this.inner.showCursor();
	}

	clearLine(): void {
		this.inner.clearLine();
	}

	clearFromCursor(): void {
		this.inner.clearFromCursor();
	}

	clearScreen(): void {
		this.inner.clearScreen();
	}

	setTitle(title: string): void {
		this.inner.setTitle(title);
	}

	setProgress(active: boolean): void {
		this.inner.setProgress(active);
	}

	moveTo(row: number, column: number): void {
		this.write(moveToSequence(row, column));
	}

	clearRenderedRows(rows = 0): void {
		this.write(clearRenderedRowsSequence(rows));
	}
}

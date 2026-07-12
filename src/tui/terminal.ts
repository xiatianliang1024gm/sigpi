import { stdin, stdout } from "node:process";
import type { ReadStream, WriteStream } from "node:tty";

export interface Terminal {
	start(onInput: (data: string) => void, onResize: () => void): void;
	stop(): void;
	write(data: string): void;
	get columns(): number;
	get rows(): number;
	hideCursor(): void;
	showCursor(): void;
	clearScreen(): void;
	clearFromCursor(): void;
	moveTo(row: number, column: number): void;
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

	clearFromCursor(): void {
		this.write("\x1B[J");
	}

	moveTo(row: number, column: number): void {
		this.write(`\x1B[${Math.max(1, row)};${Math.max(1, column)}H`);
	}
}

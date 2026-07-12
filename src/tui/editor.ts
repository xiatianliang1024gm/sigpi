import { parseKey } from "./keys.js";
import { type Component, CURSOR_MARKER, type Focusable } from "./tui.js";
import { visibleWidth, wrapToWidth } from "./utils.js";

const BRACKETED_PASTE_START = "\x1B[200~";
const BRACKETED_PASTE_END = "\x1B[201~";

export interface EditorOptions {
	prompt?: string;
	placeholder?: string;
	showCursor?: boolean;
}

export class Editor implements Component, Focusable {
	public focused = false;
	public onSubmit?: (text: string) => void;
	public onCancel?: () => void;
	public onChange?: (text: string) => void;
	private text = "";
	private cursorIndex = 0;
	private pasteBuffer: string | null = null;

	constructor(private readonly options: EditorOptions = {}) {}

	getText(): string {
		return this.text;
	}

	getCursorIndex(): number {
		return this.cursorIndex;
	}

	setText(text: string): void {
		this.text = text;
		this.cursorIndex = text.length;
		this.onChange?.(this.text);
	}

	insertTextAtCursor(text: string): void {
		this.text =
			this.text.slice(0, this.cursorIndex) +
			text +
			this.text.slice(this.cursorIndex);
		this.cursorIndex += text.length;
		this.onChange?.(this.text);
	}

	handleInput(data: string): void {
		if (this.pasteBuffer !== null) {
			this.handleBracketedPasteData(data);
			return;
		}

		const pasteStartIndex = data.indexOf(BRACKETED_PASTE_START);
		if (pasteStartIndex !== -1) {
			const beforePaste = data.slice(0, pasteStartIndex);
			if (beforePaste) {
				this.handleInput(beforePaste);
			}
			this.pasteBuffer = "";
			this.handleBracketedPasteData(
				data.slice(pasteStartIndex + BRACKETED_PASTE_START.length),
			);
			return;
		}

		const key = parseKey(data);
		switch (key) {
			case "enter":
				this.onSubmit?.(this.text);
				return;
			case "ctrl+c":
			case "escape":
				this.onCancel?.();
				return;
			case "ctrl+d":
				if (this.text.length === 0) {
					this.onCancel?.();
				}
				return;
			case "backspace":
				this.deleteBeforeCursor();
				return;
			case "delete":
				this.deleteAfterCursor();
				return;
			case "left":
				this.cursorIndex = getPreviousCodePointIndex(
					this.text,
					this.cursorIndex,
				);
				return;
			case "right":
				this.cursorIndex = getNextCodePointIndex(this.text, this.cursorIndex);
				return;
			case "home":
				this.cursorIndex = 0;
				return;
			case "end":
				this.cursorIndex = this.text.length;
				return;
			default:
				break;
		}

		if (key !== null) {
			return;
		}

		for (const char of Array.from(data)) {
			if (isPrintableChar(char)) {
				this.insertTextAtCursor(char);
			}
		}
	}

	private handleBracketedPasteData(data: string): void {
		const combined = `${this.pasteBuffer ?? ""}${data}`;
		const pasteEndIndex = combined.indexOf(BRACKETED_PASTE_END);
		if (pasteEndIndex === -1) {
			this.pasteBuffer = combined;
			return;
		}

		const pasted = combined.slice(0, pasteEndIndex);
		const afterPaste = combined.slice(
			pasteEndIndex + BRACKETED_PASTE_END.length,
		);
		this.pasteBuffer = null;
		this.insertTextAtCursor(pasted);
		if (afterPaste) {
			this.handleInput(afterPaste);
		}
	}

	render(width: number): string[] {
		const prompt = this.options.prompt ?? "> ";
		const text = this.text || this.options.placeholder || "";
		const cursorMarker = this.focused ? CURSOR_MARKER : "";
		const beforeCursor = this.text.slice(0, this.cursorIndex);
		const afterCursor = this.text.slice(this.cursorIndex);
		const renderedText = this.text
			? `${beforeCursor}${cursorMarker}${afterCursor}`
			: `${cursorMarker}${text}`;

		return renderWrappedEditorLines({
			prompt,
			text: renderedText,
			width,
		});
	}

	private deleteBeforeCursor(): void {
		if (this.cursorIndex === 0) {
			return;
		}

		const previousIndex = getPreviousCodePointIndex(
			this.text,
			this.cursorIndex,
		);
		this.text =
			this.text.slice(0, previousIndex) + this.text.slice(this.cursorIndex);
		this.cursorIndex = previousIndex;
		this.onChange?.(this.text);
	}

	private deleteAfterCursor(): void {
		if (this.cursorIndex >= this.text.length) {
			return;
		}

		const nextIndex = getNextCodePointIndex(this.text, this.cursorIndex);
		this.text =
			this.text.slice(0, this.cursorIndex) + this.text.slice(nextIndex);
		this.onChange?.(this.text);
	}
}

export function renderWrappedEditorLines(args: {
	prompt: string;
	text: string;
	width: number;
}): string[] {
	const firstLineWidth = Math.max(1, args.width - visibleWidth(args.prompt));
	const continuationWidth = Math.max(1, args.width);
	const logicalLines = args.text.split("\n");
	const lines: string[] = [];

	for (const [index, logicalLine] of logicalLines.entries()) {
		const prefix = index === 0 ? args.prompt : "";
		const availableWidth = index === 0 ? firstLineWidth : continuationWidth;
		const wrapped = wrapToWidth(logicalLine, availableWidth);

		for (const [wrappedIndex, line] of wrapped.entries()) {
			lines.push(wrappedIndex === 0 ? `${prefix}${line}` : line);
		}
	}

	return lines.length > 0 ? lines : [args.prompt];
}

export function getCursorColumn(
	prompt: string,
	text: string,
	cursorIndex: number,
): number {
	return visibleWidth(prompt) + visibleWidth(text.slice(0, cursorIndex));
}

function getPreviousCodePointIndex(value: string, index: number): number {
	if (index <= 0) {
		return 0;
	}

	const previous = Array.from(value.slice(0, index)).pop();
	return index - (previous?.length ?? 1);
}

function getNextCodePointIndex(value: string, index: number): number {
	if (index >= value.length) {
		return value.length;
	}

	return index + (Array.from(value.slice(index))[0]?.length ?? 1);
}

function isPrintableChar(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return (
		codePoint !== undefined &&
		codePoint >= 32 &&
		codePoint !== 127 &&
		char !== "\x1B"
	);
}

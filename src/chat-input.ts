import { stdin as processInput, stdout as processOutput } from "node:process";
import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import {
	type ChatCommandMetadata,
	getChatCommandSuggestions,
} from "./chat-commands.js";
import type { InputHistory } from "./input-history.js";
import {
	type Component,
	Editor,
	moveSelectedIndex,
	ProcessTerminal,
	parseKey,
	type Terminal,
	Tui,
	truncateToWidth,
} from "./tui/index.js";

export interface ChatInputOptions {
	prompt?: string;
	input?: ReadStream;
	output?: WriteStream;
	commands?: readonly ChatCommandMetadata[];
	maxSuggestions?: number;
	statusBarText?: string;
	/** Shared, process-scoped recall buffer for `↑`/`↓` history. */
	inputHistory?: InputHistory;
}

/**
 * Bridges an {@link Editor} to a shared {@link InputHistory} buffer. The live
 * draft is preserved as a distinct slot; `↑`/`↓` recall history until the
 * recalled line is edited, after which the arrows fall through to in-editor
 * vertical cursor movement (so multiline editing still works).
 */
class HistoryNavigator {
	private draft = "";
	private editedSinceRecall = false;

	constructor(
		private readonly editor: Editor,
		private readonly history: InputHistory,
	) {}

	/** Handle an up/down arrow. Returns `true` when the arrow was consumed for recall. */
	handleArrow(direction: "up" | "down"): boolean {
		if (this.editedSinceRecall) {
			return false;
		}

		const entry =
			direction === "up" ? this.history.prev() : this.history.next();
		if (entry !== null) {
			this.editor.setText(entry);
		} else if (direction === "down") {
			this.editedSinceRecall = false;
			this.editor.setText(this.draft);
		}

		return true;
	}

	/** Track draft/edited state from the editor's `onChange`. */
	notifyTextChanged(): void {
		const current = this.history.current();
		if (current !== null && this.editor.getText() !== current) {
			// Editing a recalled line drops it back to the draft slot (Story 13).
			this.editedSinceRecall = true;
			this.draft = this.editor.getText();
			this.history.resetToDraft();
		} else if (current === null) {
			this.draft = this.editor.getText();
		}
	}
}

export interface EscInterruptListenerOptions {
	input?: ReadStream;
	output?: WriteStream;
	onEscape: () => void;
}

export interface RunningTurnInputListenerOptions {
	prompt?: string;
	input?: ReadStream;
	output?: WriteStream;
	statusBarText?: string;
	onEscape: () => void;
	onSubmit: (text: string) => void;
	/** Shared, process-scoped recall buffer for `↑`/`↓` history. */
	inputHistory?: InputHistory;
}

export interface RunningTurnInputListenerHandle {
	stop(): void;
	setStatusBarText(value: string | null): void;
	withSuspendedRendering<T>(operation: () => T): T;
}

class InlineTerminal implements Terminal {
	private renderedRows = 0;
	private currentRow = 1;

	constructor(private readonly inner: Terminal) {}

	get columns(): number {
		return this.inner.columns;
	}

	get rows(): number {
		return Math.max(1, this.inner.rows - 1);
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inner.start(onInput, onResize);
	}

	stop(): void {
		if (this.renderedRows > 0) {
			this.moveTo(this.renderedRows + 1, 1);
			this.inner.clearFromCursor();
		}
		this.inner.stop();
	}

	write(data: string): void {
		this.inner.write(data);
	}

	hideCursor(): void {
		this.inner.hideCursor();
	}

	showCursor(): void {
		this.inner.showCursor();
	}

	clearScreen(): void {
		this.inner.write("\r\x1B[J");
		this.renderedRows = 0;
		this.currentRow = 1;
	}

	clearFromCursor(): void {
		this.inner.clearFromCursor();
	}

	clearRenderedRows(): void {
		if (this.renderedRows === 0) {
			return;
		}

		this.moveTo(1, 1);
		this.inner.clearFromCursor();
		this.renderedRows = 0;
		this.currentRow = 1;
	}

	resetTracking(): void {
		this.renderedRows = 0;
		this.currentRow = 1;
	}

	moveTo(row: number, column: number): void {
		const previousRenderedRows = this.renderedRows;
		if (row > this.renderedRows) {
			this.renderedRows = row;
		}

		this.inner.write("\r");
		const rowDelta = row - this.currentRow;
		if (rowDelta > 0) {
			const existingRowsBelow = Math.max(
				0,
				previousRenderedRows - this.currentRow,
			);
			const existingMove = Math.min(rowDelta, existingRowsBelow);
			if (existingMove > 0) {
				this.inner.write(`\x1B[${existingMove}B`);
			}
			const newRows = rowDelta - existingMove;
			if (newRows > 0) {
				this.inner.write("\n".repeat(newRows));
			}
		} else if (rowDelta < 0) {
			this.inner.write(`\x1B[${Math.abs(rowDelta)}A`);
		}
		this.currentRow = row;
		if (column > 1) {
			this.inner.write(`\x1B[${column - 1}C`);
		}
	}
}

class ChatInputComponent implements Component {
	private readonly editor: Editor;
	private readonly history: HistoryNavigator | null;
	private selectedSuggestionIndex = 0;
	private suggestionSelectionActive = false;

	constructor(
		private readonly args: {
			prompt: string;
			commands: readonly ChatCommandMetadata[];
			maxSuggestions: number;
			onFinish: (value: string | null) => void;
			inputHistory?: InputHistory;
		},
	) {
		this.editor = new Editor({ prompt: args.prompt });
		this.history = args.inputHistory
			? new HistoryNavigator(this.editor, args.inputHistory)
			: null;
		this.editor.onSubmit = (text) => {
			if (!text.trim()) {
				this.editor.setText("");
				return;
			}
			args.onFinish(text);
		};
		this.editor.onCancel = () => args.onFinish(null);
		this.editor.onChange = () => {
			this.selectedSuggestionIndex = 0;
			this.suggestionSelectionActive = false;
			this.history?.notifyTextChanged();
		};
		this.editor.focused = true;
	}

	handleInput(data: string): void {
		const key = parseKey(data);
		const suggestions = this.getSuggestions();

		if ((key === "up" || key === "down") && suggestions.length > 0) {
			this.selectedSuggestionIndex = moveSelectedIndex(
				this.selectedSuggestionIndex,
				suggestions.length,
				key === "up" ? -1 : 1,
			);
			this.suggestionSelectionActive = true;
			return;
		}

		// Tab completes the selected suggestion into the input buffer. It fills
		// (never submits) so the user can keep typing or press Enter. Tab is
		// swallowed even with no suggestions to avoid inserting a literal tab.
		if (key === "tab") {
			const selected = suggestions[this.selectedSuggestionIndex];
			if (selected) {
				this.editor.setText(`${selected.name} `);
			}
			return;
		}

		if (key === "enter" && this.suggestionSelectionActive) {
			const selected = suggestions[this.selectedSuggestionIndex];
			if (selected) {
				this.args.onFinish(selected.name);
				return;
			}
		}

		if (key === "enter" && suggestions.length === 1) {
			this.args.onFinish(suggestions[0].name);
			return;
		}

		if (
			(key === "up" || key === "down") &&
			this.history?.handleArrow(key) === true
		) {
			return;
		}

		this.editor.handleInput(data);
	}

	render(width: number): string[] {
		const text = this.editor.getText();
		const lines = this.editor.render(width);
		const suggestions = this.getSuggestions();

		if (!text.includes("\n")) {
			this.selectedSuggestionIndex = moveSelectedIndex(
				this.selectedSuggestionIndex,
				suggestions.length,
				0,
			);
			for (const [index, suggestion] of suggestions.entries()) {
				const marker = index === this.selectedSuggestionIndex ? "> " : "  ";
				lines.push(
					truncateToWidth(
						`${marker}${suggestion.name} - ${suggestion.description}`,
						width,
					),
				);
			}
		}

		return lines;
	}

	private getSuggestions(): ChatCommandMetadata[] {
		return getChatCommandSuggestions(
			this.editor.getText(),
			this.args.commands,
			this.args.maxSuggestions,
		);
	}
}

class RunningTurnInputComponent implements Component {
	private readonly editor: Editor;
	private readonly history: HistoryNavigator | null;
	private submittedText: string | null = null;

	constructor(args: {
		prompt: string;
		onEscape: () => void;
		onSubmit: (text: string) => void;
		inputHistory?: InputHistory;
	}) {
		this.editor = new Editor({ prompt: args.prompt });
		this.history = args.inputHistory
			? new HistoryNavigator(this.editor, args.inputHistory)
			: null;
		this.editor.onSubmit = (text) => {
			if (!text.trim()) {
				return;
			}
			this.submittedText = text;
			this.editor.focused = false;
			args.onSubmit(text);
		};
		this.editor.onCancel = args.onEscape;
		this.editor.onChange = () => {
			this.history?.notifyTextChanged();
		};
		this.editor.focused = true;
	}

	getText(): string {
		return this.editor.getText();
	}

	hasSubmittedText(): boolean {
		return this.submittedText !== null;
	}

	handleInput(data: string): void {
		if (this.submittedText !== null) {
			return;
		}
		const key = parseKey(data);
		if (
			(key === "up" || key === "down") &&
			this.history?.handleArrow(key) === true
		) {
			return;
		}
		this.editor.handleInput(data);
	}

	render(width: number): string[] {
		if (this.submittedText !== null) {
			return [];
		}
		if (!this.editor.getText()) {
			return [];
		}
		return this.editor.render(width);
	}

	shouldRenderAfterInput(): boolean {
		return this.submittedText === null;
	}
}

export async function readChatInput(
	args?: ChatInputOptions,
): Promise<string | null> {
	const prompt = args?.prompt ?? "> ";
	const input = args?.input ?? processInput;
	const output = args?.output ?? processOutput;
	const commands = args?.commands ?? [];
	const maxSuggestions = args?.maxSuggestions ?? 5;

	if (!input.isTTY || !output.isTTY) {
		const rl = createInterface({ input, output });
		try {
			return await rl.question(prompt);
		} finally {
			rl.close();
		}
	}

	return new Promise<string | null>((resolve) => {
		const terminal = new InlineTerminal(new ProcessTerminal(input, output));
		const tui = new Tui(terminal, { clearOnStart: false, fillHeight: false });
		let settled = false;
		const finish = (value: string | null) => {
			if (settled) {
				return;
			}
			settled = true;
			terminal.clearRenderedRows();
			tui.stop();
			if (value !== null) {
				output.write(`${prompt}${value}\n`);
			}
			resolve(value);
		};
		const component = new ChatInputComponent({
			prompt,
			commands,
			maxSuggestions,
			onFinish: finish,
			inputHistory: args?.inputHistory,
		});

		tui.setStatusBar(args?.statusBarText ?? null);
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
	});
}

export function startEscInterruptListener(
	options: EscInterruptListenerOptions,
): (() => void) | null {
	const handle = startRunningTurnInputListener({
		...options,
		onSubmit: () => {},
	});
	return handle ? () => handle.stop() : null;
}

export function startRunningTurnInputListener(
	options: RunningTurnInputListenerOptions,
): RunningTurnInputListenerHandle | null {
	const input = options.input ?? processInput;
	const output = options.output ?? processOutput;
	const prompt = options.prompt ?? "> ";

	if (!input.isTTY || !output.isTTY) {
		return null;
	}

	const terminal = new InlineTerminal(new ProcessTerminal(input, output));
	const tui = new Tui(terminal, { clearOnStart: false, fillHeight: false });
	const component = new RunningTurnInputComponent({
		prompt,
		onEscape: options.onEscape,
		onSubmit: (text) => {
			terminal.clearRenderedRows();
			output.write(`${prompt}${text}\n`);
			options.onSubmit(text);
		},
		inputHistory: options.inputHistory,
	});

	tui.setStatusBar(options.statusBarText ?? null);
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();

	let stopped = false;
	const stop = () => {
		if (stopped) {
			return;
		}
		stopped = true;
		terminal.clearRenderedRows();
		tui.stop();
	};

	return {
		stop,
		setStatusBarText: (value) => {
			tui.setStatusBar(value);
		},
		withSuspendedRendering: (operation) => {
			if (component.hasSubmittedText()) {
				return operation();
			}
			terminal.clearRenderedRows();
			const result = operation();
			if (!stopped && !component.hasSubmittedText()) {
				terminal.resetTracking();
				tui.resetFrame();
				tui.forceRender();
			}
			return result;
		},
	};
}

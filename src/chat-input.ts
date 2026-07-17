import { stdin as processInput, stdout as processOutput } from "node:process";
import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import {
	CURSOR_MARKER as PI_CURSOR_MARKER,
	type Component as PiComponent,
	type Terminal,
	TUI,
} from "@earendil-works/pi-tui";
import {
	type ChatCommandMetadata,
	getChatCommandSuggestions,
} from "./chat-commands.js";
import type { InputHistory } from "./input-history.js";
import {
	Editor,
	CURSOR_MARKER as FORK_CURSOR_MARKER,
	moveSelectedIndex,
	ProcessTerminal,
	parseKey,
	type StatusBarComponent,
	truncateToWidth,
} from "./tui/index.js";
import type { ReasoningStreamComponent } from "./tui/reasoning-stream.js";
import { truncateLeftToWidth } from "./tui/utils.js";

export interface ChatInputOptions {
	prompt?: string;
	input?: ReadStream;
	output?: WriteStream;
	commands?: readonly ChatCommandMetadata[];
	maxSuggestions?: number;
	statusBarText?: string;
	/** Pi-tui status bar footer component, used in preference to `statusBarText`. */
	statusBarComponent?: StatusBarComponent | null;
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
	/**
	 * Set when the user edits a recalled line. While true, `↑`/`↓` fall through
	 * to in-editor vertical cursor movement (so multiline editing still works,
	 * Story 13) and slash suggestions stay suppressed. It clears once the user
	 * returns to a clean draft slot, so recall is never permanently stuck.
	 */
	private editingRecalled = false;

	constructor(
		private readonly editor: Editor,
		private readonly history: InputHistory,
	) {}

	/**
	 * Whether the component is currently in the recall context — i.e. the last
	 * `↑`/`↓` entered history navigation, or the user is mid-edit of a recalled
	 * line. While recalling, slash-command suggestions are suppressed so the
	 * arrows keep walking history instead of getting trapped in the suggestion
	 * menu (e.g. a recalled `/skill:foo`).
	 */
	isRecalling(): boolean {
		return !this.history.isAtDraft || this.editingRecalled;
	}

	/** Handle an up/down arrow. Returns `true` when the arrow was consumed for recall. */
	handleArrow(direction: "up" | "down"): boolean {
		if (this.editingRecalled) {
			// Editing a recalled line: arrows move the cursor, not history.
			return false;
		}

		const entry =
			direction === "up" ? this.history.prev() : this.history.next();
		if (entry !== null) {
			this.editor.setText(entry);
		} else if (direction === "down") {
			this.editor.setText(this.draft);
		}

		return true;
	}

	/** Track draft/edited state from the editor's `onChange`. */
	notifyTextChanged(): void {
		if (this.history.isAtDraft) {
			// Back on the clean draft slot: leave the recall context entirely.
			this.editingRecalled = false;
			this.draft = this.editor.getText();
			return;
		}

		const current = this.history.current();
		if (current !== null && this.editor.getText() !== current) {
			// Editing a recalled line drops it back to the draft slot (Story 13).
			this.editingRecalled = true;
			this.draft = this.editor.getText();
			this.history.resetToDraft();
		}
	}
}

/**
 * Inline terminal adapter for Pi-tui's {@link TUI}.
 *
 * Pi-tui's `TUI` renders from the current cursor position and never clears the
 * screen, which is exactly the inline behaviour the chat prompt needs (the
 * transcript above must stay visible). This adapter wraps a Pi-tui
 * {@link Terminal} and adds the SigPi-specific `clearRenderedRows()` cleanup
 * used to wipe just the rendered input area on submit/cancel so the final echo
 * prints on a clean line.
 */
class InlineTerminal implements Terminal {
	/** Number of rows the current inline frame occupies (input + suggestions + status bar). */
	lastHeight = 0;

	constructor(private readonly inner: Terminal) {}

	get columns(): number {
		return this.inner.columns;
	}

	get rows(): number {
		return this.inner.rows;
	}

	get kittyProtocolActive(): boolean {
		return this.inner.kittyProtocolActive;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inner.start(onInput, onResize);
	}

	stop(): void {
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
		this.inner.clearScreen();
	}

	clearLine(): void {
		this.inner.clearLine();
	}

	clearFromCursor(): void {
		this.inner.clearFromCursor();
	}

	moveBy(lines: number): void {
		this.inner.moveBy(lines);
	}

	drainInput(maxMs?: number, idleMs?: number): Promise<void> {
		return this.inner.drainInput(maxMs, idleMs);
	}

	setTitle(title: string): void {
		this.inner.setTitle(title);
	}

	setProgress(active: boolean): void {
		this.inner.setProgress(active);
	}

	/** Clear the rendered inline input rows so a fresh prompt can be echoed. */
	clearRenderedRows(rows?: number): void {
		const height = rows ?? this.lastHeight;
		if (height <= 0) {
			return;
		}
		this.moveBy(-(height - 1));
		this.write("\r");
		this.clearFromCursor();
		this.lastHeight = 0;
	}
}

/**
 * Minimal Pi-tui {@link Component} that renders a raw status-bar string. The
 * `statusBarComponent` path is preferred in production; this exists for callers
 * that still pass a plain `statusBarText`.
 */
class RawStatusBarComponent implements PiComponent {
	constructor(private readonly text: string) {}

	render(width: number): string[] {
		return [truncateLeftToWidth(this.text, width)];
	}

	invalidate(): void {}
}

class ChatInputComponent implements PiComponent {
	private readonly editor: Editor;
	private readonly history: HistoryNavigator | null;
	private selectedSuggestionIndex = 0;
	private suggestionSelectionActive = false;
	/** Rows this component contributed to the last frame (input + suggestions). */
	frameHeight = 0;

	constructor(
		private readonly args: {
			prompt: string;
			commands: readonly ChatCommandMetadata[];
			maxSuggestions: number;
			onFinish: (value: string | null) => void;
			inputHistory?: InputHistory;
		},
		private readonly renderNow: () => void,
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
		try {
			const key = parseKey(data);
			const suggestions = this.getActiveSuggestions();

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
			//swallowed even with no suggestions to avoid inserting a literal tab.
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
		} finally {
			this.renderNow();
		}
	}

	render(width: number): string[] {
		const text = this.editor.getText();
		const lines = this.editor.render(width);
		const suggestions = this.getActiveSuggestions();

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

		this.frameHeight = lines.length;
		// Convert the fork Editor's cursor marker to Pi-tui's so the TUI can
		// position the real hardware cursor for IME candidate windows.
		return lines.map((line) =>
			line.split(FORK_CURSOR_MARKER).join(PI_CURSOR_MARKER),
		);
	}

	invalidate(): void {}

	private getSuggestions(): ChatCommandMetadata[] {
		return getChatCommandSuggestions(
			this.editor.getText(),
			this.args.commands,
			this.args.maxSuggestions,
		);
	}

	/**
	 * Suggestions to show right now. While recalling history (a recalled entry is
	 * showing or being edited) slash suggestions are suppressed so `↑`/`↓` keep
	 * walking history instead of getting trapped in the suggestion menu.
	 */
	private getActiveSuggestions(): ChatCommandMetadata[] {
		if (this.history?.isRecalling() ?? false) {
			return [];
		}

		return this.getSuggestions();
	}
}

class RunningTurnInputComponent implements PiComponent {
	private readonly editor: Editor;
	private readonly history: HistoryNavigator | null;
	private submittedText: string | null = null;
	/** Rows this component contributed to the last frame (input only). */
	frameHeight = 0;

	constructor(
		args: {
			prompt: string;
			onEscape: () => void;
			onSubmit: (text: string) => void;
			inputHistory?: InputHistory;
		},
		private readonly renderNow: () => void,
	) {
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
		try {
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
		} finally {
			this.renderNow();
		}
	}

	render(width: number): string[] {
		if (this.submittedText !== null) {
			return [];
		}
		const lines = this.editor.render(width);
		this.frameHeight = lines.length;
		return lines.map((line) =>
			line.split(FORK_CURSOR_MARKER).join(PI_CURSOR_MARKER),
		);
	}

	invalidate(): void {}
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
	/** Pi-tui status bar footer component, used in preference to `statusBarText`. */
	statusBarComponent?: StatusBarComponent | null;
	onEscape: () => void;
	onSubmit: (text: string) => void;
	/** Shared, process-scoped recall buffer for `↑`/`↓` history. */
	inputHistory?: InputHistory;
	/**
	 * Optional live reasoning/content stream. When provided, the listener
	 * renders it above the input line so streamed model output is visible
	 * in-place (spec-0020). The caller feeds it via
	 * {@link RunningTurnInputListenerHandle.appendReasoning} /
	 * {@link RunningTurnInputListenerHandle.appendContent}.
	 */
	reasoningStream?: ReasoningStreamComponent;
}

export interface RunningTurnInputListenerHandle {
	stop(): void;
	setStatusBarComponent(value: StatusBarComponent | null): void;
	/** Append a streamed reasoning fragment to the live view (spec-0020). */
	appendReasoning(text: string): void;
	/** Append a streamed content fragment to the live view (spec-0020). */
	appendContent(text: string): void;
	/** Clear the live reasoning/content preview (spec-0020). */
	clearReasoningStream(): void;
	withSuspendedRendering<T>(operation: () => T): T;
}

function totalFrameHeight(
	component: ChatInputComponent | RunningTurnInputComponent,
	statusBar: StatusBarComponent | RawStatusBarComponent | null,
	terminal: Terminal,
): number {
	const statusHeight = statusBar
		? statusBar.render(terminal.columns).length
		: 0;
	return component.frameHeight + statusHeight;
}

/**
 * Pi-tui's {@link TUI} coalesces renders to the next tick, but the chat prompt
 * must repaint synchronously on every keystroke so the inline transcript shows
 * each intermediate frame (slash suggestions appearing/disappearing, etc.) — the
 * same behaviour the fork `Tui.renderNow()` gave. Pi-tui exposes no public
 * synchronous render, so we call its private diff pass directly. `doRender` early
 * returns once the TUI is stopped, so it is a safe no-op after submit/cancel.
 */
function renderInlineNow(tui: TUI): void {
	(tui as unknown as { doRender(): void }).doRender();
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
		// Pi-tui renders inline from the current cursor and never clears the
		// screen; disable shrink-clearing so the transcript above is preserved.
		const tui = new TUI(terminal, true);
		tui.setClearOnShrink(false);
		let settled = false;
		let statusBar: StatusBarComponent | RawStatusBarComponent | null = null;

		const finish = (value: string | null) => {
			if (settled) {
				return;
			}
			settled = true;
			terminal.clearRenderedRows(
				totalFrameHeight(component, statusBar, terminal),
			);
			tui.stop();
			if (value !== null) {
				output.write(`${prompt}${value}\n`);
			}
			resolve(value);
		};

		const component = new ChatInputComponent(
			{
				prompt,
				commands,
				maxSuggestions,
				onFinish: finish,
				inputHistory: args?.inputHistory,
			},
			() => renderInlineNow(tui),
		);

		if (args?.statusBarComponent) {
			statusBar = args.statusBarComponent;
		} else if (args?.statusBarText) {
			statusBar = new RawStatusBarComponent(args.statusBarText);
		}
		tui.addChild(component);
		if (statusBar) {
			tui.addChild(statusBar);
		}
		tui.setFocus(component);
		tui.start();
		// Paint the initial frame synchronously (Pi-tui schedules the first
		// render on the next tick; the fork painted it immediately, and tests
		// expect the prompt/status bar to be visible before any input).
		renderInlineNow(tui);
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
	const tui = new TUI(terminal, true);
	tui.setClearOnShrink(false);
	let statusBar: StatusBarComponent | RawStatusBarComponent | null = null;

	const component = new RunningTurnInputComponent(
		{
			prompt,
			onEscape: options.onEscape,
			onSubmit: (text) => {
				terminal.clearRenderedRows(
					totalFrameHeight(component, statusBar, terminal),
				);
				output.write(`${prompt}${text}\n`);
				options.onSubmit(text);
			},
			inputHistory: options.inputHistory,
		},
		() => renderInlineNow(tui),
	);

	if (options.statusBarComponent) {
		statusBar = options.statusBarComponent;
	} else if (options.statusBarText) {
		statusBar = new RawStatusBarComponent(options.statusBarText);
	}
	if (options.reasoningStream) {
		tui.addChild(options.reasoningStream);
	}
	tui.addChild(component);
	if (statusBar) {
		tui.addChild(statusBar);
	}
	tui.setFocus(component);
	tui.start();
	// Paint the initial frame synchronously (see readChatInput for rationale).
	renderInlineNow(tui);

	let stopped = false;
	let currentStatusBar = statusBar;
	// Coalesce rapid streaming deltas into periodic diff-repaints. Each delta
	// appends to the component and schedules at most one repaint per frame
	// budget, so a burst of frames repaints once instead of flickering on every
	// token (spec-0020 follow-up).
	let renderTimer: ReturnType<typeof setTimeout> | null = null;
	const scheduleRender = () => {
		if (stopped || renderTimer !== null) {
			return;
		}
		renderTimer = setTimeout(() => {
			renderTimer = null;
			if (!stopped) {
				tui.requestRender();
			}
		}, 33);
	};
	const stop = () => {
		if (stopped) {
			return;
		}
		stopped = true;
		if (renderTimer !== null) {
			clearTimeout(renderTimer);
			renderTimer = null;
		}
		terminal.clearRenderedRows(
			totalFrameHeight(component, currentStatusBar, terminal),
		);
		tui.stop();
	};

	return {
		stop,
		setStatusBarComponent: (value) => {
			if (currentStatusBar && currentStatusBar !== value) {
				tui.removeChild(currentStatusBar);
			}
			currentStatusBar = value;
			if (value) {
				tui.addChild(value);
			}
			tui.requestRender();
		},
		appendReasoning: (text: string) => {
			if (!options.reasoningStream || stopped) {
				return;
			}
			options.reasoningStream.appendReasoning(text);
			// Diff-based, coalesced repaint (not forceRender): forceRender wipes
			// the previous frame, which would repaint the whole screen on every
			// delta and cause visible flicker (spec-0020 follow-up).
			scheduleRender();
		},
		appendContent: (text: string) => {
			if (!options.reasoningStream || stopped) {
				return;
			}
			options.reasoningStream.appendContent(text);
			scheduleRender();
		},
		clearReasoningStream: () => {
			if (!options.reasoningStream || stopped) {
				return;
			}
			options.reasoningStream.clear();
			tui.requestRender();
		},
		withSuspendedRendering: (operation) => {
			if (component.hasSubmittedText()) {
				return operation();
			}
			terminal.clearRenderedRows(
				totalFrameHeight(component, currentStatusBar, terminal),
			);
			tui.invalidate();
			const result = operation();
			if (!stopped && !component.hasSubmittedText()) {
				tui.requestRender(true);
			}
			return result;
		},
	};
}

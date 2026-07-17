import { stdin as processInput, stdout as processOutput } from "node:process";
import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import { Editor, type EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { ChatCommandMetadata } from "./chat-commands.js";
import type { ReasoningStreamComponent } from "./tui/reasoning-stream.js";
import { ProcessTerminal, SigPiTerminal } from "./tui/sigpi-terminal.js";
import { SlashAutocompleteProvider } from "./tui/slash-autocomplete.js";
import { StatusBarComponent } from "./tui/status-bar.js";

export interface ChatInputOptions {
	prompt?: string;
	input?: ReadStream;
	output?: WriteStream;
	commands?: readonly ChatCommandMetadata[];
	maxSuggestions?: number;
	statusBarText?: string;
	/** Pi-tui status bar footer component, used in preference to `statusBarText`. */
	statusBarComponent?: StatusBarComponent | null;
}

/**
 * Minimal editor theme. SigPi does not draw an editor border, so the border
 * color is a no-op and the select-list theme is left to Pi-tui defaults.
 */
const EDITOR_THEME: EditorTheme = {
	borderColor: (str: string) => str,
	selectList: {
		selectedPrefix: (str: string) => str,
		selectedText: (str: string) => str,
		description: (str: string) => str,
		scrollInfo: (str: string) => str,
		noMatch: (str: string) => str,
	},
};

/**
 * Pi-tui's {@link TUI} coalesces renders to the next tick, but the chat prompt
 * must repaint synchronously on every keystroke so the inline transcript shows
 * each intermediate frame (slash suggestions appearing/disappearing, etc.).
 * Pi-tui exposes no public synchronous render, so we call its private diff pass
 * directly. `doRender` early-returns once the TUI is stopped, so it is a safe
 * no-op after submit/cancel.
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

	if (!input.isTTY || !output.isTTY) {
		const rl = createInterface({ input, output });
		try {
			return await rl.question(prompt);
		} finally {
			rl.close();
		}
	}

	return new Promise<string | null>((resolve) => {
		const terminal = new SigPiTerminal(new ProcessTerminal(input, output));
		// Pi-tui renders inline from the current cursor and never clears the
		// screen; disable shrink-clearing so the transcript above is preserved.
		const tui = new TUI(terminal, true);
		tui.setClearOnShrink(false);
		let settled = false;

		const finish = (value: string | null) => {
			if (settled) {
				return;
			}
			settled = true;
			tui.stop();
			if (value !== null) {
				output.write(`${prompt}${value}\n`);
			}
			resolve(value);
		};

		const editor = new Editor(tui, EDITOR_THEME, { paddingX: 0 });
		editor.setAutocompleteProvider(
			new SlashAutocompleteProvider(
				commands.map((command) => ({
					name: command.name,
					description: command.description,
				})),
				process.cwd(),
			),
		);
		editor.onSubmit = (text) => {
			if (!text.trim()) {
				return;
			}
			editor.addToHistory(text);
			finish(text);
		};

		let statusBar: StatusBarComponent | null = null;
		if (args?.statusBarComponent) {
			statusBar = args.statusBarComponent;
		} else if (args?.statusBarText) {
			statusBar = new StatusBarComponent();
			statusBar.setModel({
				modelName: "",
				limit: 0,
				usedTokens: null,
				usage: null,
				cwd: args.statusBarText ?? "",
				branch: null,
			});
		}
		tui.addChild(editor);
		if (statusBar) {
			tui.addChild(statusBar);
		}
		tui.setFocus(editor);
		tui.start();
		// Esc / Ctrl+C cancels the prompt and resolves with `null`.
		tui.addInputListener((data) => {
			if (data === "\x1B" || data === "\u0003") {
				finish(null);
			}
			return undefined;
		});
		// Paint the initial frame synchronously (Pi-tui schedules the first
		// render on the next tick; tests expect the prompt to be visible before
		// any input).
		renderInlineNow(tui);
	});
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

	const terminal = new SigPiTerminal(new ProcessTerminal(input, output));
	// Pi-tui renders inline from the current cursor and never clears the
	// screen; disable shrink-clearing so the transcript above is preserved.
	const tui = new TUI(terminal, true);
	tui.setClearOnShrink(false);
	let statusBar: StatusBarComponent | null = null;

	const editor = new Editor(tui, EDITOR_THEME, { paddingX: 0 });
	editor.onSubmit = (text) => {
		if (!text.trim()) {
			return;
		}
		editor.addToHistory(text);
		output.write(`${prompt}${text}\n`);
		options.onSubmit(text);
	};

	if (options.statusBarComponent) {
		statusBar = options.statusBarComponent;
	} else if (options.statusBarText) {
		statusBar = new StatusBarComponent();
		statusBar.setModel({
			modelName: "",
			limit: 0,
			usedTokens: null,
			usage: null,
			cwd: options.statusBarText ?? "",
			branch: null,
		});
	}
	if (options.reasoningStream) {
		tui.addChild(options.reasoningStream);
	}
	tui.addChild(editor);
	if (statusBar) {
		tui.addChild(statusBar);
	}
	tui.setFocus(editor);
	tui.start();
	// Esc / Ctrl+C requests an interrupt (the caller decides whether to stop).
	tui.addInputListener((data) => {
		if (data === "\x1B" || data === "\u0003") {
			options.onEscape();
		}
		return undefined;
	});
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
			const result = operation();
			if (!stopped) {
				// Repaint the input below the streamed output. Use a plain (non
				// force) render: `requestRender(true)` sets previousWidth = -1,
				// which forces Pi-tui into a full-screen clear (\x1B[2J) that
				// would wipe the entire transcript above the prompt.
				tui.requestRender();
			}
			return result;
		},
	};
}

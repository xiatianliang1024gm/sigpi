import { stdin as processInput, stdout as processOutput } from "node:process";
import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import {
	Text,
	Editor,
	type EditorTheme,
	TUI,
	ProcessTerminal,
} from "@earendil-works/pi-tui";
import type { ChatCommandMetadata } from "./chat-commands.js";
import { StatusBarComponent } from "./tui/status-bar.js";

export interface ChatInputOptions {
	input?: ReadStream;
	output?: WriteStream;
	prompt?: string;
	commands?: readonly ChatCommandMetadata[];
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
 * must be visible synchronously before any keystroke arrives (tests assert on
 * the initial frame). Force a synchronous paint of the current frame.
 */
function renderInlineNow(tui: TUI): void {
	(tui as unknown as { doRender(): void }).doRender();
}

function makeStatusBar(text?: string): StatusBarComponent | null {
	if (text === undefined) {
		return null;
	}
	const statusBar = new StatusBarComponent();
	statusBar.setModel({
		modelName: "",
		limit: 0,
		usedTokens: null,
		usage: null,
		cwd: text,
		branch: null,
	});
	return statusBar;
}

/**
 * Build the editor (+ optional status bar) as children of `tui` and focus it.
 * Shared by the standalone prompter and the persistent-REPL renderer so the
 * slash-autocomplete and editor behavior stay identical (src/tui/README.md).
 * A status bar passed in via `statusBarComponent` is owned by the caller and is
 * NOT added/removed here.
 */
export function buildEditor(
	tui: TUI,
	opts: {
		commands: readonly ChatCommandMetadata[];
	},
): Editor {
	const editor = new Editor(tui, EDITOR_THEME, { paddingX: 0 });
	// editor.setAutocompleteProvider(
	// 	new SlashAutocompleteProvider(
	// 		opts.commands.map((command) => ({
	// 			name: command.name,
	// 			description: command.description,
	// 		})),
	// 		process.cwd(),
	// 	),
	// );

	return editor;
}

/**
 * Standalone chat prompt. Creates a transient inline `TUI` (mirroring the old
 * per-prompt behavior) so it remains usable outside the persistent REPL and in
 * tests. For the persistent REPL, use {@link attachChatInput} instead.
 */
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
		const terminal = new ProcessTerminal();
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

		const editor = buildEditor(tui, {
			commands,
		});
		tui.addChild(editor);
		if(args?.statusBarComponent){
			tui.addChild(args?.statusBarComponent);
		}
		editor.onSubmit = (text: string) => {
			if (!text.trim()) {
				return;
			}
			editor.addToHistory(text);
			finish(text);
		};

		tui.start();
		// Esc / Ctrl+C cancels the prompt and resolves with `null`.
		tui.addInputListener((data) => {
			if (data === "\x1B" || data === "\u0003") {
				finish(null);
			}
			return undefined;
		});
		renderInlineNow(tui);
	});
}

export interface AttachChatInputOptions {
	prompt?: string;
	input?: ReadStream;
	output?: WriteStream;
	commands?: readonly ChatCommandMetadata[];
	/** Shared status bar owned by the caller (e.g. the persistent renderer). */
	statusBarComponent?: StatusBarComponent | null;
	statusBarText?: string;
	onSubmit?: (text: string) => void;
	onEscape?: () => void;
}

export interface ChatInputHandle {
	/** Resolves with the submitted line, or `null` if cancelled (Esc/Ctrl+C). */
	read: () => Promise<string | null>;
	/** Remove the editor from the TUI (does not stop a shared/persistent TUI). */
	stop: () => void;
}

/**
 * Attach the chat editor to an already-running `TUI` (the persistent REPL,
 * ADR 0025 A1). Unlike {@link readChatInput} this does not create or stop a
 * `TUI` — the transcript and status bar persist; only the editor child is added
 * for the duration of one prompt and removed on {@link ChatInputHandle.stop}.
 */
export function attachChatInput(
	tui: TUI,
	options: AttachChatInputOptions,
): ChatInputHandle {
	const prompt = options.prompt ?? "> ";
	const input = options.input ?? processInput;
	const output = options.output ?? processOutput;
	const commands = options.commands ?? [];

	if (!input.isTTY || !output.isTTY) {
		return {
			read: async () => {
				const rl = createInterface({ input, output });
				try {
					return await rl.question(prompt);
				} finally {
					rl.close();
				}
			},
			stop: () => {},
		};
	}

	let settled = false;
	let resolveRead: (value: string | null) => void = () => {};
	const editor = buildEditor(tui, {
		commands,
	});

	editor.onSubmit = (text) => {
		const trimedText = text.trim();
		if (settled || !trimedText) {
			return;
		}
		settled = true;
		editor.addToHistory(trimedText);
		tui.addChild(new Text(trimedText));
		// output.write(`${prompt}${text}\n`);
		options.onSubmit?.(text);
		resolveRead(text);
	};

	renderInlineNow(tui);
	const unsubscribe = tui.addInputListener((data) => {
		if (data === "\x1B" || data === "\u0003") {
			if (settled) {
				return;
			}
			settled = true;
			options.onEscape?.();
			resolveRead(null);
		}
		return undefined;
	});

	return {
		read: () =>
			new Promise<string | null>((resolve) => {
				resolveRead = resolve;
			}),
		stop: () => {
			settled = true;
			unsubscribe();
			tui.removeChild(editor);
			tui.requestRender();
		},
	};
}

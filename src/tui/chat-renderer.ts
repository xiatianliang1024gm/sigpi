import process, {
	stdin as processInput,
	stdout as processOutput,
} from "node:process";
import type { ReadStream, WriteStream } from "node:tty";
import {
	type Component,
	Container,
	type Editor,
	matchesKey, ProcessTerminal,
	TUI,
} from "@earendil-works/pi-tui";
import type { ChatCommandMetadata } from "../chat-commands.js";
import { buildEditor } from "../chat-input.js";
import type { JsonValue } from "../types.js";
import {
	AssistantMessageComponent,
	SystemMessageComponent,
	ToolResultMessageComponent,
	UserMessageComponent,
} from "./messages.js";
import {StatusBarComponent, StatusBarModel} from "./status-bar.js";
import {buildStatusBarModel} from "../chat-repl.js";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
// Enable SGR (decimal) mouse *encoding* (1006) AND a tracking mode (1000:
// button press/release + wheel up/down). 1006 alone only changes the encoding
// format and emits no events, so the wheel used to fall through as plain arrow
// keys (\x1b[A / \x1b[B) that the focused editor read as history navigation.
// 1000 reports the wheel as SGR button 64 (up) / 65 (down), which the wheel
// handler below consumes to scroll the transcript (ADR 0025).
const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE_TRACKING = "\x1b[?1000l\x1b[?1006l";

export interface AssistantMessageView {
	appendReasoning(text: string): void;
	appendContent(text: string): void;
	finalize(): void;
}

/**
 * Output surface for the REPL loop. Two implementations: {@link ChatRenderer}
 * (persistent Pi-tui `TUI`, ADR 0025 A1) and a console fallback for non-TTY /
 * one-shot modes. The loop is written against this interface so the TTY and
 * non-TTY paths share one control flow.
 */
export interface ReplView {
	start(): void;
	stop(): void;
	readInput(prompt?: string): Promise<string | null>;
	takeQueuedLines(): string[];
	addUserMessage(text: string): void;
	beginAssistantMessage(): AssistantMessageView;
	beginTurn(onInterrupt: () => void): void;
	endTurn(): void;
	addToolResult(
		rendered: string,
		toolName?: string,
		toolResultData?: JsonValue,
	): void;
	appendSystem(text: string, tone?: "error" | "info"): void;
	setStatusBarModel(model: StatusBarModel): void;
	writeLine(line: string): void;
	writeError(line: string): void;
	getTuiInstance(): TUI;
}

type Phase = "idle" | "turn";

export class ChatRenderer implements ReplView {
	private readonly tui: TUI;
	private readonly input: ReadStream;
	private readonly output: WriteStream;
	private readonly statusBar : StatusBarComponent;
	private readonly chatContainer = new Container();
	private readonly commands: readonly ChatCommandMetadata[];
	private editor: Editor | null = null;
	private editorUnsub: (() => void) | null = null;
	private phase: Phase = "idle";
	private pendingResolve: ((value: string | null) => void) | null = null;
	private interruptHandler: (() => void) | null = null;
	private queuedLines: string[] = [];

	constructor(options: {
		input?: ReadStream;
		output?: WriteStream;
		prompt?: string;
		statusBarModel?: StatusBarModel;
		commands?: readonly ChatCommandMetadata[];
	}) {
		this.input = options.input ?? processInput;
		this.output = options.output ?? processOutput;
		this.statusBar = new StatusBarComponent(options.statusBarModel);
		this.commands = options.commands ?? [];
		const terminal = new ProcessTerminal();
		this.tui = new TUI(terminal, true);
		this.tui.setClearOnShrink(false);
	}

	getTuiInstance(): TUI {
		return this.tui;
	}
	private enterAltScreen(): void {
		this.output.write(ENTER_ALT_SCREEN);
	}

	private leaveAltScreen(): void {
		try {
			this.output.write(LEAVE_ALT_SCREEN);
			this.output.write(DISABLE_MOUSE_TRACKING);
		} catch {
			// output may already be closed on abrupt exit
		}
	}

	start(): void {
		this.enterAltScreen();
		process.once("exit", () => this.leaveAltScreen());
		const editor = buildEditor(this.tui, {
			commands: this.commands,
		});
		this.tui.addChild(this.chatContainer);
		this.editor = editor;
		this.tui.addChild(editor);
		this.tui.setFocus(editor);
		this.tui.addChild(this.statusBar);

		editor.onSubmit = (text) => this.handleSubmit(text);
		editor.onChange = this.onEditorChange;

		this.editorUnsub = this.tui.addInputListener((data) =>
			this.handleInterruptKey(data),
		);
		this.tui.start();
		// Enable SGR mouse tracking only after the TUI has taken over the
		// terminal (raw mode + alternate screen) so a terminal startup sequence
		// cannot reset it. Paired with DISABLE_MOUSE_TRACKING on leave.
		this.output.write(ENABLE_MOUSE_TRACKING);
	}

	onEditorChange(text:string):void {
		let t1 = text;
	}


	stop(): void {
		this.editorUnsub?.();
		this.tui.stop();
		this.leaveAltScreen();
	}

	readInput(_prompt = ""): Promise<string | null> {
		this.phase = "idle";
		if (this.editor) {
			this.tui.setFocus(this.editor);
		}
		this.tui.requestRender();
		return new Promise<string | null>((resolve) => {
			this.pendingResolve = resolve;
		});
	}

	takeQueuedLines(): string[] {
		const queued = this.queuedLines;
		this.queuedLines = [];
		return queued;
	}

	addUserMessage(text: string): void {
		this.chatContainer.addChild(new UserMessageComponent(text));
		this.tui.requestRender();
	}

	beginAssistantMessage(): AssistantMessageComponent {
		const component = new AssistantMessageComponent();
		this.chatContainer.addChild(component);
		this.tui.requestRender();
		return component;
	}

	beginTurn(onInterrupt: () => void): void {
		this.phase = "turn";
		this.interruptHandler = onInterrupt;
	}

	endTurn(): void {
		this.phase = "idle";
		this.interruptHandler = null;
	}

	addToolResult(
		rendered: string,
		toolName?: string,
		toolResultData?: JsonValue,
	): void {
		this.chatContainer.addChild(
			new ToolResultMessageComponent(rendered, toolName, toolResultData),
		);
		this.tui.requestRender();
	}

	appendSystem(text: string, tone: "error" | "info" = "info"): void {
		this.chatContainer.addChild(new SystemMessageComponent(text, tone));
		this.tui.requestRender();
	}

	setStatusBarModel(model: StatusBarModel): void {
		this.statusBar.setModel(model);
		this.tui.requestRender();
	}

	writeLine(line: string): void {
		this.appendSystem(line);
	}

	writeError(line: string): void {
		this.appendSystem(line, "error");
	}

	showOverlay(
		component: Parameters<TUI["showOverlay"]>[0],
		options?: Parameters<TUI["showOverlay"]>[1],
	): void {
		this.tui.showOverlay(component, options);
	}

	hideOverlay(): void {
		this.tui.hideOverlay();
	}

	private handleSubmit(text: string): void {
		const trimText = text.trim();
		if (!trimText) {
			return;
		}
		this.editor?.addToHistory(trimText);
		if (this.phase === "idle") {
			const resolve = this.pendingResolve;
			this.pendingResolve = null;
			resolve?.(trimText);
		} else {
			this.queuedLines.push(trimText);
		}
	}

	private handleInterruptKey(data: string): undefined {
		if (data !== "\x1B" && data !== "\u0003") {
			return undefined;
		}
		if (this.phase === "idle") {
			const resolve = this.pendingResolve;
			this.pendingResolve = null;
			resolve?.(null);
		} else {
			this.interruptHandler?.();
		}
		return undefined;
	}
}

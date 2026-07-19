import process, {
	stdin as processInput,
	stdout as processOutput,
} from "node:process";
import type { ReadStream, WriteStream } from "node:tty";
import {
	type Component,
	Container,
	type Editor,
	matchesKey,
	TUI,
} from "@earendil-works/pi-tui";
import type { ChatCommandMetadata } from "../chat-commands.js";
import { buildEditor } from "../chat-input.js";
import {
	AssistantMessageComponent,
	SystemMessageComponent,
	ToolResultMessageComponent,
	UserMessageComponent,
} from "./messages.js";
import { ProcessTerminal, SigPiTerminal } from "./sigpi-terminal.js";
import { StatusBarComponent } from "./status-bar.js";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
const ENABLE_MOUSE_TRACKING = "\x1b[?1006h";
const DISABLE_MOUSE_TRACKING = "\x1b[?1006l";

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
	addToolResult(rendered: string): void;
	appendSystem(text: string, tone?: "error" | "info"): void;
	setStatus(model: StatusBarComponent): void;
	writeLine(line: string): void;
	writeError(line: string): void;
}

type Phase = "idle" | "turn";

/**
 * Persistent REPL renderer (ADR 0025 A1). Owns a single Pi-tui `TUI` for the
 * whole session; the transcript is a `chatContainer` of per-message components
 * (user / assistant / tool-result / system) scrolled by Pi-tui's viewport. The
 * status bar is a persistent footer; the editor is a single persistent child
 * re-focused each idle phase. All live output is a component — never
 * `console.log` while the `TUI` is alive (that desyncs Pi-tui's viewport).
 */
export class TranscriptViewport implements Component {
	private readonly children: Component[] = [];
	private topIndex = 0;
	private following = true;
	private cachedAvailable = 1;
	private cachedTotal = 0;

	constructor(
		private readonly getRows: () => number,
		private readonly getFooterHeight: () => number,
	) {}

	addChild(component: Component): void {
		this.children.push(component);
	}

	/** Scroll up one page; anchors the view to historical content. */
	scrollUp(): void {
		this.following = false;
		const step = Math.max(1, this.cachedAvailable - 1);
		this.topIndex = Math.max(0, this.topIndex - step);
	}

	/** Scroll down one page; resumes following the latest at the bottom. */
	scrollDown(): void {
		const step = Math.max(1, this.cachedAvailable - 1);
		const maxTop = Math.max(0, this.cachedTotal - this.cachedAvailable);
		this.topIndex = Math.min(this.topIndex + step, maxTop);
		if (this.topIndex >= maxTop) this.following = true;
	}

	/** Jump back to the live tail (used when the user submits input). */
	scrollToBottom(): void {
		this.following = true;
		this.topIndex = 0;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			for (const line of child.render(width)) {
				lines.push(line);
			}
		}
		const rows = Math.max(1, this.getRows());
		const footerHeight = Math.max(0, this.getFooterHeight());
		const available = Math.max(1, rows - footerHeight);
		this.cachedAvailable = available;
		this.cachedTotal = lines.length;

		// Bottom-anchor the transcript just above the fixed footer and return a
		// constant height so the footer's neighbour (the live answer) sits at a
		// stable line — that keeps Pi-tui's differential redraw painting the
		// streamed answer and footer (the earlier "answer not rendered" bug).
		//
		// When scrolled up, the view is anchored to absolute content indices,
		// which stay stable because the transcript only ever appends. Older
		// messages therefore remain reviewable instead of being dropped.
		if (lines.length <= available) {
			this.following = true;
			this.topIndex = 0;
			return [...new Array(available - lines.length).fill(""), ...lines];
		}
		const maxTop = lines.length - available;
		if (this.following) {
			this.topIndex = maxTop;
			return lines.slice(this.topIndex, this.topIndex + available);
		}
		this.topIndex = Math.min(this.topIndex, maxTop);
		// Reserve the top line for a scroll hint so the viewport height stays
		// constant (footer never shifts) even while reviewing history.
		const atTop = this.topIndex === 0;
		const hint = atTop
			? "↑ 已到顶部 · 滚轮下/PgDn 回到底部"
			: "↑/滚轮上 上翻历史 · 滚轮下/PgDn 回到底部";
		const content = lines.slice(this.topIndex, this.topIndex + (available - 1));
		return [hint, ...content];
	}

	invalidate(): void {}
}

export class ChatRenderer implements ReplView {
	private readonly tui: TUI;
	private readonly input: ReadStream;
	private readonly output: WriteStream;
	private readonly chatContainer = new TranscriptViewport(
		() => this.output.rows ?? 24,
		() => this.footerHeight,
	);
	private readonly statusBar = new StatusBarComponent();
	private footerHeight = 2;
	private readonly promptText: string;
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
		commands?: readonly ChatCommandMetadata[];
	}) {
		this.input = options.input ?? processInput;
		this.output = options.output ?? processOutput;
		this.promptText = options.prompt ?? "> ";
		this.commands = options.commands ?? [];
		const terminal = new SigPiTerminal(
			new ProcessTerminal(this.input, this.output),
		);
		this.tui = new TUI(terminal, true);
		this.tui.setClearOnShrink(false);
		this.tui.addChild(this.chatContainer);
	}

	get tuiInstance(): TUI {
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
		const bottomBar = new Container();
		this.enterAltScreen();
		this.output.write(ENABLE_MOUSE_TRACKING);
		process.once("exit", () => this.leaveAltScreen());
		bottomBar.addChild(this.statusBar);
		const { editor } = buildEditor(this.tui, {
			input: this.input,
			output: this.output,
			prompt: this.promptText,
			commands: this.commands,
			statusBarComponent: this.statusBar,
			parent: bottomBar,
		});
		this.editor = editor;
		this.footerHeight = bottomBar.render(this.output.columns ?? 80).length;
		editor.onSubmit = (text) => this.handleSubmit(text);
		this.editorUnsub = this.tui.addInputListener((data) =>
			this.handleInterruptKey(data),
		);
		this.tui.addInputListener((data) => {
			if (matchesKey(data, "pageUp")) {
				this.chatContainer.scrollUp();
				this.tui.requestRender();
				return { consume: true };
			}
			if (matchesKey(data, "pageDown")) {
				this.chatContainer.scrollDown();
				this.tui.requestRender();
				return { consume: true };
			}
			// Mouse wheel (SGR 1006): 64 = wheel up (reveal older), 65 = wheel down.
			const wheel = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
			if (wheel) {
				const button = Number(wheel[1]);
				if (button === 64) {
					this.chatContainer.scrollUp();
				} else if (button === 65) {
					this.chatContainer.scrollDown();
				} else {
					return undefined;
				}
				this.tui.requestRender();
				return { consume: true };
			}
			return undefined;
		});
		this.tui.addChild(bottomBar);
		this.tui.start();
		renderInlineNow(this.tui);
	}

	stop(): void {
		this.editorUnsub?.();
		this.tui.stop();
		this.leaveAltScreen();
	}

	readInput(_prompt = this.promptText): Promise<string | null> {
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

	addToolResult(rendered: string): void {
		this.chatContainer.addChild(new ToolResultMessageComponent(rendered));
		this.tui.requestRender();
	}

	appendSystem(text: string, tone: "error" | "info" = "info"): void {
		this.chatContainer.addChild(new SystemMessageComponent(text, tone));
		this.tui.requestRender();
	}

	setStatus(model: StatusBarComponent): void {
		this.statusBar.setModel(model.getModel());
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
		if (!text.trim()) {
			return;
		}
		this.chatContainer.scrollToBottom();
		this.editor?.addToHistory(text);
		if (this.phase === "idle") {
			const resolve = this.pendingResolve;
			this.pendingResolve = null;
			resolve?.(text);
		} else {
			this.queuedLines.push(text);
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

function renderInlineNow(tui: TUI): void {
	(tui as unknown as { doRender(): void }).doRender();
}

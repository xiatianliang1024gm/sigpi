import {
	type Component,
	type Editor,
	ProcessTerminal,
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
import { StatusBarComponent, type StatusBarModel } from "./status-bar.js";
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
	getStatusBarModel(): StatusBarModel | null;
	writeLine(line: string): void;
	writeError(line: string): void;
	getTuiInstance(): TUI;
}

type Phase = "idle" | "turn";

export class ChatRenderer implements ReplView {
	private readonly tui: TUI;
	private readonly statusBar: StatusBarComponent;
	private readonly commands: readonly ChatCommandMetadata[];
	private editor: Editor | null = null;
	private editorUnsub: (() => void) | null = null;
	private phase: Phase = "idle";
	private pendingResolve: ((value: string | null) => void) | null = null;
	private interruptHandler: (() => void) | null = null;
	private queuedLines: string[] = [];

	constructor(options: {
		prompt?: string;
		statusBarModel?: StatusBarModel;
		commands?: readonly ChatCommandMetadata[];
	}) {
		this.statusBar = new StatusBarComponent(options.statusBarModel);
		this.commands = options.commands ?? [];
		const terminal = new ProcessTerminal();
		this.tui = new TUI(terminal);
	}

	getTuiInstance(): TUI {
		return this.tui;
	}

	start(): void {
		const editor = buildEditor(this.tui, {
			commands: this.commands,
		});
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
	}

	onEditorChange(text: string): void {
		const t1 = text;
	}

	stop(): void {
		this.editorUnsub?.();
		this.tui.stop();
	}

	readInput(): Promise<string | null> {
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

	private appendComponent(component: Component): void {
		const children = this.tui.children;
		// reserve space for Editor, statusBar
		children.splice(children.length - 2, 0, component);
		this.tui.requestRender();
	}

	addUserMessage(text: string): void {
		const component = new UserMessageComponent(text);
		this.appendComponent(component);
	}

	beginAssistantMessage(): AssistantMessageComponent {
		const component = new AssistantMessageComponent();
		this.appendComponent(component);
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
		const component = new ToolResultMessageComponent(
			rendered,
			toolName,
			toolResultData,
		);
		this.appendComponent(component);
	}

	appendSystem(text: string, tone: "error" | "info" = "info"): void {
		const component = new SystemMessageComponent(text, tone);
		this.appendComponent(component);
	}

	setStatusBarModel(model: StatusBarModel): void {
		this.statusBar.setModel(model);
		this.tui.requestRender();
	}

	getStatusBarModel(): StatusBarModel | null {
		return this.statusBar.getModel();
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

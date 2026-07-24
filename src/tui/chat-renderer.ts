import {
	type Component,
	type Editor,
	ProcessTerminal,
	TUI,
} from "@earendil-works/pi-tui";
import type { ChatCommandMetadata } from "../chat-commands.js";
import { buildEditor } from "../chat-input.js";
import type { FileEditSummary } from "../tools/edit-summary.js";
import {
	AssistantMessageComponent,
	SystemMessageComponent,
	ToolLineComponent,
	UserMessageComponent,
} from "./messages.js";
import { StatusBarComponent, type StatusBarModel } from "./status-bar.js";
export interface AssistantMessageView {
	appendReasoning(text: string): void;
	appendContent(text: string): void;
	finalize(): void;
}

/** Handle for an in-flight tool-call line in the activity log. */
export interface ToolLineHandle {
	/** Mark the tool line as succeeded. For edit/write tools, an optional
	 *  {@link FileEditSummary} renders an inline diff below. */
	finish(diffSummary?: FileEditSummary | null): void;
	/** Append a red error summary to the same line. */
	fail(error: string): void;
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
	/** Open a tool-call line that resolves in place when the tool finishes or
	 *  fails. Replaces the one-shot {@link addToolResult}. */
	beginToolLine(id: string, label: string, toolName: string): ToolLineHandle;
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

	onEditorChange(_text: string): void {}

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

	beginToolLine(_id: string, label: string, toolName: string): ToolLineHandle {
		const component = new ToolLineComponent(label, toolName);
		this.appendComponent(component);
		let finalized = false;

		const finish = (diffSummary?: FileEditSummary | null) => {
			if (finalized) return;
			finalized = true;
			component.finish(diffSummary ?? undefined);
			this.tui.requestRender();
		};

		const fail = (error: string) => {
			if (finalized) return;
			finalized = true;
			component.fail(error);
			this.tui.requestRender();
		};

		return { finish, fail };
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
		// Esc / Ctrl+C only interrupt an active agent turn.
		// Exit is only via the /exit command (or /quit, exit, quit).
		if (this.phase === "turn") {
			this.interruptHandler?.();
		}
		return undefined;
	}
}

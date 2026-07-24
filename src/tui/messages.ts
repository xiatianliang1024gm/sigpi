import {
	type Component,
	Markdown,
	type MarkdownTheme,
	Text,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { JsonValue } from "../types.js";
import { formatFileEditResultData } from "./file-edit-renderer.js";
import { defaultMarkdownTheme } from "./themes.js";

const ANSI_DIM = "\x1B[2m";
const ANSI_RESET = "\x1B[0m";
const ANSI_RED = "\x1B[31m";
const ANSI_CYAN = "\x1B[36m";

/**
 * A single message in the persistent transcript. Under ADR 0025 the transcript
 * is a Pi-tui component tree (`chatContainer`) scrolled by Pi-tui's viewport;
 * each turn appends one of these components instead of printing to `stdout`.
 *
 * All components are display-only and never alter the agent-turn control flow.
 */

/** User-submitted prompt line. */
export class UserMessageComponent implements Component {
	private readonly textComponent: Text;
	private readonly text: string;

	constructor(text: string) {
		this.text = "❯ " + text;
		this.textComponent = new Text(this.text);
		this.textComponent.setCustomBgFn(
			(text: string) => `${ANSI_CYAN}${text}\x1b[39m`,
		);
	}

	render(width: number): string[] {
		return this.textComponent.render(width);
	}

	invalidate(): void {}
}

/**
 * Streaming assistant message. The agent loop feeds it incremental
 * {@link ModelDelta} fragments (spec-0020 / ADR 0025): reasoning folds into a
 * dim "thinking" block and content into the answer body, both rendered live,
 * in place. Unlike the retired `ReasoningStreamComponent` this component is a
 * permanent member of the transcript — it is never cleared, only finalized.
 */
export class AssistantMessageComponent implements Component {
	private readonly reasoningComponent: Text = new Text("");
	private readonly contentComponent: Markdown = new Markdown(
		"",
		2,
		2,
		defaultMarkdownTheme,
	);
	private reasoning: string = "";
	private content: string = "";
	private hasReasoning = false;
	private hasContent = false;

	appendReasoning(text: string): void {
		if (!text) {
			return;
		}
		this.reasoning += text;
		this.hasReasoning = true;
		this.reasoningComponent.setText(this.reasoning);
	}

	appendContent(text: string): void {
		if (!text) {
			return;
		}
		this.content += text;
		this.hasContent = true;
		this.contentComponent.setText(this.content);
	}

	/** Lock the message; further deltas are ignored (terminal phase reached). */
	finalize(): void {}

	render(width: number, maxHeight?: number): string[] {
		const lines: string[] = [];
		if (this.hasReasoning) {
			lines.push(...this.reasoningComponent.render(width));
		}

		if (this.hasContent) {
			lines.push(...this.contentComponent.render(width));
		}
		return lines;
	}

	invalidate(): void {}
}

/** Rendered tool result (already formatted by `formatToolExecutionResult`). */
export class ToolResultMessageComponent implements Component {
	private readonly rendered: string;
	private readonly toolName?: string;
	private readonly toolResultData?: JsonValue;

	constructor(rendered: string, toolName?: string, toolResultData?: JsonValue) {
		this.rendered = rendered;
		this.toolName = toolName;
		this.toolResultData = toolResultData;
	}

	render(width: number, maxHeight?: number): string[] {
		const displayText = formatTuiToolResult(
			this.rendered,
			this.toolName,
			this.toolResultData,
		);
		const lines: string[] = [];
		for (const raw of displayText.split("\n")) {
			for (const line of wrapTextWithAnsi(raw, width)) {
				lines.push(line);
			}
		}
		return cap(lines, maxHeight);
	}

	invalidate(): void {}
}

function formatTuiToolResult(
	rendered: string,
	toolName?: string,
	toolResultData?: JsonValue,
): string {
	if (!toolName || !rendered) {
		return rendered;
	}

	// update_plan content is already rendered in tool_execution_started
	if (toolName === "update_plan") {
		return "";
	}

	// edit/write: render a line-numbered diff from editSummary in data
	if (toolName === "edit" || toolName === "write") {
		const editLines = formatFileEditResultData(toolResultData);
		if (editLines.length > 0) {
			return editLines.join("\n");
		}
	}

	// read, grep, glob, bash, and everything else: show the pure result
	return rendered;
}

/** System line: errors, compaction notices, interruptions. */
export class SystemMessageComponent implements Component {
	private readonly text: string;
	private readonly tone: "error" | "info";

	// todo use pi-tui Text
	constructor(text: string, tone: "error" | "info" = "info") {
		this.text = text;
		this.tone = tone;
	}

	render(width: number, maxHeight?: number): string[] {
		const color = this.tone === "error" ? ANSI_RED : ANSI_CYAN;
		const lines: string[] = [];
		for (const raw of this.text.split("\n")) {
			for (const line of wrapTextWithAnsi(raw, width)) {
				lines.push(`${color}${line}${ANSI_RESET}`);
			}
		}
		return cap(lines, maxHeight);
	}

	invalidate(): void {}
}

/** Keep at most `maxHeight` lines (most recent) so the prompt stays visible. */
function cap(lines: string[], maxHeight?: number): string[] {
	if (maxHeight === undefined || lines.length <= maxHeight) {
		return lines;
	}
	const overflow = lines.length - maxHeight;
	const visible = lines.slice(overflow);
	visible.unshift(`${ANSI_DIM}… (${overflow} more lines)${ANSI_RESET}`);
	return visible.slice(0, maxHeight);
}

import type { Component } from "@earendil-works/pi-tui";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

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
	private readonly text: string;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number, maxHeight?: number): string[] {
		const lines = [`${ANSI_DIM}▸ you${ANSI_RESET}`];
		for (const line of wrapTextWithAnsi(this.text, width)) {
			lines.push(line);
		}
		return cap(lines, maxHeight);
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
	private reasoning = "";
	private content = "";
	private hasReasoning = false;
	private hasContent = false;
	private finalized = false;

	appendReasoning(text: string): void {
		if (this.finalized || !text) {
			return;
		}
		this.reasoning += text;
		this.hasReasoning = true;
	}

	appendContent(text: string): void {
		if (this.finalized || !text) {
			return;
		}
		this.content += text;
		this.hasContent = true;
	}

	/** Lock the message; further deltas are ignored (terminal phase reached). */
	finalize(): void {
		this.finalized = true;
	}

	get isFinalized(): boolean {
		return this.finalized;
	}

	render(width: number, maxHeight?: number): string[] {
		const lines: string[] = [];

		if (this.hasReasoning) {
			lines.push(`${ANSI_DIM}▸ reasoning${ANSI_RESET}`);
			for (const line of wrapTextWithAnsi(this.reasoning, width)) {
				lines.push(`${ANSI_DIM}  ${line}${ANSI_RESET}`);
			}
		}

		if (this.hasContent) {
			for (const line of wrapTextWithAnsi(this.content, width)) {
				lines.push(line);
			}
		} else if (!this.hasReasoning) {
			lines.push(`${ANSI_DIM}…${ANSI_RESET}`);
		}

		return cap(lines, maxHeight);
	}

	invalidate(): void {}
}

/** Rendered tool result (already formatted by `formatToolExecutionResult`). */
export class ToolResultMessageComponent implements Component {
	private readonly rendered: string;

	constructor(rendered: string) {
		this.rendered = rendered;
	}

	render(width: number, maxHeight?: number): string[] {
		const lines: string[] = [];
		for (const raw of this.rendered.split("\n")) {
			for (const line of wrapTextWithAnsi(raw, width)) {
				lines.push(line);
			}
		}
		return cap(lines, maxHeight);
	}

	invalidate(): void {}
}

/** System line: errors, compaction notices, interruptions. */
export class SystemMessageComponent implements Component {
	private readonly text: string;
	private readonly tone: "error" | "info";

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

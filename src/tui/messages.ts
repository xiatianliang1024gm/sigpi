import {
	type Component,
	Markdown,
	Text,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { FileEditSummary } from "../tools/edit-summary.js";
import { FileEditComponent } from "./file-edit-renderer.js";
import { defaultMarkdownTheme } from "./themes.js";

const ANSI_DIM = "\x1B[2m";
const ANSI_RESET = "\x1B[0m";
const ANSI_RED = "\x1B[31m";
const ANSI_CYAN = "\x1B[36m";
const ANSI_BLUE = "\x1B[34m";
const _ANSI_GREEN = "\x1B[32m";
const ANSI_WHITE = "\x1B[37m";
const ANSI_BG_GRAY = "\x1B[100m";

const GLYPH_BULLET = "\u25CF"; // ●
const GLYPH_TOOL = "\u23BF"; // ⎿
const GLYPH_DIFF = "\u23D0"; // ⏐

const INDENT_TOOL = "  "; // 2-space indent for tool lines
const INDENT_DIFF = "    "; // 4-space indent for diff lines

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
		this.text = `\u276F ${text}`;
		this.textComponent = new Text(this.text, 0, 0);
		this.textComponent.setCustomBgFn(
			(text: string) => `${ANSI_BG_GRAY}${ANSI_WHITE}${text}${ANSI_RESET}`,
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
 *
 * Under ADR 0026 non-thinking content lines are prefixed with `●` (bullet) to
 * form a visual narrative stream.
 */
export class AssistantMessageComponent implements Component {
	private readonly reasoningComponent: Text = new Text("", 0, 0);
	private readonly contentComponent: Markdown = new Markdown(
		"",
		0,
		0,
		defaultMarkdownTheme,
	);
	private reasoning: string = "";
	private content: string = "";
	private hasReasoning = false;
	private hasContent = false;

	constructor() {
		this.reasoningComponent.setCustomBgFn(
			(text: string) => `${ANSI_DIM}${text}${ANSI_RESET}`,
		);
	}

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

	render(width: number, _maxHeight?: number): string[] {
		const lines: string[] = [];
		if (this.hasReasoning) {
			lines.push(...this.reasoningComponent.render(width));
		}

		if (this.hasContent) {
			const bulletPrefixWidth = GLYPH_BULLET.length + /* space */ 1;
			const contentLines = this.contentComponent.render(
				width - bulletPrefixWidth,
			);
			let firstLine = true;
			for (const line of contentLines) {
				// first line has BULLET
				if (firstLine) {
					lines.push(`${ANSI_BLUE}${GLYPH_BULLET}${ANSI_RESET} ${line}`);
					firstLine = false;
				} else {
					lines.push(`  ${line}`);
				}
			}
		}
		return lines;
	}

	invalidate(): void {}
}

/**
 * A single tool-call line in the activity log. Two-phase lifecycle:
 * phase 1 shows the label (tool summary), phase 2 appends the outcome inline.
 * Under ADR 0026 this replaces the retired {@link ToolResultMessageComponent}.
 */
export class ToolLineComponent implements Component {
	private readonly label: string;
	// private readonly toolName: string;
	private outcome: string = "";
	private failed = false;
	private diffComponent: FileEditComponent | null = null;

	constructor(label: string, _toolName: string) {
		this.label = label;
		// this.toolName = toolName;
	}

	finish(outcome: string, diffSummary?: FileEditSummary): void {
		this.outcome = outcome;
		this.failed = false;
		if (diffSummary) {
			this.diffComponent = new FileEditComponent().setSummary(diffSummary);
		}
	}

	fail(error: string): void {
		this.outcome = error;
		this.failed = true;
	}

	render(width: number): string[] {
		const lines: string[] = [];

		const body = this.outcome ? `${this.label} → ${this.outcome}` : this.label;

		// Wrap the plain-text body first, then prefix each line with the
		// indented glyph. Only the first line gets the glyph colored blue;
		// continuation lines get a plain indent.
		const wrapWidth = Math.max(
			1,
			width - INDENT_TOOL.length - /* glyph + space */ 2,
		);
		let first = true;
		for (const raw of body.split("\n")) {
			for (const wrapped of wrapTextWithAnsi(raw, wrapWidth)) {
				if (first) {
					const color = this.failed ? ANSI_RED : ANSI_BLUE;
					lines.push(
						`${INDENT_TOOL}${color}${GLYPH_TOOL}${ANSI_RESET} ${wrapped}`,
					);
					first = false;
				} else {
					lines.push(`${INDENT_TOOL}  ${wrapped}`);
				}
			}
		}

		// Diff lines below edit/write success
		if (this.diffComponent) {
			const diffLines = this.diffComponent.render(width - INDENT_DIFF.length);
			for (const diffLine of diffLines) {
				lines.push(
					`${INDENT_DIFF}${ANSI_DIM}${GLYPH_DIFF}${ANSI_RESET} ${diffLine}`,
				);
			}
		}

		return lines;
	}

	invalidate(): void {
		this.diffComponent?.invalidate();
	}
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
	visible.unshift(`${ANSI_DIM}\u2026 (${overflow} more lines)${ANSI_RESET}`);
	return visible.slice(0, maxHeight);
}

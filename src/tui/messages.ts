import {
	type Component,
	Markdown,
	Text,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { defaultMarkdownTheme } from "./themes.js";

const GLYPH_BULLET = "\u25CF"; // ●
const GLYPH_TOOL = "\u23BF"; // ⎿

const INDENT_TOOL = "  "; // 2-space indent for tool lines

/**
 * A single message in the persistent transcript. The transcript
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
		this.textComponent.setCustomBgFn((text: string) =>
			chalk.white.bgGray(text),
		);
	}

	render(width: number): string[] {
		return this.textComponent.render(width);
	}

	invalidate(): void {}
}

/**
 * Streaming assistant message. The agent loop feeds it incremental
 * {@link ModelDelta} fragments: reasoning folds into a
 * dim "thinking" block and content into the answer body, both rendered live,
 * in place. Unlike the retired `ReasoningStreamComponent` this component is a
 * permanent member of the transcript — it is never cleared, only finalized.
 *
 * Non-thinking content lines are prefixed with `●` (bullet) to
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
		this.reasoningComponent.setCustomBgFn((text: string) => chalk.dim(text));
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
					lines.push(`${chalk.blue(GLYPH_BULLET)} ${line}`);
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
 * Replaces the retired {@link ToolResultMessageComponent}.
 */
export class ToolLineComponent implements Component {
	private readonly label: string;
	private outcome: string = "";
	private failed = false;

	constructor(label: string) {
		this.label = label;
	}

	finish(): void {
		this.failed = false;
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
					const color = this.failed ? chalk.red : chalk.blue;
					lines.push(`${INDENT_TOOL}${color(GLYPH_TOOL)} ${wrapped}`);
					first = false;
				} else {
					lines.push(`${INDENT_TOOL}  ${wrapped}`);
				}
			}
		}

		return lines;
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

	render(width: number): string[] {
		const color = this.tone === "error" ? chalk.red : chalk.cyan;
		const lines: string[] = [];
		for (const raw of this.text.split("\n")) {
			for (const line of wrapTextWithAnsi(raw, width)) {
				lines.push(color(line));
			}
		}
		return lines;
	}

	invalidate(): void {}
}

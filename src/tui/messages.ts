import {
	type Component,
	Markdown,
	Text,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { SubAgentProgressMarker } from "../types.js";
import { defaultMarkdownTheme } from "./themes.js";

const GLYPH_BULLET = "\u25CF"; // ●
const GLYPH_TOOL = "\u23BF"; // ⎿
const GLYPH_SUB_AGENT = "\u21B3"; // ↳
const GLYPH_SUB_AGENT_BULLET = "\u25CB"; // ○

const INDENT_TOOL = "  "; // 2-space indent for tool lines
const INDENT_SUB_AGENT = "    "; // one level deeper, for sub-agent activity

/**
 * Label prefixed to every sub-agent line. Indentation alone already conveys
 * nesting right below the parent's `delegate to sub-agent` line, but a long
 * sub-agent run scrolls that line away — and its streamed text otherwise reads
 * exactly like the parent's own answer.
 */
const TAG_SUB_AGENT = "sub-agent";

/**
 * A line's presentation scope. A {@link SubAgentProgressMarker} means the line
 * reports a delegated sub-agent run: it is indented one level deeper, drawn
 * with its own glyph, and tagged so it can never be mistaken for the parent
 * turn's output. Set by the view from the reducer's line options
 * (`TranscriptLineOptions`), never derived here.
 */
interface SubAgentLineStyle {
	subAgent?: SubAgentProgressMarker;
}

/** The dim `sub-agent ` tag prefixed to a sub-agent line, or `""`. */
function subAgentTag(style: SubAgentLineStyle): string {
	return style.subAgent ? `${chalk.dim(TAG_SUB_AGENT)} ` : "";
}

/**
 * Visible width {@link subAgentTag} adds. Width math must use this, not
 * `tag.length`: the chalk-wrapped tag carries ANSI escapes (and whether it
 * does depends on the terminal, so measuring the string would wrap differently
 * per environment).
 */
const SUB_AGENT_TAG_WIDTH = TAG_SUB_AGENT.length + 1;

/** {@link SUB_AGENT_TAG_WIDTH} when the line is the sub-agent's, else `0`. */
function subAgentTagWidth(style: SubAgentLineStyle): number {
	return style.subAgent ? SUB_AGENT_TAG_WIDTH : 0;
}

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
	private readonly style: SubAgentLineStyle;
	private reasoning: string = "";
	private content: string = "";
	private hasReasoning = false;
	private hasContent = false;

	constructor(style: SubAgentLineStyle = {}) {
		this.style = style;
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
			const indent = this.style.subAgent ? INDENT_SUB_AGENT : "";
			const tag = subAgentTag(this.style);
			const bullet = this.style.subAgent
				? GLYPH_SUB_AGENT_BULLET
				: GLYPH_BULLET;
			const bulletColor = this.style.subAgent ? chalk.gray : chalk.blue;
			const bulletPrefixWidth = indent.length + bullet.length + /* space */ 1;
			const contentLines = this.contentComponent.render(
				width - bulletPrefixWidth - subAgentTagWidth(this.style),
			);
			let firstLine = true;
			for (const line of contentLines) {
				// first line has BULLET
				if (firstLine) {
					lines.push(`${indent}${bulletColor(bullet)} ${tag}${line}`);
					firstLine = false;
				} else {
					lines.push(`${indent}  ${line}`);
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
 *
 * The label is the human-readable summary of the tool call (e.g.
 * `shell git status` for bash, `search files mentioning "foo"` for grep).
 * The live REPL gets this from `describeProgress`; the transcript replay
 * (`buildTranscriptComponents`) reconstructs it from the persisted
 * `ToolCall.arguments` via the same `describeProgress` so `--continue` /
 * `--session <id>` shows the same line the user saw during the turn.
 */
export class ToolLineComponent implements Component {
	private readonly label: string;
	private readonly style: SubAgentLineStyle;
	private outcome: string = "";
	private failed = false;

	constructor(label: string, style: SubAgentLineStyle = {}) {
		this.label = label;
		this.style = style;
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
		const indent = this.style.subAgent ? INDENT_SUB_AGENT : INDENT_TOOL;
		const glyph = this.style.subAgent ? GLYPH_SUB_AGENT : GLYPH_TOOL;
		const tag = subAgentTag(this.style);

		// Wrap the plain-text body first, then prefix each line with the
		// indented glyph. Only the first line gets the glyph colored blue;
		// continuation lines get a plain indent.
		const wrapWidth = Math.max(
			1,
			width -
				indent.length -
				/* glyph + space */ 2 -
				subAgentTagWidth(this.style),
		);
		let first = true;
		for (const raw of body.split("\n")) {
			for (const wrapped of wrapTextWithAnsi(raw, wrapWidth)) {
				if (first) {
					const color = this.failed
						? chalk.red
						: this.style.subAgent
							? chalk.gray
							: chalk.blue;
					lines.push(`${indent}${color(glyph)} ${tag}${wrapped}`);
					first = false;
				} else {
					lines.push(`${indent}  ${wrapped}`);
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
	private readonly style: SubAgentLineStyle;

	constructor(
		text: string,
		tone: "error" | "info" = "info",
		style: SubAgentLineStyle = {},
	) {
		this.text = text;
		this.tone = tone;
		this.style = style;
	}

	render(width: number): string[] {
		const color = this.tone === "error" ? chalk.red : chalk.cyan;
		const indent = this.style.subAgent ? INDENT_SUB_AGENT : "";
		const tag = subAgentTag(this.style);
		const lines: string[] = [];
		let first = true;
		for (const raw of this.text.split("\n")) {
			for (const line of wrapTextWithAnsi(
				raw,
				Math.max(1, width - indent.length - subAgentTagWidth(this.style)),
			)) {
				// The tag is a prefix, not content: it rides only the first line.
				const prefix = first ? tag : "";
				first = false;
				lines.push(`${indent}${prefix}${color(line)}`);
			}
		}
		return lines;
	}

	invalidate(): void {}
}

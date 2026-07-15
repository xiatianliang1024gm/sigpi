import type { Component } from "./tui.js";
import { wrapToWidth } from "./utils.js";

const ANSI_DIM = "\x1B[2m";
const ANSI_RESET = "\x1B[0m";

/**
 * Live, in-place view of a model's streamed reasoning and content. The agent
 * loop feeds it incremental {@link ModelDelta} fragments (spec-0020) and the
 * component renders them above the input line so the user sees chain-of-thought
 * and partial answers as they arrive, instead of a frozen "thinking" status.
 *
 * The component is display-only: it never alters the agent turn control flow.
 * It is a temporary preview driven solely by in-flight `model_delta` frames and
 * is cleared by the caller on `model_request_finished` / `assistant_message` /
 * `turn_interrupted` / `turn_failed` / `truncated`.
 */
export class ReasoningStreamComponent implements Component {
	private reasoning = "";
	private content = "";
	private hasReasoning = false;
	private hasContent = false;

	appendReasoning(text: string): void {
		if (!text) {
			return;
		}
		this.reasoning += text;
		this.hasReasoning = true;
	}

	appendContent(text: string): void {
		if (!text) {
			return;
		}
		this.content += text;
		this.hasContent = true;
	}

	/** Drop all accumulated text (e.g. when a new turn starts or the turn ends). */
	clear(): void {
		this.reasoning = "";
		this.content = "";
		this.hasReasoning = false;
		this.hasContent = false;
	}

	render(width: number, maxHeight?: number): string[] {
		const lines: string[] = [];

		if (this.hasReasoning) {
			lines.push(`${ANSI_DIM}▸ reasoning${ANSI_RESET}`);
			for (const line of wrapToWidth(this.reasoning, width)) {
				lines.push(`${ANSI_DIM}  ${line}${ANSI_RESET}`);
			}
		}

		if (this.hasContent) {
			for (const line of wrapToWidth(this.content, width)) {
				lines.push(line);
			}
		}

		if (maxHeight === undefined || lines.length <= maxHeight) {
			return lines;
		}

		// Internal scroll: keep the most recent `maxHeight` lines so the prompt
		// line (rendered after this component) stays visible.
		const overflow = lines.length - maxHeight;
		const visible = lines.slice(overflow);
		visible.unshift(`${ANSI_DIM}… (${overflow} more lines)${ANSI_RESET}`);
		return visible.slice(0, maxHeight);
	}
}

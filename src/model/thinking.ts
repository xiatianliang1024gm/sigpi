/**
 * Incremental extraction of model chain-of-thought wrapped in XML-style tags:
 * `<think>…</think>`, `<mm:think>…</mm:think>`, `<reasoning>…</reasoning>`.
 *
 * Some providers (e.g. MiniMax) stream thinking inline as tagged content
 * rather than a dedicated `reasoning_content` field. Without extraction the
 * thinking is merged with the final answer in both the live preview and the
 * persisted transcript. This splitter routes the tagged text to
 * `reasoningDelta` (shown as a separate "▸ reasoning" preview) and keeps the
 * untagged text as `contentDelta` / final content.
 *
 * The splitter is incremental: a tag can be split across streamed chunks, so
 * any incomplete tag prefix at the end of a chunk is buffered until the next
 * `push`.
 */
const THINK_OPEN = ["<mm:think>", "<think>", "<reasoning>"];
const THINK_CLOSE = ["</mm:think>", "</think>", "</reasoning>"];

function isTagPrefix(text: string): boolean {
	if (text.length === 0 || text[0] !== "<") {
		return false;
	}
	return (
		THINK_OPEN.some((tag) => tag.startsWith(text)) ||
		THINK_CLOSE.some((tag) => tag.startsWith(text))
	);
}

function findTagFrom(text: string, start: number, tags: string[]): number {
	let best = -1;
	for (const tag of tags) {
		const index = text.indexOf(tag, start);
		if (index >= 0 && (best === -1 || index < best)) {
			best = index;
		}
	}
	return best;
}

function tagLengthAt(text: string, index: number, tags: string[]): number {
	for (const tag of tags) {
		if (text.startsWith(tag, index)) {
			return tag.length;
		}
	}
	return 0;
}

export class ThinkingSplitter {
	private inThinking = false;
	private tail = "";

	/** Fold a streamed content fragment; returns its reasoning and content parts. */
	push(text: string): { reasoning: string; content: string } {
		let reasoning = "";
		let content = "";
		const buffer = this.tail + text;
		// The previous tail is now part of `buffer`, so it is consumed.
		this.tail = "";
		let index = 0;

		while (index < buffer.length) {
			if (!this.inThinking) {
				const open = findTagFrom(buffer, index, THINK_OPEN);
				if (open >= 0) {
					content += buffer.slice(index, open);
					this.inThinking = true;
					index = open + tagLengthAt(buffer, open, THINK_OPEN);
					continue;
				}
			} else {
				const close = findTagFrom(buffer, index, THINK_CLOSE);
				if (close >= 0) {
					reasoning += buffer.slice(index, close);
					this.inThinking = false;
					index = close + tagLengthAt(buffer, close, THINK_CLOSE);
					continue;
				}
			}

			const nextLt = buffer.indexOf("<", index);
			if (nextLt === -1) {
				if (!this.inThinking) {
					content += buffer.slice(index);
				} else {
					reasoning += buffer.slice(index);
				}
				index = buffer.length;
			} else {
				if (!this.inThinking) {
					content += buffer.slice(index, nextLt);
				} else {
					reasoning += buffer.slice(index, nextLt);
				}
				const suffix = buffer.slice(nextLt);
				if (isTagPrefix(suffix)) {
					this.tail = suffix;
					index = buffer.length;
				} else {
					if (!this.inThinking) {
						content += "<";
					} else {
						reasoning += "<";
					}
					index = nextLt + 1;
					this.tail = "";
				}
			}
		}

		return { reasoning, content };
	}
}

/** Return `text` with any tagged thinking blocks removed (final display form). */
export function stripThinking(text: string | null | undefined): string | null {
	if (text == null) {
		return text ?? null;
	}
	return new ThinkingSplitter().push(text).content;
}

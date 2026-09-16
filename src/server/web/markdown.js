/**
 * Minimal, dependency-free Markdown → DOM renderer for the web transcript.
 *
 * The browser client ships as plain ES modules with no bundler, so pulling in a
 * full Markdown library (and its build step) would be out of proportion for what
 * assistant output needs. This covers the common subset — fenced code, ATX
 * headings, unordered/ordered lists, blockquotes, horizontal rules, GFM tables,
 * paragraphs, inline code / bold / italic, and links — while building DOM nodes
 * directly so nothing is ever assigned through `innerHTML` (no HTML-injection
 * surface).
 *
 * Emphasis deliberately supports only the asterisk forms: treating `_` as
 * emphasis would mangle identifiers like `snake_case` that show up constantly in
 * a coding assistant's output. Unmatched markers simply fall through as text,
 * which keeps a partially streamed message readable.
 */

import { buildCopyButton } from "./clipboard.js";

/** Link targets we are willing to turn into a real `href` (never `javascript:`). */
const SAFE_LINK = /^(?:https?:|mailto:|#|\/|\.{1,2}\/)/i;

/**
 * Inline spans: `code`, **bold**, *italic*, and [text](url). Built fresh per
 * call (rather than a shared module-level regex) so the recursive emphasis
 * parsing below cannot clobber a shared `lastIndex`.
 */
function renderInline(text) {
	const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
	const fragment = document.createDocumentFragment();
	let lastIndex = 0;
	let match;
	while ((match = pattern.exec(text)) !== null) {
		if (match.index > lastIndex) {
			fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
		}
		const token = match[0];
		if (token.startsWith("`")) {
			const code = document.createElement("code");
			code.textContent = token.slice(1, -1);
			fragment.append(code);
		} else if (token.startsWith("**")) {
			const strong = document.createElement("strong");
			strong.append(renderInline(token.slice(2, -2)));
			fragment.append(strong);
		} else if (token.startsWith("*")) {
			const em = document.createElement("em");
			em.append(renderInline(token.slice(1, -1)));
			fragment.append(em);
		} else {
			fragment.append(buildLink(token));
		}
		lastIndex = pattern.lastIndex;
	}
	if (lastIndex < text.length) {
		fragment.append(document.createTextNode(text.slice(lastIndex)));
	}
	return fragment;
}

/** Turn a `[text](url)` token into an anchor, or plain text when malformed. */
function buildLink(token) {
	const parsed = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
	if (!parsed) {
		return document.createTextNode(token);
	}
	const anchor = document.createElement("a");
	anchor.textContent = parsed[1];
	const href = parsed[2].trim();
	if (SAFE_LINK.test(href)) {
		anchor.href = href;
		anchor.target = "_blank";
		anchor.rel = "noopener noreferrer";
	}
	return anchor;
}

/** True when `line` could be part of a GFM table (it carries a `|` separator). */
function looksLikeTableRow(line) {
	return line.includes("|");
}

/**
 * Split a `| a | b |` row into trimmed cells. The outer pipes are optional, so
 * `a | b` and `| a | b |` yield the same two cells.
 */
function splitTableRow(line) {
	let text = line.trim();
	if (text.startsWith("|")) text = text.slice(1);
	if (text.endsWith("|")) text = text.slice(0, -1);
	return text.split("|").map((cell) => cell.trim());
}

/** One `:---:` alignment cell of a GFM delimiter row. */
const DELIMITER_CELL = /^:?-+:?$/;

/** True when `line` is a table delimiter row (`|---|:--:|`). */
function isTableDelimiter(line) {
	const cells = splitTableRow(line);
	return cells.length > 0 && cells.every((cell) => DELIMITER_CELL.test(cell));
}

/** Apply a GFM column alignment (`left`/`center`/`right`) to a header/body cell. */
function applyAlignment(cell, alignment) {
	if (alignment) cell.style.textAlign = alignment;
}

/**
 * Render a GFM table starting at `lines[start]` (the header row), whose next
 * line is the delimiter row. Returns the wrapper element and the index of the
 * first line after the table. Body rows continue while lines still carry a
 * `|`, matching how a stray paragraph immediately below a pipe row would have
 * been glued to the table by other GFM parsers.
 */
function renderTable(lines, start) {
	const header = splitTableRow(lines[start]);
	const alignments = splitTableRow(lines[start + 1]).map((cell) => {
		const left = cell.startsWith(":");
		const right = cell.endsWith(":");
		if (left && right) return "center";
		if (right) return "right";
		if (left) return "left";
		return null;
	});

	const table = document.createElement("table");
	const thead = document.createElement("thead");
	const headRow = document.createElement("tr");
	header.forEach((text, column) => {
		const th = document.createElement("th");
		applyAlignment(th, alignments[column]);
		th.append(renderInline(text));
		headRow.append(th);
	});
	thead.append(headRow);
	table.append(thead);

	const tbody = document.createElement("tbody");
	let index = start + 2;
	while (
		index < lines.length &&
		looksLikeTableRow(lines[index]) &&
		!isTableDelimiter(lines[index])
	) {
		const cells = splitTableRow(lines[index]);
		const row = document.createElement("tr");
		// Pad/truncate to the header's column count so rows stay aligned.
		header.forEach((_, column) => {
			const td = document.createElement("td");
			applyAlignment(td, alignments[column]);
			td.append(renderInline(cells[column] ?? ""));
			row.append(td);
		});
		tbody.append(row);
		index += 1;
	}
	table.append(tbody);

	// Wrap in a scroll container so wide tables scroll rather than overflow.
	const wrapper = document.createElement("div");
	wrapper.className = "table-wrap";
	wrapper.append(table);
	return { element: wrapper, index };
}

/** Flush the buffered paragraph lines into a `<p>` (with `<br>` between lines). */
function flushParagraph(fragment, lines) {
	if (lines.length === 0) return;
	const paragraph = document.createElement("p");
	lines.forEach((line, index) => {
		if (index > 0) paragraph.append(document.createElement("br"));
		paragraph.append(renderInline(line));
	});
	fragment.append(paragraph);
	lines.length = 0;
}

/**
 * Render Markdown `text` into a {@link DocumentFragment} of block elements.
 * Safe to call on partially streamed text; unfinished constructs render as
 * literal characters until completed.
 */
export function renderMarkdown(text) {
	const fragment = document.createDocumentFragment();
	const lines = String(text ?? "").split(/\r?\n/);
	const paragraph = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];

		const fence = /^\s*```(.*)$/.exec(line);
		if (fence) {
			flushParagraph(fragment, paragraph);
			const language = fence[1].trim();
			const codeLines = [];
			index += 1;
			while (index < lines.length && !/^\s*```/.test(lines[index])) {
				codeLines.push(lines[index]);
				index += 1;
			}
			index += 1; // consume the closing fence (or run off the end)
			const codeText = codeLines.join("\n");
			const pre = document.createElement("pre");
			const code = document.createElement("code");
			if (language) {
				code.className = `language-${language.replace(/[^\w-]/g, "")}`;
			}
			code.textContent = codeText;
			pre.append(code);
			// Wrap the block so a hover "copy" affordance can sit in its corner;
			// the raw code text is copied verbatim, fences excluded.
			const block = document.createElement("div");
			block.className = "code-block";
			block.append(
				pre,
				buildCopyButton({
					className: "code-copy",
					label: "复制",
					title: "复制代码",
					getText: () => codeText,
				}),
			);
			fragment.append(block);
			continue;
		}

		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			flushParagraph(fragment, paragraph);
			const level = Math.min(heading[1].length, 6);
			const el = document.createElement(`h${level}`);
			el.append(renderInline(heading[2].trim()));
			fragment.append(el);
			index += 1;
			continue;
		}

		if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
			flushParagraph(fragment, paragraph);
			fragment.append(document.createElement("hr"));
			index += 1;
			continue;
		}

		if (
			looksLikeTableRow(line) &&
			index + 1 < lines.length &&
			isTableDelimiter(lines[index + 1])
		) {
			flushParagraph(fragment, paragraph);
			const table = renderTable(lines, index);
			fragment.append(table.element);
			index = table.index;
			continue;
		}

		if (/^\s*>\s?/.test(line)) {
			flushParagraph(fragment, paragraph);
			const quoted = [];
			while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
				quoted.push(lines[index].replace(/^\s*>\s?/, ""));
				index += 1;
			}
			const blockquote = document.createElement("blockquote");
			blockquote.append(renderMarkdown(quoted.join("\n")));
			fragment.append(blockquote);
			continue;
		}

		if (/^\s*[-*+]\s+/.test(line)) {
			flushParagraph(fragment, paragraph);
			const list = document.createElement("ul");
			while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
				const item = document.createElement("li");
				item.append(renderInline(lines[index].replace(/^\s*[-*+]\s+/, "")));
				list.append(item);
				index += 1;
			}
			fragment.append(list);
			continue;
		}

		if (/^\s*\d+[.)]\s+/.test(line)) {
			flushParagraph(fragment, paragraph);
			const list = document.createElement("ol");
			while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
				const item = document.createElement("li");
				item.append(renderInline(lines[index].replace(/^\s*\d+[.)]\s+/, "")));
				list.append(item);
				index += 1;
			}
			fragment.append(list);
			continue;
		}

		if (/^\s*$/.test(line)) {
			flushParagraph(fragment, paragraph);
			index += 1;
			continue;
		}

		paragraph.push(line.trim());
		index += 1;
	}

	flushParagraph(fragment, paragraph);
	return fragment;
}

import type { JsonValue } from "../types.js";

export interface FileEditPreviewLine {
	[key: string]: JsonValue;
	kind: "add" | "remove";
	lineNumber: number | null;
	text: string;
}

export interface FileEditSummary {
	[key: string]: JsonValue;
	kind: "file_edit";
	path: string | null;
	paths: string[];
	additions: number;
	deletions: number;
	preview: FileEditPreviewLine[];
	truncated: boolean;
}

const MAX_PREVIEW_LINES = 80;

export function createEditSummary(
	relativePath: string,
	originalContent: string,
	oldString: string,
	newString: string,
	replaceAll: boolean,
): FileEditSummary {
	const removedLines = splitContentLines(oldString);
	const addedLines = splitContentLines(newString);
	const matchCount = countOccurrences(originalContent, oldString);
	const occurrences = replaceAll ? matchCount : 1;

	const preview: FileEditPreviewLine[] = [];
	const truncated = false;
	const startLine = lineNumberAtIndex(
		originalContent,
		originalContent.indexOf(oldString),
	);
	appendPreviewLines(
		preview,
		"remove",
		removedLines,
		startLine,
		() => truncated,
	);
	appendPreviewLines(preview, "add", addedLines, startLine, () => truncated);

	return {
		kind: "file_edit",
		path: relativePath,
		paths: [relativePath],
		additions: addedLines.length * occurrences,
		deletions: removedLines.length * occurrences,
		preview,
		truncated,
	};
}

export function createWriteSummary(
	relativePath: string,
	previousContent: string | null,
	nextContent: string,
): FileEditSummary {
	const removedLines =
		previousContent === null ? [] : splitContentLines(previousContent);
	const addedLines = splitContentLines(nextContent);
	const preview: FileEditPreviewLine[] = [];
	const truncated = false;

	appendPreviewLines(preview, "remove", removedLines, 1, () => truncated);
	appendPreviewLines(preview, "add", addedLines, 1, () => truncated);

	return {
		kind: "file_edit",
		path: relativePath,
		paths: [relativePath],
		additions: addedLines.length,
		deletions: removedLines.length,
		preview,
		truncated,
	};
}

export function isFileEditSummary(value: JsonValue): value is FileEditSummary {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}

	return (
		value.kind === "file_edit" &&
		typeof value.additions === "number" &&
		typeof value.deletions === "number" &&
		Array.isArray(value.preview) &&
		(value.path === null || typeof value.path === "string") &&
		Array.isArray(value.paths)
	);
}

function countOccurrences(content: string, search: string): number {
	let count = 0;
	let fromIndex = 0;
	while (true) {
		const index = content.indexOf(search, fromIndex);
		if (index === -1) {
			return count;
		}
		count += 1;
		fromIndex = index + search.length;
	}
}

function splitContentLines(value: string): string[] {
	if (!value) {
		return [];
	}

	const lines = normalizeNewlines(value).split("\n");
	if (lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
}

function normalizeNewlines(value: string): string {
	return value.replace(/\r\n?/gu, "\n");
}

function lineNumberAtIndex(value: string, index: number): number {
	if (index < 0) {
		return 1;
	}
	let line = 1;
	for (let offset = 0; offset < index; offset += 1) {
		if (value[offset] === "\n") {
			line += 1;
		}
	}
	return line;
}

function appendPreviewLines(
	preview: FileEditPreviewLine[],
	kind: FileEditPreviewLine["kind"],
	lines: string[],
	startLine: number,
	markTruncated: () => void,
): void {
	for (const [index, text] of lines.entries()) {
		if (preview.length >= MAX_PREVIEW_LINES) {
			markTruncated();
			return;
		}
		preview.push({
			kind,
			lineNumber: startLine + index,
			text,
		});
	}
}

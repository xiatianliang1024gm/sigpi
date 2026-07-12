import {
	createEditSummary,
	createWriteSummary,
	type FileEditPreviewLine,
	type FileEditSummary,
	isFileEditSummary,
} from "../tools/edit-summary.js";
import type { ExecutedToolCall, JsonValue } from "../types.js";

const RESET = "\x1B[0m";
const DIM = "\x1B[2m";
const RED_BACKGROUND = "\x1B[41m";
const GREEN_BACKGROUND = "\x1B[42m";
const BLACK_FOREGROUND = "\x1B[30m";
const BRIGHT_WHITE_FOREGROUND = "\x1B[97m";

export interface FileEditRenderOptions {
	color?: boolean;
}

export function formatFileEditSummaries(
	executions: readonly ExecutedToolCall[],
	options: FileEditRenderOptions = {},
): string[] {
	const lines: string[] = [];

	for (const execution of executions) {
		const summary = getFileEditSummary(execution);
		if (!summary) {
			continue;
		}

		lines.push(...formatFileEditSummary(summary, options));
	}

	return lines;
}

export function formatFileEditResultData(
	data: JsonValue | undefined,
	options: FileEditRenderOptions = {},
): string[] {
	const summary = getFileEditSummaryFromData(data);
	return summary ? formatFileEditSummary(summary, options) : [];
}

export function formatFileEditSummary(
	summary: FileEditSummary,
	options: FileEditRenderOptions = {},
): string[] {
	const lines = [
		`- Edited ${formatEditedPath(summary)} (+${summary.additions} -${summary.deletions})`,
	];
	const width = Math.max(
		0,
		...summary.preview.map((line) =>
			line.lineNumber === null ? 0 : String(line.lineNumber).length,
		),
	);

	for (const line of summary.preview) {
		lines.push(formatPreviewLine(line, width, options.color ?? true));
	}

	if (summary.truncated) {
		lines.push(`${DIM}  ...${RESET}`);
	}

	return lines;
}

function getFileEditSummary(
	execution: ExecutedToolCall,
): FileEditSummary | null {
	if (!execution.result.ok) {
		return null;
	}

	const data = execution.result.data;
	const dataSummary = getFileEditSummaryFromData(data);
	if (dataSummary) {
		return dataSummary;
	}

	return getFallbackSummary(execution);
}

function getFileEditSummaryFromData(
	data: JsonValue | undefined,
): FileEditSummary | null {
	if (data && typeof data === "object" && !Array.isArray(data)) {
		const editSummary = data.editSummary;
		if (editSummary !== undefined && isFileEditSummary(editSummary)) {
			return editSummary;
		}
	}

	return null;
}

function getFallbackSummary(
	execution: ExecutedToolCall,
): FileEditSummary | null {
	const args = execution.toolCall.arguments;

	switch (execution.toolCall.name) {
		case "write": {
			const relativePath = getString(args.path);
			const content = getString(args.content);
			if (!relativePath || content === null) {
				return null;
			}
			return createWriteSummary(relativePath, null, content);
		}
		case "edit": {
			const relativePath = getString(args.file_path);
			const oldString = getString(args.old_string);
			const newString = getString(args.new_string);
			if (!relativePath || oldString === null || newString === null) {
				return null;
			}
			return createEditSummary(
				relativePath,
				"",
				oldString,
				newString,
				Boolean(args.replace_all),
			);
		}

		default:
			return null;
	}
}

function formatEditedPath(summary: FileEditSummary): string {
	if (summary.path) {
		return summary.path;
	}

	const paths = summary.paths;
	if (paths.length === 1) {
		return paths[0] ?? "(unknown file)";
	}

	if (paths.length > 1) {
		return `${paths.length} files`;
	}

	return "(unknown file)";
}

function formatPreviewLine(
	line: FileEditPreviewLine,
	lineNumberWidth: number,
	color: boolean,
): string {
	const sign = line.kind === "add" ? "+" : "-";
	const lineNumber =
		line.lineNumber === null
			? " ".repeat(lineNumberWidth)
			: String(line.lineNumber).padStart(lineNumberWidth);
	const prefix = lineNumberWidth > 0 ? `${lineNumber} ${sign} ` : `${sign} `;
	const rendered = `  ${prefix}${line.text}`;

	if (!color) {
		return rendered;
	}

	const colors =
		line.kind === "add"
			? `${GREEN_BACKGROUND}${BLACK_FOREGROUND}`
			: `${RED_BACKGROUND}${BRIGHT_WHITE_FOREGROUND}`;
	return `${colors}${rendered}${RESET}`;
}

function getString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
	asInlineCode,
	getBoolean,
	getNumber,
	getString,
} from "../../progress.js";
import type { ToolDefinition } from "../../types.js";
import { resolveWorkspacePath } from "../path-utils.js";
import { ReadTracker } from "../read-tracker.js";
import {
	formatRawBlock,
	joinRenderedSections,
	withRendered,
} from "../render.js";

export const DEFAULT_READ_MAX_LINES = 2_000;
export const DEFAULT_READ_MAX_CHARS = 50 * 1_024;
// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const readSchema = z.object({
	file_path: z.string().min(1),
	offset: z.number().int().nonnegative().optional(),
	limit: z.number().int().positive().optional(),
});

type ReadArgs = z.infer<typeof readSchema>;

// ---------------------------------------------------------------------------
// Line-segment helpers
// ---------------------------------------------------------------------------

interface LineSegment {
	lineNumber: number;
	startChar: number;
	endChar: number;
	content: string;
}

function splitIntoLineSegments(content: string): LineSegment[] {
	if (content.length === 0) {
		return [{ lineNumber: 1, startChar: 0, endChar: 0, content: "" }];
	}

	const segments: LineSegment[] = [];
	let cursor = 0;
	let lineNumber = 1;

	while (cursor < content.length) {
		let lineEnd = cursor;
		while (
			lineEnd < content.length &&
			content[lineEnd] !== "\n" &&
			content[lineEnd] !== "\r"
		) {
			lineEnd += 1;
		}

		let segmentEnd = lineEnd;
		if (content[segmentEnd] === "\r" && content[segmentEnd + 1] === "\n") {
			segmentEnd += 2;
		} else if (content[segmentEnd] === "\n" || content[segmentEnd] === "\r") {
			segmentEnd += 1;
		}

		segments.push({
			lineNumber,
			startChar: cursor,
			endChar: segmentEnd,
			content: content.slice(cursor, segmentEnd),
		});

		cursor = segmentEnd;
		lineNumber += 1;
	}

	// Trailing empty line after final newline
	if (content.endsWith("\n") || content.endsWith("\r")) {
		segments.push({
			lineNumber,
			startChar: cursor,
			endChar: cursor,
			content: "",
		});
	}

	return segments;
}

// ---------------------------------------------------------------------------
// Content rendering (line-numbered)
// ---------------------------------------------------------------------------

function formatLine(lineNumber: number, pad: number, display: string): string {
	return `${String(lineNumber).padStart(pad, " ")} │ ${display}`;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export function createReadTool(tracker: ReadTracker): ToolDefinition<ReadArgs> {
	return {
		name: "read",
		description:
			"Read a file from disk and display its contents with line numbers. " +
			"Use an absolute path or a path relative to the working directory. " +
			"By default, reads from the beginning of the file. " +
			"If the entire file exceeds the character limit, returns the first page and " +
			"includes a PARTIAL notice with the metadata needed to continue reading " +
			"(use offset and limit to read more). " +
			"To read a specific range, pass explicit offset (0-based line number) and/or " +
			"limit (number of lines). When explicit offset/limit is provided and the result " +
			"still exceeds the character limit, an error is returned.",
		inputSchema: readSchema,
		parameters: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description:
						"Path to the file to read (relative to the working directory, or an absolute path).",
				},
				offset: {
					type: "integer",
					description:
						"Optional 0-based line offset to start reading from. Defaults to 0 (the beginning of the file).",
				},
				limit: {
					type: "integer",
					description:
						"Optional number of lines to read. If omitted, reads from offset to end of file (subject to the character limit).",
				},
			},
			required: ["file_path"],
			additionalProperties: false,
		},
		execute: async ({ file_path: filePath, offset, limit }, context) => {
			const { resolved, relative } = resolveWorkspacePath(
				context.cwd,
				filePath,
			);
			const content = await readFile(resolved, "utf8");
			const segments = splitIntoLineSegments(content);
			const totalLines = segments.length;
			const totalChars = content.length;

			// Determine requested range in lines (0-based)
			const startLine0 = offset ?? 0; // 0-based
			const endLineExclusive0 =
				limit !== undefined
					? Math.min(startLine0 + limit, totalLines)
					: totalLines;

			const clampedStart0 = Math.max(0, Math.min(startLine0, totalLines));
			const clampedEnd0 = Math.max(clampedStart0, endLineExclusive0);

			const requestedSegments = segments.slice(clampedStart0, clampedEnd0);
			const hasExplicitRange = offset !== undefined || limit !== undefined;

			// Build line-numbered output, capping at DEFAULT_READ_MAX_CHARS
			const linesOut: string[] = [];
			let renderedChars = 0;
			let truncated = false;
			let returnedLineStart: number | null = null;
			let returnedLineEnd: number | null = null;
			const maxLineNum = clampedEnd0;
			const pad = String(maxLineNum || 1).length;

			for (const seg of requestedSegments) {
				const display = seg.content.replace(/\r?\n?$/, "").replace(/\r$/, "");
				const formatted = formatLine(seg.lineNumber, pad, display);
				const addChars = formatted.length + 1; // +1 for newline when joining

				if (renderedChars + addChars > DEFAULT_READ_MAX_CHARS) {
					if (hasExplicitRange) {
						throw new Error(
							`The requested range (offset=${offset ?? 0}, limit=${limit ?? "∞"}) ` +
								`exceeds the maximum allowed character count (${DEFAULT_READ_MAX_CHARS}). ` +
								`Try a smaller limit.`,
						);
					}
					truncated = true;
					break;
				}

				if (returnedLineStart === null) {
					returnedLineStart = seg.lineNumber;
				}
				linesOut.push(formatted);
				renderedChars += addChars;
				returnedLineEnd = seg.lineNumber;
			}

			const renderedContent = linesOut.join("\n");

			// Record the read so the edit tool's read-before-edit check passes.
			await tracker.recordResolved(resolved).catch(() => {});

			// Continuation metadata for partial (default) reads
			let continuation: {
				path: string;
				nextOffset: number;
				suggestedLimit: number;
			} | null = null;

			if (truncated && !hasExplicitRange && returnedLineEnd !== null) {
				// returnedLineEnd is 1-based. Next offset (0-based) = returnedLineEnd
				// (since offset 0 = line 1, offset N = line N+1)
				const nextOffset0 = returnedLineEnd;
				const returnedCount =
					returnedLineEnd - (returnedLineStart ?? returnedLineEnd) + 1;
				continuation = {
					path: relative,
					nextOffset: nextOffset0,
					suggestedLimit: Math.max(returnedCount, 100),
				};
			}

			// Build summary
			const size =
				totalChars < 1024
					? `${totalChars} chars`
					: `${totalChars} chars (~${(totalChars / 1024).toFixed(1)}KB)`;

			const summaryLine =
				returnedLineStart !== null && returnedLineEnd !== null
					? `[Read ${relative} lines ${returnedLineStart}-${returnedLineEnd} of ${totalLines} (${size})]`
					: `[Read ${relative} (${size}, ${totalLines} lines)]`;

			const partialNotice =
				truncated && !hasExplicitRange && continuation
					? `[PARTIAL view – received lines ${returnedLineStart}-${returnedLineEnd} of ${totalLines} (${renderedChars} of ${DEFAULT_READ_MAX_CHARS} chars used). ` +
						`Use read({"file_path":"${relative}","offset":${continuation.nextOffset},"limit":${continuation.suggestedLimit}}) to continue reading from line ${continuation.nextOffset + 1}.]`
					: null;

			const rendered = joinRenderedSections([
				summaryLine,
				partialNotice,
				formatRawBlock("Content", renderedContent || "(empty)", {
					omitLabel: true,
				}),
			]);

			return withRendered(
				{
					totalLines,
					totalChars,
					returnedLineStart,
					returnedLineEnd,
					returnedChars: renderedChars,
					truncated,
					continuation,
					content: renderedContent,
				},
				rendered,
			);
		},
		describeProgress(args) {
			return {
				summary: `read ${asInlineCode(getString(args.file_path) ?? "(unknown file)")}`,
			};
		},
		recordLedger(recorder, toolCall, result) {
			const path = getString(toolCall.arguments.file_path);
			if (!path) {
				return;
			}
			const data = (result.data ?? null) as Record<string, unknown> | null;
			recorder.read(path, {
				startLine: getNumber(data?.returnedLineStart) ?? undefined,
				endLine: getNumber(data?.returnedLineEnd) ?? undefined,
				truncated: getBoolean(data?.truncated) ?? undefined,
			});
		},
	};
}

export const readTool: ToolDefinition<ReadArgs> = createReadTool(
	// Backward-compatible default; production wiring uses the shared tracker.
	new ReadTracker(),
);

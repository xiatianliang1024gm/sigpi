import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { asInlineCode, getNumber, getString } from "../../progress.js";
import type { ToolDefinition } from "../../types.js";
import { resolveWorkspacePath } from "../path-utils.js";
import { ReadTracker } from "../read-tracker.js";
import { joinRenderedSections, withRendered } from "../render.js";

export const DEFAULT_READ_MAX_LINES = 2_000;
const DEFAULT_READ_MAX_CHARS = 50 * 1_024;

/**
 * How many rendered ranges one tool instance remembers. A session can read
 * thousands of ranges, so the cache is bounded (and LRU-ordered: a hit
 * refreshes the entry).
 */
const READ_CACHE_MAX_ENTRIES = 200;

type ReadFingerprint = { mtimeMs: number; size: number };

type ReadContinuation = {
	path: string;
	nextOffset: number;
	suggestedLimit: number;
};

type ReadData = {
	totalLines: number;
	totalChars: number;
	returnedLineStart: number | null;
	returnedLineEnd: number | null;
	returnedChars: number;
	truncated: boolean;
	continuation: ReadContinuation | null;
	content: string;
	rendered: string;
};
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

export function createReadTool(
	tracker: ReadTracker,
): ToolDefinition<ReadArgs, ReadData> {
	/**
	 * Rendered results of the ranges this conversation already read, keyed by
	 * (path, offset, limit) and validated against the file fingerprint.
	 *
	 * Re-reading a range is the signature of the failure the compaction planner
	 * now prevents: the model's earlier result was elided from the request, so
	 * it fetches the same bytes again. The cache cannot undo that (the text has
	 * to be re-sent), but it makes the repeat deterministic — identical bytes,
	 * no disk read — and it makes the repeat *visible*, which is how the
	 * measurement in `scripts/micro-compact-replay.mjs` counts it.
	 */
	const cache = new Map<
		string,
		{ fingerprint: ReadFingerprint; data: ReadData }
	>();

	return {
		name: "read",
		description:
			"Read a file from disk and display its contents with line numbers. " +
			"Use an absolute path or a path relative to the working directory. " +
			"By default, reads from the beginning of the file. " +
			"If the file exceeds the character limit, returns the first page and " +
			"includes a PARTIAL notice with the metadata needed to continue reading. " +
			"To read a specific range, pass explicit offset (0-based line number) and/or " +
			"limit (number of lines); a range that still exceeds the character limit is " +
			"paged the same way, with a continuation notice. " +
			"When returning a page, always continue from the line named in the notice " +
			"before reading a different part of the file.",
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
			const cacheKey = `${resolved}\u0000${offset ?? ""}\u0000${limit ?? ""}`;
			// Fingerprint before reading, so a cache entry always pairs its
			// content with the version that content was read from.
			const fingerprint = await statFingerprint(resolved);
			const cached = cache.get(cacheKey);
			if (
				cached &&
				fingerprint &&
				sameFingerprint(cached.fingerprint, fingerprint)
			) {
				cache.delete(cacheKey);
				cache.set(cacheKey, cached);
				await tracker.recordResolved(resolved).catch(() => {});
				context.logger?.debug("read_cache_hit", {
					path: relative,
					offset: offset ?? null,
					limit: limit ?? null,
					chars: cached.data.returnedChars,
				});
				return cached.data;
			}
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
					// A range that cannot be paged *by line* — its very first line
					// is longer than the cap — is the one case where returning a
					// page would return nothing at all, so it stays an error with
					// a remedy attached.
					//
					// Everything else pages like a default read, whether or not
					// the caller passed offset/limit. An explicit range that
					// overflowed used to be a hard error, which pushed the model
					// into trial-and-error paging: the reported session read
					// `manager.ts` in four separate attempts and `types.ts` in
					// two, re-fetching whole files to find line numbers it could
					// have been handed directly.
					if (linesOut.length === 0) {
						throw new Error(
							`The requested range (offset=${offset ?? 0}, limit=${limit ?? "∞"}) ` +
								`exceeds the maximum allowed character count (${DEFAULT_READ_MAX_CHARS}): ` +
								"its first line alone is longer than that limit, so it cannot be paged " +
								"by line. Read a smaller range, or use bash (e.g. head -c) to slice the file.",
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

			// Continuation metadata for any partial page, default or explicit.
			let continuation: ReadContinuation | null = null;

			if (truncated && returnedLineEnd !== null) {
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

			const rendered = joinRenderedSections([
				renderedContent || "(empty)",
				continuation
					? `[...truncated, continue from line ${continuation.nextOffset + 1}]`
					: null,
			]);

			const data: ReadData = withRendered(
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
			if (fingerprint) {
				cache.set(cacheKey, { fingerprint, data });
				trimReadCache(cache);
			}
			return data;
		},
		describeProgress(args) {
			const offsetNum = getNumber(args.offset);
			const limitNum = getNumber(args.limit);
			let rangeSuffix = "";
			if (offsetNum !== null && limitNum !== null) {
				rangeSuffix = ` [${offsetNum}, ${offsetNum + limitNum}]`;
			} else if (offsetNum !== null) {
				rangeSuffix = ` [${offsetNum}, ...]`;
			} else if (limitNum !== null) {
				rangeSuffix = ` [0, ${limitNum}]`;
			}
			return {
				summary: `read ${asInlineCode(getString(args.file_path) ?? "(unknown file)")}${rangeSuffix}`,
			};
		},
	};
}

export const readTool: ToolDefinition<ReadArgs> = createReadTool(
	// Backward-compatible default; production wiring uses the shared tracker.
	new ReadTracker(),
);

/**
 * `{mtimeMs, size}` of a path, or null when it cannot be stat'd (missing file,
 * permission error) — in which case the caller reads and surfaces the real
 * error, and the result is simply not cached.
 */
async function statFingerprint(
	resolved: string,
): Promise<ReadFingerprint | null> {
	try {
		const stats = await stat(resolved);
		return { mtimeMs: stats.mtimeMs, size: stats.size };
	} catch {
		return null;
	}
}

function sameFingerprint(a: ReadFingerprint, b: ReadFingerprint): boolean {
	return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** Evict least-recently-used entries; a hit re-inserts, so the order is LRU. */
function trimReadCache(
	cache: Map<string, { fingerprint: ReadFingerprint; data: ReadData }>,
): void {
	while (cache.size > READ_CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next();
		if (oldest.done) {
			return;
		}
		cache.delete(oldest.value);
	}
}

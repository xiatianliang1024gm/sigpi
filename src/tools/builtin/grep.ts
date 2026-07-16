import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type ZodType, z } from "zod";
import { extractPathsFromSearchOutput } from "../../agent/exploration-ledger.js";
import {
	asInlineCode,
	asQuoted,
	getBoolean,
	getNumber,
	getString,
	getStringArray,
} from "../../progress.js";
import type { ToolDefinition } from "../../types.js";
import {
	grepWorkspaceContentFallback,
	isRgUnavailable,
} from "../local-search.js";
import { resolveWorkspacePath } from "../path-utils.js";
import {
	formatRawBlock,
	joinRenderedSections,
	withRendered,
} from "../render.js";

const execFileAsync = promisify(execFile);
type ExecFileAsync = typeof execFileAsync;
const DEFAULT_HEAD_LIMIT = 50;
const SEARCH_OUTPUT_MAX_CHARS = 12_000;
const SEARCH_STDERR_MAX_CHARS = 2_000;
const SEARCH_MAX_LINE_CHARS = 500;

type GrepArgs = {
	pattern: string;
	path?: string;
	glob?: string;
	type?: string;
	output_mode?: "content" | "files_with_matches" | "count";
	case_sensitive?: boolean;
	multiline?: boolean;
	context?: number;
	head_limit?: number;
	offset?: number;
};

const grepSchema: ZodType<GrepArgs> = z.object({
	pattern: z.string().min(1),
	path: z.string().min(1).optional(),
	glob: z.string().min(1).optional(),
	type: z.string().min(1).optional(),
	output_mode: z
		.enum(["content", "files_with_matches", "count"])
		.default("files_with_matches"),
	case_sensitive: z.boolean().optional(),
	multiline: z.boolean().optional(),
	context: z.number().int().min(0).max(10).optional(),
	head_limit: z.number().int().positive().max(500).optional(),
	offset: z.number().int().min(0).optional(),
});

export function createGrepTool(
	execImpl: ExecFileAsync = execFileAsync,
): ToolDefinition<GrepArgs> {
	return {
		name: "grep",
		description:
			"Search file contents for a pattern using ripgrep. Use this to find symbols, strings, config keys, or the files that mention a term. " +
			"Where glob finds files by name, grep finds lines inside them. Patterns use ripgrep regex syntax; regex metacharacters must be escaped. " +
			"Respects .gitignore (gitignored files are skipped); to search a gitignored file, pass its path directly.",
		inputSchema: grepSchema,
		parameters: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description:
						"Regular expression to search for inside files (ripgrep syntax). Required. Escape regex metacharacters such as {}[]()^$.*+?|\\.",
				},
				path: {
					type: "string",
					description:
						"Optional path to search within, relative to the workspace root. A directory scopes the search; a file path searches just that file (and bypasses .gitignore). Defaults to the workspace root.",
				},
				glob: {
					type: "string",
					description:
						"Optional ripgrep glob to narrow which files are searched, such as src/**/*.ts or *.md.",
				},
				type: {
					type: "string",
					description:
						"Optional ripgrep file type to filter by, such as py, rust, js, or ts.",
				},
				output_mode: {
					type: "string",
					enum: ["content", "files_with_matches", "count"],
					description:
						"content returns matching lines with file and line number; files_with_matches returns only file paths that contain a match (default); count returns the match count per file.",
				},
				case_sensitive: {
					type: "boolean",
					description:
						"Whether the search is case-sensitive. Defaults to false.",
				},
				multiline: {
					type: "boolean",
					description:
						"Whether the pattern may match across line boundaries. Defaults to false (single-line).",
				},
				context: {
					type: "integer",
					description:
						"Number of context lines to include around each match when output_mode is content. Defaults to 0.",
				},
				head_limit: {
					type: "integer",
					description:
						"Maximum number of results to return after output budgeting. Defaults to 50.",
				},
				offset: {
					type: "integer",
					description:
						"Number of results to skip from the start. Useful for paginating through large result sets.",
				},
			},
			required: ["pattern"],
			additionalProperties: false,
		},
		execute: async (
			{
				pattern,
				path: searchPathArg,
				glob,
				type,
				output_mode = "files_with_matches",
				case_sensitive = false,
				multiline = false,
				context: contextLines = 0,
				head_limit = DEFAULT_HEAD_LIMIT,
				offset = 0,
			},
			context,
		) => {
			const searchPath = searchPathArg ?? ".";
			const { resolved } = resolveWorkspacePath(context.cwd, searchPath);

			const args = buildRipgrepArgs({
				pattern,
				searchPath,
				glob,
				type,
				output_mode,
				case_sensitive,
				multiline,
				context: contextLines,
				head_limit,
				offset,
			});

			let result: { exitCode: number; stdout: string; stderr: string };

			try {
				const { stdout, stderr } = await execImpl("rg", args, {
					cwd: context.cwd,
					maxBuffer: 1024 * 1024,
				});

				result = {
					exitCode: 0,
					stdout,
					stderr,
				};
			} catch (error) {
				const rgError = error as NodeJS.ErrnoException & {
					stdout?: string;
					stderr?: string;
					code?: number | string;
				};

				if (String(rgError.code) === "1") {
					result = {
						exitCode: 1,
						stdout: rgError.stdout ?? "",
						stderr: rgError.stderr ?? "",
					};
				} else if (isRgUnavailable(error)) {
					const fallback = await grepWorkspaceContentFallback({
						cwd: context.cwd,
						startPath: resolved,
						pattern,
						glob,
						type,
						case_sensitive,
						multiline,
						context: contextLines,
						output_mode,
						head_limit,
						offset,
					});
					const normalized = normalizeSearchOutput({
						stdout: fallback.output,
						output_mode,
						head_limit: Number.MAX_SAFE_INTEGER,
						offset: 0,
					});

					const fallbackNote = fallback.degraded
						? "ripgrep not available; used Node filesystem fallback. Note: `type`/`multiline` filters were not applied."
						: "ripgrep not available; used Node filesystem fallback.";

					return withRendered(
						{
							output_mode,
							pattern,
							path: searchPathArg ?? null,
							glob: glob ?? null,
							type: type ?? null,
							exitCode: 0,
							totalMatchCount: fallback.resultCount,
							returnedMatchCount: normalized.returnedMatchCount,
							truncated: normalized.truncated,
							matches: normalized.outputText,
							stderr: fallbackNote,
							usedFallback: true,
						},
						renderGrepResult({
							output_mode,
							pattern,
							path: searchPathArg ?? null,
							glob: glob ?? null,
							type: type ?? null,
							exitCode: 0,
							totalMatchCount: fallback.resultCount,
							returnedMatchCount: normalized.returnedMatchCount,
							truncated: normalized.truncated,
							outputText: normalized.outputText,
							stderr: fallbackNote,
							usedFallback: true,
						}),
					);
				} else {
					throw new Error(rgError.stderr || rgError.message);
				}
			}
			const normalized = normalizeSearchOutput({
				stdout: result.stdout,
				output_mode,
				head_limit,
				offset,
			});
			const totalMatchCount = normalized.totalMatchCount;
			const stderr = truncate(result.stderr, SEARCH_STDERR_MAX_CHARS);

			return withRendered(
				{
					output_mode,
					pattern,
					path: searchPathArg ?? null,
					glob: glob ?? null,
					type: type ?? null,
					exitCode: result.exitCode,
					totalMatchCount,
					returnedMatchCount: normalized.returnedMatchCount,
					truncated: normalized.truncated,
					matches: normalized.outputText,
					stderr,
					usedFallback: false,
				},
				renderGrepResult({
					output_mode,
					pattern,
					path: searchPathArg ?? null,
					glob: glob ?? null,
					type: type ?? null,
					exitCode: result.exitCode,
					totalMatchCount,
					returnedMatchCount: normalized.returnedMatchCount,
					truncated: normalized.truncated,
					outputText: normalized.outputText,
					stderr,
					usedFallback: false,
				}),
			);
		},
		describeProgress(args) {
			const pattern = getString(args.pattern) ?? "";
			const output = getString(args.output_mode) ?? "files_with_matches";
			const globText = args.glob
				? ` matching ${asInlineCode(String(args.glob))}`
				: "";
			if (output === "files_with_matches") {
				return {
					summary: `search files mentioning ${asQuoted(pattern)}${globText}`,
				};
			}
			return { summary: `search ${asQuoted(pattern)}${globText}` };
		},
		recordLedger(recorder, toolCall, result) {
			const pattern = getString(toolCall.arguments.pattern) ?? "";
			const output = getString(toolCall.arguments.output_mode) ?? null;
			const glob = getString(toolCall.arguments.glob) ?? null;
			const caseSensitive =
				getBoolean(toolCall.arguments.case_sensitive) ?? null;
			const data = (result.data ?? null) as Record<string, unknown> | null;
			const totalMatchCount = getNumber(data?.totalMatchCount);
			const truncated = getBoolean(data?.truncated);
			recorder.search({
				query: pattern,
				glob,
				output,
				caseSensitive,
				resultCount: totalMatchCount,
				truncated,
			});
			recorder.finding(
				`Search "${truncate(pattern, 80)}"${
					totalMatchCount === null ? "" : ` found ${totalMatchCount}`
				} match(es)${truncated ? " and was truncated" : ""}.`,
			);
			const matches = getString(data?.matches);
			if (matches) {
				for (const found of extractPathsFromSearchOutput(matches)) {
					recorder.candidate(found);
				}
			}
			for (const file of getStringArray(data?.files)) {
				recorder.candidate(file);
			}
		},
	};
}

export const grepTool: ToolDefinition<GrepArgs> = createGrepTool();

function buildRipgrepArgs(args: {
	pattern: string;
	searchPath: string;
	glob?: string;
	type?: string;
	output_mode: "content" | "files_with_matches" | "count";
	case_sensitive: boolean;
	multiline: boolean;
	context: number;
	head_limit: number;
	offset: number;
}): string[] {
	const rgArgs: string[] = [
		"--glob",
		"!.git",
		"--glob",
		"!node_modules",
		"--glob",
		"!dist",
	];

	if (!args.case_sensitive) {
		rgArgs.push("-i");
	}

	if (args.multiline) {
		rgArgs.push("-U");
	}

	if (args.type) {
		rgArgs.push("-t", args.type);
	}

	if (args.output_mode === "files_with_matches") {
		rgArgs.push("--files-with-matches");
	} else if (args.output_mode === "count") {
		rgArgs.push("--count");
	} else {
		rgArgs.push("--line-number", "--with-filename");
		if (args.context > 0) {
			rgArgs.push("-C", String(args.context));
		}
		rgArgs.push("--max-count", String(args.head_limit + args.offset));
	}

	if (args.glob) {
		rgArgs.push("-g", args.glob);
	}

	rgArgs.push("-e", args.pattern, args.searchPath);
	return rgArgs;
}

function countResults(
	stdout: string,
	output_mode: "content" | "files_with_matches" | "count",
): number {
	if (!stdout.trim()) {
		return 0;
	}

	if (output_mode === "content") {
		return stdout.split("\n").filter((line) => /^\S.*:\d+:/u.test(line)).length;
	}

	return stdout.trim().split("\n").length;
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}

	return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function normalizeSearchOutput(args: {
	stdout: string;
	output_mode: "content" | "files_with_matches" | "count";
	head_limit: number;
	offset: number;
}): {
	outputText: string;
	returnedMatchCount: number;
	totalMatchCount: number;
	truncated: boolean;
} {
	const rawLines = args.stdout.split("\n").filter((line) => line.length > 0);

	const sliceRange = (lines: string[]) => {
		const sliced = lines.slice(args.offset, args.offset + args.head_limit);
		const truncated = lines.length > args.offset + args.head_limit;
		return { sliced, truncated };
	};

	if (
		args.output_mode === "files_with_matches" ||
		args.output_mode === "count"
	) {
		const { sliced, truncated } = sliceRange(rawLines);
		const clamped = clampSearchText(
			sliced.map(truncateLine),
			sliced.length,
			truncated,
		);
		return {
			outputText: clamped.outputText,
			returnedMatchCount: sliced.length,
			totalMatchCount: rawLines.length,
			truncated: clamped.truncated,
		};
	}

	// content mode: keep match lines within [offset, offset + head_limit) plus context
	const kept: string[] = [];
	const pendingContext: string[] = [];
	let matchIndex = -1;
	let returnedMatchCount = 0;
	let truncated = false;

	for (const line of rawLines) {
		const isContext = /^\S.*:\d+-:/u.test(line);
		const isMatch = /^\S.*:\d+:/u.test(line) && !isContext;

		if (isMatch) {
			matchIndex += 1;
			if (matchIndex < args.offset) {
				pendingContext.length = 0;
				continue;
			}
			if (matchIndex >= args.offset + args.head_limit) {
				truncated = true;
				break;
			}
			kept.push(...pendingContext, line);
			pendingContext.length = 0;
			returnedMatchCount += 1;
		} else if (isContext) {
			if (
				matchIndex >= args.offset &&
				matchIndex < args.offset + args.head_limit
			) {
				kept.push(line);
			} else {
				pendingContext.push(line);
			}
		} else if (
			matchIndex >= args.offset &&
			matchIndex < args.offset + args.head_limit
		) {
			kept.push(line);
		}
	}

	const clamped = clampSearchText(kept, returnedMatchCount, truncated);
	return {
		outputText: clamped.outputText,
		returnedMatchCount,
		totalMatchCount: countResults(args.stdout, args.output_mode),
		truncated: clamped.truncated,
	};
}

function clampSearchText(
	lines: string[],
	returnedMatchCount: number,
	alreadyTruncated: boolean,
): { outputText: string; returnedMatchCount: number; truncated: boolean } {
	let chars = 0;
	const kept: string[] = [];
	let truncated = alreadyTruncated;

	for (const line of lines) {
		const addedChars = line.length + (kept.length > 0 ? 1 : 0);
		if (chars + addedChars > SEARCH_OUTPUT_MAX_CHARS) {
			truncated = true;
			break;
		}
		kept.push(line);
		chars += addedChars;
	}

	return {
		outputText: kept.join("\n"),
		returnedMatchCount,
		truncated,
	};
}

function truncateLine(line: string): string {
	if (line.length <= SEARCH_MAX_LINE_CHARS) {
		return line;
	}
	return `${line.slice(0, SEARCH_MAX_LINE_CHARS)}...[line truncated]`;
}

function renderGrepResult(result: {
	output_mode: "content" | "files_with_matches" | "count";
	pattern: string;
	path: string | null;
	glob: string | null;
	type: string | null;
	exitCode: number;
	totalMatchCount: number;
	returnedMatchCount: number;
	truncated: boolean;
	outputText: string;
	stderr: string;
	usedFallback: boolean;
}): string {
	return joinRenderedSections([
		`Result count: ${result.returnedMatchCount}`,
		`Total match count: ${result.totalMatchCount}`,
		`Truncated: ${result.truncated ? "yes" : "no"}`,
		result.outputText
			? formatRawBlock("Matches", result.outputText)
			: "Matches: (empty)",
		result.stderr ? `Note: ${result.stderr}` : null,
		result.usedFallback ? "Engine: Node.js fallback" : null,
	]);
}

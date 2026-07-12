import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { extractPathsFromSearchOutput } from "../../agent/exploration-ledger.js";
import { asQuoted, getString, getStringArray } from "../../progress.js";
import type { ToolDefinition } from "../../types.js";
import { isRgUnavailable } from "../local-search.js";
import { resolveWorkspacePath } from "../path-utils.js";
import { joinRenderedSections, withRendered } from "../render.js";

const execFileAsync = promisify(execFile);
type ExecFileAsync = typeof execFileAsync;

const MAX_RESULTS = 100;

const globSchema = z.object({
	pattern: z.string().min(1),
	path: z.string().min(1).optional(),
});

type GlobArgs = z.infer<typeof globSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively list files under a directory with their mtime stats.
 * Returns newest-first.
 */
async function listFilesWithMtime(
	dir: string,
	cwd: string,
): Promise<Array<{ relative: string; mtimeMs: number }>> {
	const { readdir } = await import("node:fs/promises");
	const path = await import("node:path");

	const IGNORED = new Set([".git", "node_modules", "dist"]);

	const results: Array<{ relative: string; mtimeMs: number }> = [];

	async function walk(absoluteDir: string) {
		const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(
			() => [],
		);
		for (const entry of entries) {
			if (IGNORED.has(entry.name)) continue;
			const abs = path.join(absoluteDir, entry.name);
			if (entry.isDirectory()) {
				await walk(abs);
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				const rel = toPosix(path.relative(cwd, abs));
				try {
					const s = await stat(abs);
					results.push({ relative: rel, mtimeMs: s.mtimeMs });
				} catch {
					// ignore inaccessible
				}
			}
		}
	}

	await walk(dir);
	results.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return results;
}

/**
 * Convert a `**`-aware glob pattern into a RegExp for simple in-process matching.
 * Supports: *, **, ?, {a,b} groups, and character classes.
 */
function globToRegex(pattern: string): RegExp {
	const normalized = toPosix(pattern);
	let source = "^";

	for (let i = 0; i < normalized.length; i++) {
		const ch = normalized.charAt(i);

		if (ch === "*") {
			if (normalized[i + 1] === "*" && normalized[i + 2] === "/") {
				source += "(?:.*/)?";
				i += 2;
			} else if (normalized[i + 1] === "*") {
				source += ".*";
				i += 1;
			} else {
				source += "[^/]*";
			}
		} else if (ch === "?") {
			source += "[^/]";
		} else if (ch === "{") {
			// simple {a,b} expansion
			const endBrace = normalized.indexOf("}", i);
			if (endBrace === -1) {
				source += "\\{";
			} else {
				const inner = normalized.slice(i + 1, endBrace);
				const alts = inner
					.split(",")
					.map((a) => globToRegex(a.trim()).source.slice(1, -1)); // strip ^ / $
				source += `(?:${alts.join("|")})`;
				i = endBrace;
			}
		} else if (/[-/\\^$+?.()|[\]}]/u.test(ch)) {
			source += `\\${ch}`;
		} else {
			source += ch;
		}
	}

	source += "$";
	return new RegExp(source, "u");
}

function toPosix(value: string): string {
	return value.split("\\").join("/");
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export function createGlobTool(
	execImpl: ExecFileAsync = execFileAsync,
): ToolDefinition<GlobArgs> {
	return {
		name: "glob",
		description:
			"Find files by name pattern. Supports standard glob patterns including ** for recursive directory matching. " +
			"Examples: **/*.js matches all .js files at any depth, src/**/*.ts matches all .ts files under src/, " +
			"*.{json,yaml} matches .json and .yaml files in the current directory. " +
			"Results are sorted by modification time (newest first) and limited to the most recent 100 files. " +
			"If the limit is reached, a truncated flag is set and you can narrow the pattern.",
		inputSchema: globSchema,
		parameters: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description:
						"Glob pattern to match files against. Use ** for recursive directory matching. " +
						"Examples: **/*.ts, src/**/*.ts, *.{json,yaml,md}.",
				},
				path: {
					type: "string",
					description:
						"Optional subdirectory to search within, relative to the workspace root. " +
						"Defaults to the workspace root.",
				},
			},
			required: ["pattern"],
			additionalProperties: false,
		},
		execute: async ({ pattern, path: searchPath }, context) => {
			const resolvedPath = searchPath ?? ".";
			const { resolved } = resolveWorkspacePath(
				context.cwd,
				resolvedPath,
				context.allowedReadRoots ?? [],
			);

			// Try ripgrep first for speed
			const rgResult = await tryRg(
				pattern,
				resolvedPath,
				context.cwd,
				execImpl,
			);

			if (rgResult !== null) {
				return rgResult;
			}

			// Fallback: list files, filter by glob, sort by mtime
			const filesWithMtime = await listFilesWithMtime(resolved, context.cwd);
			const matcher = globToRegex(pattern);
			const matched = filesWithMtime.filter((f) => matcher.test(f.relative));
			const totalFound = matched.length;
			const truncated = totalFound > MAX_RESULTS;
			const files = matched.slice(0, MAX_RESULTS).map((f) => f.relative);

			return withRendered(
				{
					pattern,
					path: searchPath ?? null,
					totalFound,
					returned: files.length,
					truncated,
					files,
					stderr:
						"ripgrep not available; used Node filesystem fallback (mtime-sorted).",
				},
				renderResult({
					pattern,
					path: searchPath ?? null,
					totalFound,
					returned: files.length,
					truncated,
					files,
					stderr:
						"ripgrep not available; used Node filesystem fallback (mtime-sorted).",
				}),
			);
		},
		describeProgress(args) {
			return {
				summary: `find files matching ${asQuoted(getString(args.pattern) ?? "*")}`,
			};
		},
		recordLedger(_recorder, _toolCall, result) {
			const data = (result.data ?? null) as Record<string, unknown> | null;
			for (const file of getStringArray(data?.files)) {
				_recorder.candidate(file);
			}
			const matches = getString(data?.matches);
			if (matches) {
				for (const found of extractPathsFromSearchOutput(matches)) {
					_recorder.candidate(found);
				}
			}
		},
	};
}

export const globTool: ToolDefinition<GlobArgs> = createGlobTool();

// ---------------------------------------------------------------------------
// Ripgrep path
// ---------------------------------------------------------------------------

async function tryRg(
	pattern: string,
	searchPath: string,
	cwd: string,
	execImpl: ExecFileAsync,
) {
	const args = [
		"--files",
		"--hidden",
		"--glob",
		"!.git",
		"--glob",
		"!node_modules",
		"--glob",
		"!dist",
		"-g",
		pattern,
		searchPath,
	];

	try {
		const { stdout, stderr } = await execImpl("rg", args, {
			cwd,
			maxBuffer: 1024 * 1024,
		});

		const lines = stdout
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);

		const totalFound = lines.length;
		const truncated = totalFound > MAX_RESULTS;
		const files = lines.slice(0, MAX_RESULTS);

		// rg doesn't sort by mtime; try to sort if we have fewer than max
		let sortedFiles = files;
		if (!truncated && files.length > 0) {
			sortedFiles = await sortByMtime(files, cwd);
		}

		return withRendered(
			{
				pattern,
				path: searchPath === "." ? null : searchPath,
				totalFound,
				returned: sortedFiles.length,
				truncated,
				files: sortedFiles,
				stderr: stderr || "",
			},
			renderResult({
				pattern,
				path: searchPath === "." ? null : searchPath,
				totalFound,
				returned: sortedFiles.length,
				truncated,
				files: sortedFiles,
				stderr: "",
			}),
		);
	} catch (error) {
		if (!isRgUnavailable(error)) {
			throw error;
		}
		return null; // signal caller to fallback
	}
}

async function sortByMtime(files: string[], cwd: string): Promise<string[]> {
	const path = await import("node:path");
	const entries: Array<{ relative: string; mtimeMs: number }> = [];

	for (const file of files) {
		const abs = path.resolve(cwd, file);
		try {
			const s = await stat(abs);
			entries.push({ relative: file, mtimeMs: s.mtimeMs });
		} catch {
			entries.push({ relative: file, mtimeMs: 0 });
		}
	}

	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return entries.map((e) => e.relative);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderResult(result: {
	pattern: string;
	path: string | null;
	totalFound: number;
	returned: number;
	truncated: boolean;
	files: string[];
	stderr: string;
}): string {
	return joinRenderedSections([
		`Pattern: ${result.pattern}`,
		`Path: ${result.path ?? "(root)"}`,
		`Matches: ${result.returned} returned${result.truncated ? ` of ${result.totalFound}` : ""}`,
		result.files.length > 0
			? ["Files:", ...result.files.map((file) => `- ${file}`)].join("\n")
			: "Files:\n- (none)",
		result.stderr ? `Note: ${result.stderr}` : null,
	]);
}

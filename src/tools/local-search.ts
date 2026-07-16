import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "./path-utils.js";

const IGNORED_NAMES = new Set([
	".git",
	"node_modules",
	"dist",
	".pnpm-store",
	"logs",
	"coverage",
	"tmp",
]);

const MAX_TEXT_FILE_BYTES = 2_000_000;

export function isRgUnavailable(error: unknown): boolean {
	if (!error || typeof error !== "object") {
		return false;
	}

	const maybeError = error as { code?: string; message?: string };
	return (
		maybeError.code === "ENOENT" ||
		/spawn rg ENOENT/i.test(maybeError.message ?? "")
	);
}

function buildFallbackRegex(pattern: string, caseSensitive: boolean): RegExp {
	const flags = caseSensitive ? "" : "i";
	try {
		return new RegExp(pattern, flags);
	} catch {
		const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		return new RegExp(escaped, flags);
	}
}

export async function grepWorkspaceContentFallback(args: {
	cwd: string;
	startPath: string;
	pattern: string;
	glob?: string;
	type?: string;
	case_sensitive: boolean;
	multiline: boolean;
	context: number;
	output_mode: "content" | "files_with_matches" | "count";
	head_limit: number;
	offset: number;
}): Promise<{ output: string; resultCount: number; degraded: boolean }> {
	const { resolved } = resolveWorkspacePath(args.cwd, args.startPath);
	const matcher = args.glob ? createGlobMatcher(args.glob) : null;
	const regex = buildFallbackRegex(args.pattern, args.case_sensitive);
	const degraded = Boolean(args.type) || args.multiline;

	const rootStat = await stat(resolved).catch(() => null);
	if (!rootStat) {
		return { output: "", resultCount: 0, degraded };
	}

	type GrepAcc = {
		filesWithMatches: Set<string>;
		countByFile: Map<string, number>;
		contentLines: string[];
		matchCount: number;
		stopped: boolean;
	};

	const acc: GrepAcc = {
		filesWithMatches: new Set<string>(),
		countByFile: new Map<string, number>(),
		contentLines: [],
		matchCount: 0,
		stopped: false,
	};

	const runOnLines = (fileLines: string[], relativePath: string) => {
		if (acc.stopped) {
			return;
		}
		for (let i = 0; i < fileLines.length; i += 1) {
			const line = fileLines[i] ?? "";
			if (!regex.test(line)) {
				continue;
			}

			if (args.output_mode === "files_with_matches") {
				if (!acc.filesWithMatches.has(relativePath)) {
					acc.filesWithMatches.add(relativePath);
					if (acc.filesWithMatches.size >= args.head_limit) {
						acc.stopped = true;
						return;
					}
				}
				return;
			}

			if (args.output_mode === "count") {
				acc.countByFile.set(
					relativePath,
					(acc.countByFile.get(relativePath) ?? 0) + 1,
				);
				continue;
			}

			// content mode
			acc.matchCount += 1;
			if (acc.matchCount <= args.offset) {
				continue;
			}
			if (acc.matchCount > args.offset + args.head_limit) {
				acc.stopped = true;
				return;
			}

			const start = Math.max(0, i - args.context);
			const end = Math.min(fileLines.length - 1, i + args.context);
			for (let j = start; j <= end; j += 1) {
				const marker = j === i ? ":" : "-";
				acc.contentLines.push(
					`${relativePath}${marker}${j + 1}:${fileLines[j] ?? ""}`,
				);
			}
		}
	};

	if (rootStat.isFile()) {
		const relativePath = toPosix(path.relative(args.cwd, resolved));
		const content = await readFile(resolved, "utf8").catch(() => null);
		if (content === null) {
			return { output: "", resultCount: 0, degraded };
		}
		runOnLines(content.split(/\r?\n/u), relativePath);
	} else {
		await walkWorkspace(
			resolved,
			args.cwd,
			async (relativePath, absolutePath) => {
				if (acc.stopped) {
					return;
				}
				if (matcher && !matcher(relativePath)) {
					return;
				}

				const fileStat = await stat(absolutePath);
				if (fileStat.size > MAX_TEXT_FILE_BYTES) {
					return;
				}

				const content = await readFile(absolutePath, "utf8").catch(() => null);
				if (content === null) {
					return;
				}

				runOnLines(content.split(/\r?\n/u), relativePath);
			},
		);
	}

	if (args.output_mode === "files_with_matches") {
		return {
			output: [...acc.filesWithMatches].join("\n"),
			resultCount: acc.filesWithMatches.size,
			degraded,
		};
	}

	if (args.output_mode === "count") {
		const output = [...acc.countByFile.entries()]
			.map(([file, count]) => `${file}:${count}`)
			.join("\n");
		return { output, resultCount: acc.countByFile.size, degraded };
	}

	return {
		output: acc.contentLines.join("\n"),
		resultCount: acc.matchCount,
		degraded,
	};
}

async function walkWorkspace(
	absoluteRoot: string,
	cwd: string,
	onFile: (relativePath: string, absolutePath: string) => Promise<void>,
): Promise<void> {
	const entries = await readdir(absoluteRoot, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));

	for (const entry of entries) {
		if (IGNORED_NAMES.has(entry.name)) {
			continue;
		}

		const absolutePath = path.join(absoluteRoot, entry.name);
		const relativePath = toPosix(path.relative(cwd, absolutePath));

		if (entry.isDirectory()) {
			await walkWorkspace(absolutePath, cwd, onFile);
			continue;
		}

		if (entry.isFile() || entry.isSymbolicLink()) {
			await onFile(relativePath, absolutePath);
		}
	}
}

function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

function createGlobMatcher(glob: string): (value: string) => boolean {
	const normalized = toPosix(glob);
	let regexSource = "^";

	for (let i = 0; i < normalized.length; i += 1) {
		const char = normalized[i] ?? "";

		if (char === "*") {
			if (normalized[i + 1] === "*") {
				if (normalized[i + 2] === "/") {
					regexSource += "(?:.*/)?";
					i += 2;
				} else {
					regexSource += ".*";
					i += 1;
				}
			} else {
				regexSource += "[^/]*";
			}
			continue;
		}

		if (char === "?") {
			regexSource += "[^/]";
			continue;
		}

		if (/[-/\\^$+?.()|[\]{}]/u.test(char)) {
			regexSource += `\\${char}`;
			continue;
		}

		regexSource += char;
	}

	regexSource += "$";
	const regex = new RegExp(regexSource);
	return (value) => regex.test(toPosix(value));
}

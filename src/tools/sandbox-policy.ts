import path from "node:path";
import type { RunShellMode } from "../types.js";
import { resolveWorkspacePath } from "./path-utils.js";

export interface SandboxDenial {
	reason: string;
}

export type MutatingToolName = "write" | "edit";

const execSeparatorPattern = /^(?:&&|\|\||[;|])$/u;
const redirectionPattern = /(?:^|[^\d<])>>?\s*(["']?)([^"'\s]+)\1/gu;
const dangerousCommandPattern =
	/\b(?:git\s+reset\s+--hard|mkfs|shutdown|reboot|halt|poweroff|curl\s+[^|]+\|\s*(?:sh|bash|zsh)|wget\s+[^|]+\|\s*(?:sh|bash|zsh)|rm\s+-rf\s+\/)\b/iu;
const readOnlyWritePattern =
	/(?:^|[;&|]\s*)(?:touch|mkdir|rm|rmdir|mv|cp|install|tee|sed\s+-i|perl\s+-i|cat\s+>|echo\s+>|printf\s+>|python3?\s+-m\s+pip|npm\s+install|pnpm\s+install|git\s+apply|git\s+add|git\s+commit|export|unset|source|\.)\b|(?:^|[^\d<])>>?\s*/iu;
const writeCommandNames = new Set([
	"touch",
	"mkdir",
	"rm",
	"rmdir",
	"mv",
	"cp",
	"install",
	"tee",
]);

export function evaluateMutatingToolPolicy(
	toolName: MutatingToolName,
	mode: RunShellMode,
): SandboxDenial | null {
	if (mode === "read_only") {
		return {
			reason: `${toolName} is disabled by read_only tool safety mode`,
		};
	}
	return null;
}

export function resolveWritableWorkspacePath(
	cwd: string,
	relativePath: string,
	mode: RunShellMode,
	toolName: MutatingToolName,
): { resolved: string; relative: string } {
	const denial = evaluateMutatingToolPolicy(toolName, mode);
	if (denial) {
		throw new SandboxPolicyError(denial.reason);
	}
	return resolveWorkspacePath(cwd, relativePath);
}

export function evaluateCommandPolicy(
	command: string,
	cwd: string,
	mode: RunShellMode,
): SandboxDenial | null {
	if (mode === "full_access") {
		return null;
	}

	if (dangerousCommandPattern.test(command)) {
		return {
			reason: "blocked by high-risk command policy",
		};
	}

	if (mode === "read_only" && readOnlyWritePattern.test(command)) {
		return {
			reason: "read_only mode blocks write or environment-modifying commands",
		};
	}

	if (mode !== "workspace_write") {
		return null;
	}

	for (const target of collectWriteTargets(command)) {
		if (!isPathWithinWorkspace(target, cwd)) {
			return {
				reason: `workspace_write mode blocks writes outside the workspace: ${target}`,
			};
		}
	}

	return null;
}

export class SandboxPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxPolicyError";
	}
}

function collectWriteTargets(command: string): string[] {
	const targets = new Set<string>();

	for (const match of command.matchAll(redirectionPattern)) {
		const target = match[2];
		if (target) {
			targets.add(target);
		}
	}

	const tokens = tokenizeCommand(command);
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (
			!token ||
			execSeparatorPattern.test(token) ||
			!writeCommandNames.has(token)
		) {
			continue;
		}

		for (let inner = index + 1; inner < tokens.length; inner += 1) {
			const candidate = tokens[inner];
			if (!candidate || execSeparatorPattern.test(candidate)) {
				break;
			}
			if (candidate.startsWith("-")) {
				continue;
			}
			targets.add(candidate);
			if (token !== "mv" && token !== "cp" && token !== "install") {
				break;
			}
		}
	}

	return [...targets];
}

function tokenizeCommand(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;
	let escaped = false;

	for (const char of command) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		if (/\s/u.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		if ((char === ";" || char === "|") && current) {
			tokens.push(current);
			current = "";
		}

		if (char === ";" || char === "|") {
			tokens.push(char);
			continue;
		}

		if (char === "&") {
			if (current) {
				tokens.push(current);
				current = "";
			}
			tokens.push(char);
			continue;
		}

		current += char;
	}

	if (current) {
		tokens.push(current);
	}

	return normalizeSeparatorTokens(tokens);
}

function normalizeSeparatorTokens(tokens: string[]): string[] {
	const normalized: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		const next = tokens[index + 1];
		if ((token === "&" || token === "|") && next === token) {
			normalized.push(`${token}${token}`);
			index += 1;
			continue;
		}
		normalized.push(token ?? "");
	}
	return normalized;
}

function isPathWithinWorkspace(target: string, cwd: string): boolean {
	if (!target || target === "/dev/null") {
		return true;
	}

	const resolved = path.resolve(cwd, target);
	const relative = path.relative(cwd, resolved);

	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

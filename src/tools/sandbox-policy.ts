import path from "node:path";
import type { RunShellMode } from "../types.js";

export class SandboxPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxPolicyError";
	}
}

/**
 * Returns true when `target` resolves to a location inside any of `roots`.
 *
 * Both arguments are resolved to absolute form so that relative paths, `.`/`..`
 * segments, and trailing separators cannot slip past a root boundary. A path
 * that equals a root (the root directory itself) or lives beneath it counts as
 * "within". This is the single containment check reused by every entry point
 * that must keep skill discovery roots read-only.
 */
export function isWithinAnyRoot(target: string, roots: string[]): boolean {
	if (roots.length === 0) {
		return false;
	}
	const resolvedTarget = path.resolve(target);
	const resolvedRoots = roots.map((root) => path.resolve(root));
	return resolvedRoots.some((root) => {
		if (resolvedTarget === root) {
			return true;
		}
		// Ensure `root` is a genuine prefix directory, not an accidental
		// substring match (e.g. "/foo/skills" vs "/foo/skills-extra").
		const relative = path.relative(root, resolvedTarget);
		return (
			relative !== "" &&
			!relative.startsWith("..") &&
			!path.isAbsolute(relative)
		);
	});
}

/**
 * Reject writes that target a skill discovery root.
 *
 * Skill roots (`.sigpi/skills` / `.agents/skills`, project and global) must
 * stay read-only in every mode — including `full_access` — so that an agent
 * cannot persist a new auto-discovered-and-auto-loaded skill and escalate its
 * privileges (see ADR 0017). This guard runs before any mode-specific logic,
 * including the `full_access` early-return, so it cannot be bypassed.
 */
function assertNotSkillRoot(
	target: string,
	skillRoots: string[],
	toolName: string,
): void {
	if (isWithinAnyRoot(target, skillRoots)) {
		throw new SandboxPolicyError(
			`${toolName} blocked: path is inside a skill discovery root and must stay read-only.`,
		);
	}
}

/**
 * Evaluate whether a mutating tool (write/edit) may proceed for the given mode.
 *
 * The skill-root guard is mode-independent: it rejects any target inside a
 * skill discovery root regardless of `mode`, including `full_access`.
 */
export function evaluateMutatingToolPolicy(
	target: string,
	mode: RunShellMode,
	toolName: string,
	skillRoots: string[] = [],
): void {
	assertNotSkillRoot(target, skillRoots, toolName);

	if (mode === "read_only") {
		throw new SandboxPolicyError(
			`${toolName} is not permitted in read_only mode. Use the read tool instead.`,
		);
	}
}

/**
 * Resolve a workspace path for a mutating tool, enforcing the read-only mode
 * and skill-root invariants.
 *
 * The skill-root guard is mode-independent: it rejects any target inside a
 * skill discovery root regardless of `mode`, including `full_access`.
 */
export function resolveWritableWorkspacePath(
	cwd: string,
	relativePath: string,
	mode: RunShellMode,
	toolName: string,
	allowedRoots: string[] = [],
	skillRoots: string[] = [],
): { resolved: string; relative: string } {
	assertNotSkillRoot(relativePath, skillRoots, toolName);

	if (mode === "read_only") {
		throw new SandboxPolicyError(
			`${toolName} is not permitted in read_only mode. Use the read tool instead.`,
		);
	}

	const resolved = path.resolve(cwd, relativePath);
	const relative = path.relative(cwd, resolved);
	const withinCwd = isWithinRoot(resolved, cwd);
	const withinAllowed = allowedRoots.some((root) =>
		isWithinRoot(resolved, root),
	);

	if (!withinCwd && !withinAllowed) {
		throw new SandboxPolicyError(
			"Path must stay within the working directory.",
		);
	}

	return { resolved, relative };
}

function isWithinRoot(target: string, root: string): boolean {
	const resolvedRoot = path.resolve(root);
	if (target === resolvedRoot) {
		return true;
	}
	const relative = path.relative(resolvedRoot, target);
	return (
		relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
	);
}

const execSeparatorPattern = /^(?:&&|\|\||[;|])$/u;
const redirectionPattern = /(?:^|[^\d<])>>?\s*(["']?)([^"'\s]+)\1/gu;
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

/**
 * Collect every file path a command may write to: redirect targets
 * (`> file`, `>> file`) plus the destination args of known write commands
 * (`cp`/`mv`/`install` take all following non-flag args; `touch`/`mkdir`/
 * `rm`/`rmdir`/`tee` take the first following non-flag arg). Reused by both
 * the skill-root guard and the workspace containment check so neither can be
 * bypassed by switching write syntax.
 */
function extractWriteTargets(command: string): string[] {
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

		if (char === ";" || char === "|" || char === "&") {
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

/**
 * Evaluate whether a bash command may run for the given mode.
 *
 * The skill-root guard is mode-independent: it rejects any write/redirect
 * target inside a skill discovery root regardless of `mode`, including
 * `full_access`. It runs before the `full_access` early-return so the
 * `full_access` escape hatch cannot bypass it.
 */
export function evaluateCommandPolicy(
	command: string,
	cwd: string,
	mode: RunShellMode,
	allowedRoots: string[] = [],
	skillRoots: string[] = [],
): void {
	// Mode-independent skill-root guard: must precede the full_access
	// early-return below so the escape hatch cannot defeat it.
	for (const target of extractWriteTargets(command)) {
		const resolved = path.resolve(cwd, target);
		if (isWithinAnyRoot(resolved, skillRoots)) {
			throw new SandboxPolicyError(
				`bash blocked: write target "${target}" is inside a skill discovery root and must stay read-only.`,
			);
		}
	}

	if (mode === "full_access") {
		return;
	}

	if (mode === "read_only") {
		throw new SandboxPolicyError(
			"bash is not permitted in read_only mode. Use the read tool instead.",
		);
	}

	// workspace_write: deny any write target that escapes the workspace
	// (cwd + allowed roots).
	for (const target of extractWriteTargets(command)) {
		const resolved = path.resolve(cwd, target);
		const withinCwd = isWithinRoot(resolved, cwd);
		const withinAllowed = allowedRoots.some((root) =>
			isWithinRoot(resolved, root),
		);
		if (!withinCwd && !withinAllowed) {
			throw new SandboxPolicyError(
				`bash write target "${target}" must stay within the working directory.`,
			);
		}
	}
}

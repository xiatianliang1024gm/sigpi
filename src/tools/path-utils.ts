import { realpath } from "node:fs/promises";
import path from "node:path";

export function resolveWorkspacePath(
	cwd: string,
	relativePath: string,
	allowedRoots: string[] = [],
): {
	resolved: string;
	relative: string;
} {
	const resolved = path.resolve(cwd, relativePath);
	const relative = path.relative(cwd, resolved);

	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		// Allow paths under explicitly trusted roots (e.g. the session's bash
		// output / background-log directories) so the model can read overflow
		// and background output that lives outside the workspace.
		if (allowedRoots.some((root) => isWithin(resolved, root))) {
			return { resolved, relative: relativePath };
		}
		throw new Error("Path must stay within the working directory.");
	}

	return { resolved, relative };
}

function isWithin(target: string, root: string): boolean {
	const resolvedTarget = path.resolve(target);
	const resolvedRoot = path.resolve(root);
	return (
		resolvedTarget === resolvedRoot ||
		resolvedTarget.startsWith(resolvedRoot + path.sep)
	);
}

/**
 * Build the set of trusted read roots from a list of raw roots.
 *
 * Each root is registered in both its raw (lexical) and canonical (realpath)
 * forms. `resolveWorkspacePath` performs a *lexical* containment check, so a
 * root reached through a symlink (e.g. a dotfiles repo symlinked into
 * `~/.agents`, or a symlinked home) resolves on disk to a different path than
 * the one the caller specified. Registering both forms lets reads via either
 * the symlinked or the real path succeed. Roots that cannot be realpathed
 * (e.g. already removed) fall back to the raw path.
 */
export async function buildTrustedReadRoots(
	roots: string[],
): Promise<string[]> {
	const seen = new Set<string>();
	const result: string[] = [];

	const add = (root: string) => {
		const normalized = path.resolve(root);
		if (!seen.has(normalized)) {
			seen.add(normalized);
			result.push(normalized);
		}
	};

	for (const root of roots) {
		add(root);
		try {
			add(await realpath(root));
		} catch {
			// Root missing or unreadable; raw path already registered above.
		}
	}

	return result;
}

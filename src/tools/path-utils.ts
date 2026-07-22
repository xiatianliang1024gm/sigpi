import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Resolve a target path against `cwd` for any tool (`read`, `grep`, `glob`,
 * `write`, `edit`).
 *
 * SigPi runs with the account's permissions and treats the local environment
 * as a single trust boundary — the OS / container is the real isolation. It
 * imposes no in-process workspace containment check on reads or writes (see
 * ADR 0022): the path is resolved to its absolute form and returned with its
 * lexically-computed relative form. Whether the resolved path is actually
 * reachable is governed by the filesystem, not by SigPi.
 */
export function resolveWorkspacePath(
	cwd: string,
	relativePath: string,
): { resolved: string; relative: string } {
	let resolved = path.resolve(cwd, relativePath);
	const relative = path.relative(cwd, resolved);
	try {
		resolved = realpathSync(resolved);
	} catch {
		// Path doesn't exist yet (e.g., write tool creating a new file).
		// Keep the lexically-resolved path.
	}
	return { resolved, relative };
}

import { stat } from "node:fs/promises";
import { resolveWorkspacePath } from "./path-utils.js";

interface ReadFingerprint {
	mtimeMs: number;
	size: number;
}

/**
 * Tracks which files the model has read in the current conversation, used to
 * enforce Claude Code's read-before-edit rule. State is scoped to one
 * conversation/runtime (a single instance is created in
 * `createDefaultToolRegistry` and shared by the `read`, `edit`, `write`, and
 * `bash` tools).
 *
 * Per-file fingerprint is `{ mtimeMs, size }` captured from `stat` at record
 * time. A successful `edit`/`write` refreshes the fingerprint so back-to-back
 * edits in one turn do not trip the "changed on disk since read" guard.
 */
export class ReadTracker {
	private readonly fingerprints = new Map<string, ReadFingerprint>();

	/**
	 * Record that `rawPath` (relative to `cwd`) has been read. Best-effort:
	 * failures are swallowed so a read/command that already succeeded is never
	 * blocked by bookkeeping.
	 */
	async recordRead(cwd: string, rawPath: string): Promise<void> {
		try {
			const { resolved } = resolveWorkspacePath(cwd, rawPath);
			await this.recordResolved(resolved);
		} catch {
			// ignore — the underlying read/command already happened
		}
	}

	/** Record a resolved absolute path directly (used by `edit`/`write`). */
	async recordResolved(resolved: string): Promise<void> {
		try {
			const stats = await stat(resolved);
			this.fingerprints.set(resolved, {
				mtimeMs: stats.mtimeMs,
				size: stats.size,
			});
		} catch {
			// file may have been deleted; drop any stale entry
			this.fingerprints.delete(resolved);
		}
	}

	/** Whether the resolved path has been recorded as read this conversation. */
	hasRead(resolved: string): boolean {
		return this.fingerprints.has(resolved);
	}

	/**
	 * Whether the file on disk differs from the recorded fingerprint. Returns
	 * `true` when the path was never read or no longer exists.
	 */
	async hasChangedSinceRead(resolved: string): Promise<boolean> {
		const previous = this.fingerprints.get(resolved);
		if (!previous) {
			return true;
		}

		let current: { mtimeMs: number; size: number };
		try {
			const stats = await stat(resolved);
			current = { mtimeMs: stats.mtimeMs, size: stats.size };
		} catch {
			return true;
		}

		return (
			current.mtimeMs !== previous.mtimeMs || current.size !== previous.size
		);
	}

	/** Test/reset helper. */
	clear(): void {
		this.fingerprints.clear();
	}
}

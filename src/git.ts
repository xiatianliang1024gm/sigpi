import { spawn } from "node:child_process";

const GIT_TIMEOUT_MS = 50;
const branchCache = new Map<string, string | null>();

interface GitResult {
	ok: boolean;
	value: string | null;
}

/**
 * Run `git <args>` in `cwd` with a short timeout. Returns `{ ok, value }`
 * where `value` is the trimmed stdout on success and `null` on any failure
 * (non-zero exit, spawn error, timeout, empty output). Never throws.
 */
function runGit(cwd: string, args: string[]): Promise<GitResult> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: GitResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("git", args, {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				// Never inherit a `GIT_DIR` / `GIT_WORK_TREE` from the caller's
				// environment. When one is exported (e.g. by a git hook, or by a
				// user's shell), git would resolve the repo from that path instead
				// of `cwd`, making the branch lookup report the wrong repository.
				env: cleanGitEnv(),
			});
		} catch {
			finish({ ok: false, value: null });
			return;
		}

		let stdout = "";
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString("utf8");
		});

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ ok: false, value: null });
		}, GIT_TIMEOUT_MS);

		child.on("error", () => {
			clearTimeout(timer);
			finish({ ok: false, value: null });
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				finish({ ok: false, value: null });
				return;
			}
			const trimmed = stdout.trim();
			finish({
				ok: trimmed.length > 0,
				value: trimmed.length > 0 ? trimmed : null,
			});
		});
	});
}

/**
 * Return the current git branch for `cwd`, or `null` when not in a repo,
 * when git is unavailable, or when the lookup times out.
 *
 * - Normal branch: returns the branch name (e.g. `"main"`).
 * - Detached HEAD: returns `"@{shortSha}"` (e.g. `"@a1b2c3d"`).
 * - Not a repo / timeout / error: returns `null`.
 *
 * Results are cached per `cwd` (no TTL) so repeated status-bar redraws do
 * not spawn a subprocess storm.
 */
export async function getGitBranch(cwd: string): Promise<string | null> {
	const cached = branchCache.get(cwd);
	if (cached !== undefined) {
		return cached;
	}

	const result = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!result.ok || !result.value) {
		branchCache.set(cwd, null);
		return null;
	}

	let branch: string | null = result.value;
	if (branch === "HEAD") {
		// Detached HEAD — fall back to the short SHA, prefixed with `@`.
		const sha = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
		branch = sha.ok && sha.value ? `@${sha.value}` : null;
	}

	branchCache.set(cwd, branch);
	return branch;
}

/**
 * Return a copy of the process environment with repo-location overrides
 * stripped, so a spawned `git` discovers the repository from `cwd` rather
 * than an inherited `GIT_DIR` / `GIT_WORK_TREE`.
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	return env;
}

/**
 * Test-only: clear the in-process branch cache. Production code never needs
 * this — the cache is intentionally unbounded.
 */
export function _resetGitBranchCacheForTests(): void {
	branchCache.clear();
}

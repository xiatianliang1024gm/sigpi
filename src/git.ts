import { spawn } from "node:child_process";

/**
 * Git command budget. A POSIX `git rev-parse` takes a few ms, but Windows
 * process creation is far slower (CreateProcess plus antivirus scans and DLL
 * loads can take hundreds of ms), so win32 gets a much larger budget than
 * POSIX. The branch watcher re-samples on its own cadence, so a slow lookup
 * never blocks a status-bar redraw.
 */
const GIT_TIMEOUT_MS = process.platform === "win32" ? 1000 : 150;
/**
 * Extra budget for process *creation* on top of {@link GIT_TIMEOUT_MS}. The
 * kill timer is armed on the `spawn` event so creation latency does not count
 * against the git command's own execution budget, but creation itself must
 * still be bounded: on Windows a CreateProcess stalled in an antivirus / EDR
 * hook can delay the `spawn` event for minutes, and without an absolute
 * deadline `runGit` never settles (leaking a process on every watcher tick).
 */
const GIT_SPAWN_GRACE_MS = process.platform === "win32" ? 2000 : 250;
/** How often the background branch watcher re-queries git. */
const BRANCH_WATCH_INTERVAL_MS = 2000;

/** Last successfully sampled branch, read synchronously by the status bar. */
let currentBranch: string | null = null;
/** `cwd` the current watcher samples; `null` while stopped. */
let branchWatcherCwd: string | null = null;
let branchWatcherTimer: NodeJS.Timeout | null = null;
/** One in-flight sample at a time, so a stalled git cannot pile up processes. */
let branchSampleInFlight = false;

interface GitResult {
	ok: boolean;
	value: string | null;
}

/**
 * Run `git <args>` in `cwd` with a short timeout. Returns `{ ok, value }`
 * where `value` is the trimmed stdout on success and `null` on any failure
 * (non-zero exit, spawn error, timeout, empty output). Never throws and never
 * settles early while a process creation is still pending: if the OS spawn is
 * stalled (e.g. an antivirus / EDR hook on Windows), the promise stays
 * pending until the child reaches `spawn`/`error`/`close`, so the watcher's
 * in-flight slot is not released and no replacement git is spawned on top of
 * the stalled one.
 */
export function runGit(cwd: string, args: string[]): Promise<GitResult> {
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

		// Absolute deadline: bounds the whole lookup from promise start,
		// including process creation. A child that spawned gets killed here;
		// one that has not spawned yet (stalled CreateProcess) is left alone
		// and settles via the `spawn`/`error`/`close` handlers below — killing
		// it is a no-op, and settling now would release the watcher's
		// in-flight slot and let the next tick pile up another git spawn.
		let spawned = false;
		const hardTimer = setTimeout(() => {
			if (spawned) {
				clearTimeout(timer);
				try {
					child.kill("SIGKILL");
				} catch {
					// `close`/`error` still settle.
				}
				finish({ ok: false, value: null });
			}
		}, GIT_TIMEOUT_MS + GIT_SPAWN_GRACE_MS);

		// Arm the kill timer only once the process has actually spawned, so
		// process-creation latency (the dominant cost on Windows) does not count
		// against the git command's own execution budget.
		let timer: NodeJS.Timeout | undefined;
		child.on("spawn", () => {
			if (settled) return;
			spawned = true;
			timer = setTimeout(() => {
				clearTimeout(hardTimer);
				child.kill("SIGKILL");
				finish({ ok: false, value: null });
			}, GIT_TIMEOUT_MS);
		});

		child.on("error", () => {
			clearTimeout(hardTimer);
			clearTimeout(timer);
			finish({ ok: false, value: null });
		});

		child.on("close", (code) => {
			clearTimeout(hardTimer);
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
 * Start the background branch watcher for `cwd`. It samples git on
 * `intervalMs` and stores the result in a module-level variable that
 * {@link getCachedBranch} reads synchronously, so status-bar redraws never
 * spawn (or await) a git process. Restarting re-targets the singleton
 * without leaking the previous interval.
 */
export function startBranchWatcher(
	cwd: string,
	intervalMs: number = BRANCH_WATCH_INTERVAL_MS,
): void {
	stopBranchWatcher();
	branchWatcherCwd = cwd;
	void sampleBranch(cwd);
	branchWatcherTimer = setInterval(() => {
		void sampleBranch(cwd);
	}, intervalMs);
}

/** Stop the background branch watcher (no-op when it is not running). */
export function stopBranchWatcher(): void {
	if (branchWatcherTimer !== null) {
		clearInterval(branchWatcherTimer);
		branchWatcherTimer = null;
	}
	// Drop the target so an in-flight sample from the stopped watcher cannot
	// write its (stale) result into the module variable.
	branchWatcherCwd = null;
}

/**
 * Synchronously return the last sampled git branch for the status bar, or
 * `null` when nothing has been sampled yet, when not in a repo, when git is
 * unavailable, or when the lookup timed out. Never runs git.
 */
export function getCachedBranch(): string | null {
	return currentBranch;
}

/**
 * Sample the git branch for `cwd` and store it in {@link currentBranch}.
 * Skips when a previous sample is still in flight so a slow or stalled git
 * spawn can never accumulate processes, and keeps the last known branch on
 * failure so a transient git hiccup does not flicker the bar to no branch.
 */
async function sampleBranch(cwd: string): Promise<void> {
	if (branchSampleInFlight) {
		return;
	}
	branchSampleInFlight = true;
	try {
		const result = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
		let branch: string | null = result.value;
		if (result.ok && branch !== null) {
			if (branch === "HEAD") {
				// Detached HEAD — fall back to the short SHA, prefixed with `@`.
				const sha = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
				branch = sha.ok && sha.value ? `@${sha.value}` : null;
			}
			if (branch !== null) {
				// Only publish while this watcher is still the active one: an
				// in-flight sample from a stopped/restarted watcher must not
				// overwrite the new watcher's value (or leak into a later
				// test's assertions).
				if (cwd === branchWatcherCwd) {
					currentBranch = branch;
				}
			}
		}
	} finally {
		branchSampleInFlight = false;
	}
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
 * Test-only: stop the watcher and clear the sampled branch and in-flight
 * flag so tests start from a clean slate.
 */
export function _resetGitBranchStateForTests(): void {
	stopBranchWatcher();
	currentBranch = null;
	branchSampleInFlight = false;
}

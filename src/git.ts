import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { FSWatcher } from "chokidar";
import { watch } from "chokidar";

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
/**
 * How often the background branch watcher re-queries git as a fallback. The
 * real-time path is a chokidar watcher on the repo's `HEAD` file; this
 * interval only catches what the watch misses (unwatchable mounts, a dead
 * watch, a repo created after start), so 10s is plenty.
 */
const BRANCH_WATCH_INTERVAL_MS = 10_000;

/** Last successfully sampled branch, read synchronously by the status bar. */
let currentBranch: string | null = null;
/**
 * `cwd` the active watcher samples; `null` while stopped. Doubles as the
 * ownership check for async work: an in-flight sample or git-dir resolution
 * left behind by a stopped/restarted watcher compares its `cwd` here and
 * bails instead of publishing. Branch switching is rare and the value is
 * display-only, so a stale result slipping through on a same-directory
 * restart is acceptable — the next sample corrects it.
 */
let branchWatcherCwd: string | null = null;
let branchWatcherTimer: NodeJS.Timeout | null = null;
/** One in-flight sample at a time, so a stalled git cannot pile up processes. */
let branchSampleInFlight = false;
/** chokidar watcher on the repo's git dir, armed once the repo is known. */
let headWatcher: FSWatcher | null = null;
/** One git-dir resolution in flight at a time, mirroring the sample guard. */
let headWatchResolveInFlight = false;

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
 * Start the background branch watcher for `cwd`. Branch switches are picked
 * up almost immediately via a chokidar watcher on the repo's `HEAD` file,
 * with an `intervalMs` poll as fallback. The result is stored in a
 * module-level variable that {@link getCachedBranch} reads synchronously, so
 * status-bar redraws never spawn (or await) a git process. Restarting
 * re-targets the singleton without leaking the previous interval or watch.
 */
export function startBranchWatcher(
	cwd: string,
	intervalMs: number = BRANCH_WATCH_INTERVAL_MS,
): void {
	stopBranchWatcher();
	branchWatcherCwd = cwd;
	void tick(cwd);
	branchWatcherTimer = setInterval(() => {
		void tick(cwd);
	}, intervalMs);
}

/** Stop the background branch watcher (no-op when it is not running). */
export function stopBranchWatcher(): void {
	if (branchWatcherTimer !== null) {
		clearInterval(branchWatcherTimer);
		branchWatcherTimer = null;
	}
	closeHeadWatcher();
	// Clear ownership so in-flight work from this watcher (a sample, a
	// git-dir resolution) fails the ownership check and cannot publish.
	branchWatcherCwd = null;
}

/**
 * One watcher tick: take a fallback sample, then (re)arm the `HEAD` file
 * watch when it is not running — the repo may have appeared after start, or
 * a previous watch may have died. The sample comes first so the git-dir
 * lookup below never steals the sample's git spawn: tests use a stateful
 * fake `git`, and a successful sample is what proves we are in a repo.
 */
async function tick(cwd: string): Promise<void> {
	if (cwd !== branchWatcherCwd) return;
	await sampleBranch(cwd);
	void ensureHeadWatcher(cwd);
}

/**
 * Arm a chokidar watcher on the repository's git dir so a branch switch is
 * picked up as it happens instead of on the next poll tick. Git implements a
 * switch by rewriting the git dir's `HEAD` file (as `HEAD.lock` plus a
 * rename), so watching for it turns a checkout into a near-immediate
 * status-bar update. chokidar is used instead of `fs.watch` because it
 * normalizes the rename/replace race and filename reporting across
 * platforms (Linux inotify, macOS FSEvents, Windows ReadDirectoryChangesW).
 *
 * The git dir is resolved through git rather than assumed to be
 * `<cwd>/.git`: worktrees and submodules point at it via a `.git` gitfile.
 * Resolution failures (not a repo) and watch errors fall back to poll-only.
 */
async function ensureHeadWatcher(cwd: string): Promise<void> {
	if (headWatcher !== null || headWatchResolveInFlight) return;
	headWatchResolveInFlight = true;
	try {
		const gitDirResult = await runGit(cwd, ["rev-parse", "--absolute-git-dir"]);
		// A stop/restart while resolving: this git dir belongs to a watcher
		// that is no longer active, so do not arm it (it would leak a watch
		// and sample the wrong repo).
		if (cwd !== branchWatcherCwd) return;
		if (!gitDirResult.ok || gitDirResult.value === null) return;

		// `awaitWriteFinish` coalesces a single `git switch` — which writes
		// `HEAD.lock`, renames it over `HEAD`, and touches `index`/`logs/HEAD`
		// — into one `change HEAD` event after the writes settle, so no
		// hand-rolled debounce is needed here (the transient `HEAD.lock` never
		// stabilizes and is dropped). `persistent` stays at its chokidar
		// default (true): the watcher keeps the process alive, and
		// `stopBranchWatcher` closes it on exit.
		const watcher = watch(gitDirResult.value, {
			ignoreInitial: true,
			awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
		});
		watcher.on("all", (_event, path) => {
			if (cwd !== branchWatcherCwd) return;
			// Only HEAD matters; other git-dir churn (refs, objects, index)
			// must not trigger a sample.
			if (basename(path) === "HEAD") {
				void sampleBranch(cwd);
			}
		});
		watcher.on("error", () => {
			// A dead watch must not block re-arming on a later tick, and
			// chokidar's error event must be handled or it throws. The
			// identity check keeps a stale watcher's error from clearing a
			// newer one installed by a restart.
			void watcher.close();
			if (headWatcher === watcher) {
				headWatcher = null;
			}
		});
		headWatcher = watcher;
	} finally {
		headWatchResolveInFlight = false;
	}
}

/** Close the HEAD watch (no-op when not running). */
function closeHeadWatcher(): void {
	const watcher = headWatcher;
	headWatcher = null;
	if (watcher !== null) {
		void watcher.close();
	}
}

/** Callback fired when the cached branch changes, including the first sample. */
type BranchChangeListener = (branch: string) => void;

/** Current subscriber; a single consumer (the CLI) keeps this a singleton. */
let branchChangeListener: BranchChangeListener | null = null;

/**
 * Subscribe to branch changes. The listener fires with each new branch value,
 * including the first sample after {@link startBranchWatcher}, and never for
 * unchanged re-samples. Returns an unsubscribe function.
 */
export function onBranchChange(listener: BranchChangeListener): () => void {
	branchChangeListener = listener;
	return () => {
		if (branchChangeListener === listener) {
			branchChangeListener = null;
		}
	};
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
			// Publish only while this watcher is still the active one: an
			// in-flight sample from a stopped/restarted watcher must not
			// overwrite the new watcher's value. On a same-directory restart
			// a stale sample can slip through, but the next sample corrects
			// it and the value is display-only, so that is acceptable.
			if (branch !== null && cwd === branchWatcherCwd) {
				const previous = currentBranch;
				currentBranch = branch;
				// Notify on change (including the first sample) so the
				// status bar can repaint immediately instead of waiting
				// for its own refresh timer.
				if (previous !== currentBranch) {
					branchChangeListener?.(currentBranch);
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
	branchChangeListener = null;
}

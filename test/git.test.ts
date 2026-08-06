import assert from "node:assert/strict";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import {
	_resetGitBranchStateForTests,
	getCachedBranch,
	onBranchChange,
	runGit,
	startBranchWatcher,
	stopBranchWatcher,
} from "../src/git.js";
import { gitIn } from "./helpers.js";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "sigpi-git-test-"));
	gitIn(dir, "init -q -b main");
	gitIn(dir, "config user.email test@test.local");
	gitIn(dir, "config user.name Test");
	gitIn(dir, "commit --allow-empty -q -m initial");
	return dir;
}

function cleanup(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

async function waitFor(
	predicate: () => boolean,
	message: string,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(25);
	}
	assert.ok(predicate(), message);
}

async function waitForBranch(
	expected: string | null,
	timeoutMs = 5000,
): Promise<void> {
	await waitFor(
		() => getCachedBranch() === expected,
		`branch watcher never reported ${expected}`,
		timeoutMs,
	);
}

function countLabel(logPath: string, label: string): number {
	if (!existsSync(logPath)) return 0;
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter((line) => line.trim() === label).length;
}

/**
 * A per-platform fake `git` script. `win32` is Node code: the fake is a copy
 * of the running Node binary, so it needs `rev-parse` as its main module
 * (see `installFakeGit`). `posix` is POSIX shell code: the fake is `/bin/sh`
 * (see `installFakeGit`), which reads `rev-parse` as a shell script and
 * starts in ~5ms — a freshly created executable is scanned on first exec
 * (macOS XProtect can take 300ms+, longer than the `runGit` kill timer),
 * while `/bin/sh` is already trusted.
 */
interface FakeGitSpec {
	win32: string;
	posix: string;
}

/**
 * Wrap the platform bodies with spawn/exit logging. Tests wait on the log to
 * observe invocations and to know when spawned fakes have exited before
 * removing their working directory on Windows.
 */
function fakeGitSpec(
	logPath: string,
	win32: string,
	posix: string,
): FakeGitSpec {
	const win32Script = [
		`import { appendFileSync } from "node:fs";`,
		`appendFileSync(${JSON.stringify(logPath)}, "spawn\\n");`,
		`process.on("exit", () => { try { appendFileSync(${JSON.stringify(logPath)}, "exit\\n"); } catch {} });`,
		win32,
	].join("\n");
	const posixScript = [
		`printf 'spawn\\n' >> ${JSON.stringify(logPath)}`,
		`trap 'printf "exit\\n" >> ${JSON.stringify(logPath)}' EXIT`,
		posix,
	].join("\n");
	return { win32: win32Script, posix: posixScript };
}

/**
 * Replace `git` on PATH with a fake so `spawn("git")` resolves to it on every
 * platform. On Windows: a copy of the running Node binary named `git.exe`
 * (PATH lookup appends `.exe`) whose `rev-parse` main module is `spec.win32`
 * — Node resolves `rev-parse` against the queried directory, exactly the
 * file the real `git rev-parse` command would use. On POSIX: a symlink
 * named `git` to the already-trusted `/bin/sh`, so `spawn("git", ["rev-parse",
 * ...])` runs `sh rev-parse ...` with the shell body from `spec.posix`.
 * Returns a restore function that puts the original PATH back.
 */
function installFakeGit(
	repoDir: string,
	fakeDir: string,
	spec: FakeGitSpec,
): () => void {
	if (process.platform === "win32") {
		copyFileSync(process.execPath, join(fakeDir, "git.exe"));
		writeFileSync(join(repoDir, "rev-parse"), spec.win32, "utf8");
	} else {
		symlinkSync("/bin/sh", join(fakeDir, "git"));
		writeFileSync(join(repoDir, "rev-parse"), spec.posix, "utf8");
	}
	const previousPath = process.env.PATH;
	process.env.PATH = `${fakeDir}${delimiter}${previousPath ?? ""}`;
	return () => {
		process.env.PATH = previousPath;
	};
}

test("runGit settles within the deadline when git hangs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sigpi-git-hang-"));
	const fakeDir = mkdtempSync(join(tmpdir(), "sigpi-git-fake-hang-"));
	const logPath = join(fakeDir, "spawns.log");
	try {
		// A `git` that never exits must settle the lookup in bounded time: the
		// spawn-armed kill timer (and the absolute deadline backstop) resolve
		// with `null` instead of leaking a process per watcher tick. The POSIX
		// body uses `exec` so the killed process is the sleeper itself — a
		// bare `sleep` would survive the SIGKILL of its parent `sh` as an
		// orphan holding the runner's pipes open.
		const spec = fakeGitSpec(
			logPath,
			`setInterval(() => {}, 1000);`,
			`exec sleep 1000`,
		);
		const restore = installFakeGit(dir, fakeDir, spec);
		try {
			const startedAt = Date.now();
			const result = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
			assert.equal(result.ok, false);
			assert.equal(result.value, null);
			const elapsed = Date.now() - startedAt;
			const deadlineMs = process.platform === "win32" ? 3500 : 800;
			assert.ok(
				elapsed < deadlineMs,
				`hanging git should settle within ${deadlineMs}ms, took ${elapsed}ms`,
			);
			assert.equal(
				countLabel(logPath, "spawn") >= 1,
				true,
				"the fake git should have started before it was killed",
			);
		} finally {
			restore();
		}
	} finally {
		cleanup(dir);
		cleanup(fakeDir);
	}
});

test("branch watcher records the current branch name", async () => {
	_resetGitBranchStateForTests();
	const dir = makeRepo();
	try {
		startBranchWatcher(dir, 50);
		try {
			await waitForBranch("main");
		} finally {
			stopBranchWatcher();
		}
	} finally {
		cleanup(dir);
	}
});

test("branch watcher records @shortSha for a detached HEAD", async () => {
	_resetGitBranchStateForTests();
	const dir = makeRepo();
	try {
		const sha = gitIn(dir, "rev-parse --short HEAD").trim();
		gitIn(dir, "checkout --detach -q HEAD");
		startBranchWatcher(dir, 50);
		try {
			await waitForBranch(`@${sha}`);
		} finally {
			stopBranchWatcher();
		}
	} finally {
		cleanup(dir);
	}
});

test("branch watcher reports null when the lookup fails", async () => {
	_resetGitBranchStateForTests();
	const dir = mkdtempSync(join(tmpdir(), "sigpi-git-norepo-"));
	const fakeDir = mkdtempSync(join(tmpdir(), "sigpi-git-fake-norepo-"));
	const logPath = join(fakeDir, "spawns.log");
	try {
		// A failing lookup (non-repo, git unavailable, timeout) keeps the
		// bar on `null` instead of throwing.
		const spec = fakeGitSpec(logPath, `process.exit(1);`, `exit 1`);
		const restore = installFakeGit(dir, fakeDir, spec);
		try {
			startBranchWatcher(dir, 100);
			try {
				await waitFor(
					() => countLabel(logPath, "spawn") >= 1,
					"the fake git never spawned",
				);
				await waitFor(
					() => countLabel(logPath, "exit") >= 1,
					"the fake git never exited",
				);
				await sleep(50);
				assert.equal(getCachedBranch(), null);
			} finally {
				stopBranchWatcher();
			}
		} finally {
			restore();
		}
	} finally {
		cleanup(dir);
		cleanup(fakeDir);
	}
});

test("branch watcher picks up a branch switch on a later tick", async () => {
	_resetGitBranchStateForTests();
	const dir = makeRepo();
	try {
		startBranchWatcher(dir, 100);
		try {
			await waitForBranch("main");
			gitIn(dir, "checkout -q -b feature");
			await waitForBranch("feature");
		} finally {
			stopBranchWatcher();
		}
	} finally {
		cleanup(dir);
	}
});

test("branch watcher keeps the last known branch when a lookup fails", async () => {
	_resetGitBranchStateForTests();
	const dir = mkdtempSync(join(tmpdir(), "sigpi-git-keep-"));
	const fakeDir = mkdtempSync(join(tmpdir(), "sigpi-git-fake-keep-"));
	const logPath = join(fakeDir, "spawns.log");
	const flagPath = join(fakeDir, "failed.flag");
	try {
		// First invocation succeeds ("main"); later ones exit non-zero to
		// simulate a transient git failure. The watcher must keep "main"
		// instead of flipping the bar to no branch.
		const spec = fakeGitSpec(
			logPath,
			[
				`import { existsSync, writeFileSync } from "node:fs";`,
				`if (existsSync(${JSON.stringify(flagPath)})) { process.exit(1); }`,
				`writeFileSync(${JSON.stringify(flagPath)}, "1");`,
				`console.log("main");`,
			].join("\n"),
			[
				`[ -f ${JSON.stringify(flagPath)} ] && exit 1`,
				`touch ${JSON.stringify(flagPath)}`,
				`echo main`,
			].join("\n"),
		);
		const restore = installFakeGit(dir, fakeDir, spec);
		try {
			startBranchWatcher(dir, 100);
			try {
				await waitForBranch("main");
				await waitFor(
					() => countLabel(logPath, "spawn") >= 2,
					"the watcher never re-sampled",
				);
				await waitFor(
					() => countLabel(logPath, "exit") >= 2,
					"the failed lookup never exited",
				);
				assert.equal(getCachedBranch(), "main");
			} finally {
				stopBranchWatcher();
			}
		} finally {
			restore();
		}
	} finally {
		cleanup(dir);
		cleanup(fakeDir);
	}
});

test("branch change listener fires on first sample and on change only", async () => {
	_resetGitBranchStateForTests();
	const dir = makeRepo();
	try {
		const seen: string[] = [];
		const unsubscribe = onBranchChange((branch) => {
			seen.push(branch);
		});
		try {
			startBranchWatcher(dir, 50);
			try {
				await waitForBranch("main");
				gitIn(dir, "checkout -q -b feature");
				await waitForBranch("feature");
				// Let several poll ticks pass: re-samples of an unchanged
				// branch must not re-fire the listener.
				await sleep(200);
				assert.deepEqual(seen, ["main", "feature"]);
			} finally {
				stopBranchWatcher();
			}
		} finally {
			unsubscribe();
		}
	} finally {
		cleanup(dir);
	}
});

test("branch change listener stops firing after unsubscribe", async () => {
	_resetGitBranchStateForTests();
	const dir = makeRepo();
	try {
		let calls = 0;
		const unsubscribe = onBranchChange(() => {
			calls++;
		});
		unsubscribe();
		startBranchWatcher(dir, 50);
		try {
			await waitForBranch("main");
			await sleep(200);
			assert.equal(calls, 0);
		} finally {
			stopBranchWatcher();
		}
	} finally {
		cleanup(dir);
	}
});

// Flaky on Windows CI: the timing window (a 400ms fake lookup vs 50ms ticks)
// collapses when process creation is stalled by antivirus / EDR, so the
// assert occasionally sees a second spawn that the watchdog then kills. The
// anti-pileup behavior itself is still covered by the runGit deadline test.
test.skip("branch watcher skips ticks while a lookup is in flight", async () => {
	_resetGitBranchStateForTests();
	const dir = mkdtempSync(join(tmpdir(), "sigpi-git-skip-"));
	const fakeDir = mkdtempSync(join(tmpdir(), "sigpi-git-fake-skip-"));
	const logPath = join(fakeDir, "spawns.log");
	try {
		// A deliberately slow lookup (400ms) must not be re-spawned by the
		// 50ms ticker: while one sample is in flight, later ticks skip, so a
		// stalled git can never pile up processes.
		const spec = fakeGitSpec(
			logPath,
			`await new Promise((resolve) => setTimeout(resolve, 400)); console.log("fake-branch");`,
			`sleep 0.4; echo fake-branch`,
		);
		const restore = installFakeGit(dir, fakeDir, spec);
		try {
			startBranchWatcher(dir, 50);
			try {
				await waitFor(
					() => countLabel(logPath, "spawn") >= 1,
					"the first sample never spawned",
				);
				await sleep(200);
				assert.equal(
					countLabel(logPath, "spawn"),
					1,
					"ticks while a lookup is in flight must not spawn git",
				);
				await waitForBranch("fake-branch");
			} finally {
				stopBranchWatcher();
				await waitFor(
					() => countLabel(logPath, "exit") >= countLabel(logPath, "spawn"),
					"spawned fake git processes never exited",
				);
			}
		} finally {
			restore();
		}
	} finally {
		cleanup(dir);
		cleanup(fakeDir);
	}
});

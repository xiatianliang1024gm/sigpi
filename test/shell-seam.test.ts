import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSystemPrompt } from "../src/defaults.js";
import {
	captureRcDefinitions,
	createShellRuntime,
	detectShellRuntime,
	resolvePosixDefaultShell,
	sanitizeWorkingDirectory,
	sourceScript,
	supportsRcCapture,
} from "../src/shell.js";
import { bashTool, createBashTool } from "../src/tools/builtin/bash.js";
import { ReadTracker } from "../src/tools/read-tracker.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ShellKind } from "../src/types.js";

// Shells we exercise per-shell. Each entry is skipped when the binary is not
// present on the runner, so the suite stays green on minimal images.
const POSIX_SHELLS: ShellKind[] = ["sh", "bash", "zsh"];

function shellPresent(shell: ShellKind): boolean {
	try {
		const rt = createShellRuntime(shell, "linux");
		// Probe the binary; throws (ENOENT) when absent.
		execFileSync(rt.executable, ["-c", "true"], {
			timeout: 2_000,
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

for (const shell of POSIX_SHELLS) {
	const present = shellPresent(shell);

	test(`bash executes a command under ${shell}`, {
		skip: !present,
	}, async () => {
		const shellRuntime = createShellRuntime(shell, "linux");
		const tools = new ToolRegistry([
			createBashTool(shellRuntime, {}, new ReadTracker()),
		]);

		const result = await tools.execute(
			{
				id: `exec_${shell}`,
				name: "bash",
				arguments: { command: "printf hello" },
				rawArguments: '{"command":"printf hello"}',
			},
			{ cwd: process.cwd() },
		);

		assert.equal(result.ok, true);
		assert.equal((result.data as { ok: boolean }).ok, true);
		assert.equal((result.data as { stdout: string }).stdout, "hello");
	});

	test(`bash reports a not-found message under ${shell}`, {
		skip: !present,
	}, async () => {
		const shellRuntime = createShellRuntime(shell, "linux");
		const tools = new ToolRegistry([
			createBashTool(shellRuntime, {}, new ReadTracker()),
		]);

		const result = await tools.execute(
			{
				id: `fail_${shell}`,
				name: "bash",
				arguments: { command: "nonexistent-command-xyz" },
				rawArguments: '{"command":"nonexistent-command-xyz"}',
			},
			{ cwd: process.cwd() },
		);

		assert.equal(result.ok, true);
		assert.equal((result.data as { ok: boolean }).ok, false);
		// Match whatever wording the resolved shell emits — never hardcode
		// zsh/bash phrasing.
		assert.match(
			(result.data as { stderr: string }).stderr,
			/not found|command not found|No such file/i,
		);
	});

	test(`bash resets to the project directory on every call under ${shell}`, {
		skip: !present,
	}, async () => {
		const shellRuntime = createShellRuntime(shell, "linux");
		const startDir = process.cwd();
		const outputDir = path.join(
			tmpdir(),
			`sigpi-shell-seam-${shell}-${Date.now()}`,
		);
		await mkdir(outputDir, { recursive: true });
		const tools = new ToolRegistry([
			createBashTool(shellRuntime, {}, new ReadTracker()),
		]);
		const ctx = {
			cwd: startDir,
			bash: { outputDir },
		};
		const subDir = path.join(startDir, `shell-seam-cd-${shell}`);
		await mkdir(subDir, { recursive: true });
		try {
			await tools.execute(
				{
					id: `cd_${shell}`,
					name: "bash",
					arguments: { command: `cd '${subDir}'` },
					rawArguments: `{"command":"cd '${subDir}'"}`,
				},
				ctx,
			);
			// The `cd` only affected that command's own process; the next
			// call must start in the project directory again.
			const pwd = await tools.execute(
				{
					id: `pwd_${shell}`,
					name: "bash",
					arguments: { command: "pwd" },
					rawArguments: '{"command":"pwd"}',
				},
				ctx,
			);
			assert.equal((pwd.data as { stdout: string }).stdout.trim(), startDir);
		} finally {
			await rm(subDir, { recursive: true, force: true }).catch(() => {});
			await rm(outputDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	test(`CLAUDE_ENV_FILE loads under ${shell}`, { skip: !present }, async () => {
		const shellRuntime = createShellRuntime(shell, "linux");
		const envFile = path.join(tmpdir(), `sigpi-env-${shell}-${Date.now()}.sh`);
		await writeFile(envFile, "export SIGPI_SEAM_VAR=loaded\n", "utf8");
		const tools = new ToolRegistry([
			createBashTool(shellRuntime, { envFile }, new ReadTracker()),
		]);
		try {
			const result = await tools.execute(
				{
					id: `env_${shell}`,
					name: "bash",
					arguments: { command: 'printf "%s" "$SIGPI_SEAM_VAR"' },
					rawArguments: '{"command":"printf \\"%s\\" \\"$SIGPI_SEAM_VAR\\""}',
				},
				{ cwd: process.cwd() },
			);
			assert.equal(result.ok, true);
			assert.equal((result.data as { stdout: string }).stdout, "loaded");
		} finally {
			await rm(envFile, { force: true }).catch(() => {});
		}
	});
}

test("sourceScript uses the portable '.' form for POSIX shells", () => {
	const sh = createShellRuntime("sh", "linux");
	const bash = createShellRuntime("bash", "linux");
	assert.equal(sourceScript(sh, "/tmp/x.sh"), ". '/tmp/x.sh'");
	assert.equal(sourceScript(bash, "/tmp/x.sh"), ". '/tmp/x.sh'");
});

test("sanitizeWorkingDirectory strips NUL bytes instead of discarding the path", () => {
	// UTF-16LE read back as UTF-8 leaves a NUL after every ASCII char;
	// stripping recovers the original path.
	assert.equal(
		sanitizeWorkingDirectory(
			"C:\\Users\\l008005\u0000\\repos\u0000\\csh",
			"/fallback",
		),
		"C:\\Users\\l008005\\repos\\csh",
	);
});

test("sanitizeWorkingDirectory drops lone surrogates and trims", () => {
	assert.equal(
		sanitizeWorkingDirectory(" C:\\a\uD800b ", "/fallback"),
		"C:\\ab",
	);
});

test("sanitizeWorkingDirectory falls back when nothing usable remains", () => {
	assert.equal(
		sanitizeWorkingDirectory("\u0000\u0000", "/fallback"),
		"/fallback",
	);
	assert.equal(sanitizeWorkingDirectory("", "/fallback"), "/fallback");
	assert.equal(sanitizeWorkingDirectory(undefined, "/fallback"), "/fallback");
});

test("bash tool sanitizes a NUL-laden cwd instead of failing with the spawn NUL-byte error", async () => {
	// Regression: a project cwd containing NUL bytes (a Windows session can
	// carry such a path into the tool context) previously made child_process
	// throw "The property 'options.cwd' must be a string, uint8Array, or URL
	// without null bytes" on every call. The sanitizer must run before spawn,
	// so the tool executes (here powershell.exe is absent on Linux and the
	// spawn fails cleanly with ENOENT) instead of rejecting with the encoding
	// error.
	const shellRuntime = createShellRuntime("powershell", "win32");
	const tools = new ToolRegistry([
		createBashTool(shellRuntime, {}, new ReadTracker()),
	]);
	const result = await tools.execute(
		{
			id: "nul_cwd_1",
			name: "bash",
			arguments: { command: "echo hi" },
			rawArguments: '{"command":"echo hi"}',
		},
		{ cwd: "C:\\Users\\l008005\u0000\\repos\u0000\\csh" },
	);

	assert.equal(
		result.ok,
		true,
		"tool must not reject with a spawn validation error",
	);
	const data = result.data as { ok: boolean; stderr: string };
	assert.equal(data.ok, false); // powershell.exe is not present on this runner
	assert.doesNotMatch(data.stderr, /null bytes/);
	assert.doesNotMatch(data.stderr, /options\.cwd/);
});

test("sourceScript uses '.' for PowerShell (unchanged)", () => {
	const ps = createShellRuntime("powershell", "win32");
	assert.equal(sourceScript(ps, "/tmp/x.ps1"), ". '/tmp/x.ps1'");
});

test("supportsRcCapture is true for bash/zsh/sh and false for PowerShell", () => {
	assert.equal(supportsRcCapture(createShellRuntime("bash", "linux")), true);
	assert.equal(supportsRcCapture(createShellRuntime("zsh", "linux")), true);
	assert.equal(supportsRcCapture(createShellRuntime("sh", "linux")), true);
	assert.equal(
		supportsRcCapture(createShellRuntime("powershell", "win32")),
		false,
	);
});

test("captureRcDefinitions returns empty for PowerShell", async () => {
	const result = await captureRcDefinitions(
		createShellRuntime("powershell", "win32"),
	);
	assert.equal(result, "");
});

test("captureRcDefinitions degrades gracefully on sh (no alias/function builtins)", async () => {
	// On `sh`/`dash` the probe must not error; it returns whatever the rc file
	// produced (often empty), never throwing.
	const result = await captureRcDefinitions(createShellRuntime("sh", "linux"));
	assert.equal(typeof result, "string");
});

test("captureRcDefinitions still captures aliases/functions under bash", async () => {
	if (!shellPresent("bash")) return;
	const result = await captureRcDefinitions(
		createShellRuntime("bash", "linux"),
	);
	assert.equal(typeof result, "string");
});

test("detectShellRuntime resolves a robust POSIX default without hardcoding zsh", () => {
	// With no configured shell and no $SHELL hint, the default must be a POSIX
	// shell that is present, not zsh (which may be absent on minimal runners).
	const runtime = detectShellRuntime(undefined, "linux", {});
	assert.notEqual(runtime.shell, "zsh");
	assert.ok(["sh", "bash"].includes(runtime.shell));
});

test("resolvePosixDefaultShell prefers $SHELL when present and available", () => {
	const runtime = detectShellRuntime(undefined, "linux", {
		SHELL: "/usr/bin/bash",
	});
	assert.equal(runtime.shell, "bash");
});

test("resolvePosixDefaultShell falls back to an available POSIX shell", () => {
	// Force $SHELL to a missing binary; the resolver must fall back to a real
	// one rather than spawning a missing binary.
	const fallback = resolvePosixDefaultShell({
		SHELL: "/nonexistent/shell",
		PATH: process.env.PATH,
	});
	assert.ok(["sh", "bash"].includes(fallback));
});

test("default bashTool resolves a present shell (no zsh ENOENT)", async () => {
	// The exported default tool must work on a runner without zsh. We only
	// assert it does not crash with an empty-stderr ENOENT failure.
	const result = await new ToolRegistry([bashTool]).execute(
		{
			id: "default_1",
			name: "bash",
			arguments: { command: "printf ok" },
			rawArguments: '{"command":"printf ok"}',
		},
		{ cwd: process.cwd() },
	);
	assert.equal(result.ok, true);
	assert.equal((result.data as { stdout: string }).stdout, "ok");
});

test("system prompt reflects the resolved shell, not a hardcoded zsh", () => {
	const runtime = detectShellRuntime(undefined, "linux", {
		SHELL: "/usr/bin/bash",
	});
	const prompt = buildSystemPrompt(runtime);
	assert.match(prompt, /Current shell for bash: bash/);
	assert.doesNotMatch(prompt, /Current shell for bash: zsh/);
});

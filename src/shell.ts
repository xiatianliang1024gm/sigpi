import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ShellConfig } from "./config.js";
import type { ShellKind, ShellRuntime } from "./types.js";

const execFileAsync = promisify(execFile);

export function detectShellRuntime(
	config: ShellConfig = {},
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): ShellRuntime {
	const requestedShell = normalizeShellKind(config.kind);
	const executableOverride = config.path;
	const shellFromPath = normalizeShellExecutable(config.path);

	if (requestedShell) {
		return createShellRuntime(requestedShell, platform, executableOverride);
	}

	if (shellFromPath) {
		return createShellRuntime(shellFromPath, platform, executableOverride);
	}

	const inferredShell = inferShellFromEnvironment(platform, env);
	if (inferredShell) {
		return createShellRuntime(inferredShell, platform, executableOverride);
	}

	if (platform === "win32") {
		return createShellRuntime("powershell", platform, executableOverride);
	}

	// No shell was requested or inferred. Prefer the user's login shell from
	// `$SHELL` when it names a POSIX shell that is actually present, then fall
	// back to a portable POSIX default that exists on the runner. We never
	// hardcode `zsh`: on minimal images (e.g. ubuntu-latest) zsh is absent and
	// `execFile("zsh", …)` would throw `ENOENT`.
	const fallback = resolvePosixDefaultShell(env);
	return createShellRuntime(fallback, platform, executableOverride);
}

/**
 * Resolve a POSIX default shell that is present on the runner.
 *
 * Order of preference:
 *  1. `$SHELL` when it names a known POSIX shell and that binary exists.
 *  2. `bash` if present (most common interactive default).
 *  3. `sh` if present (guaranteed POSIX, last resort before giving up).
 *
 * Returns `null` only when no candidate exists, so the caller can surface a
 * clear error rather than spawning a missing binary.
 */
export function resolvePosixDefaultShell(
	env: NodeJS.ProcessEnv = process.env,
): ShellKind {
	const fromEnv = normalizeShellExecutable(env.SHELL);
	if (
		fromEnv &&
		fromEnv !== "powershell" &&
		fromEnv !== "pwsh" &&
		fromEnv !== "cmd" &&
		isExecutablePresent(fromEnv)
	) {
		return fromEnv;
	}

	for (const candidate of ["bash", "sh"] as const) {
		if (isExecutablePresent(candidate)) {
			return candidate;
		}
	}

	// Nothing we recognize is on PATH. Spawning will fail, but we still return
	// a sensible default so the error surfaces from the OS (not a hardcoded
	// zsh ENOENT) and the caller's stderr fallback can report it.
	return "sh";
}

function isExecutablePresent(name: string): boolean {
	try {
		execFileSync(name, ["--version"], { timeout: 2_000, stdio: "ignore" });
		return true;
	} catch (error) {
		// `ENOENT` means the binary is missing. Any other error (e.g. an
		// unsupported `--version` flag) means the binary exists and ran, so we
		// treat it as present.
		return (error as NodeJS.ErrnoException)?.code !== "ENOENT";
	}
}

export function createShellRuntime(
	shell: ShellKind,
	platform: NodeJS.Platform,
	executableOverride?: string,
): ShellRuntime {
	switch (shell) {
		case "zsh":
			return {
				platform,
				shell,
				executable: executableOverride ?? "zsh",
				argsPrefix: ["-lc"],
				displayName: "zsh",
			};
		case "bash":
			return {
				platform,
				shell,
				executable: executableOverride ?? "bash",
				argsPrefix: ["-lc"],
				displayName: "bash",
			};
		case "sh":
			return {
				platform,
				shell,
				executable: executableOverride ?? "sh",
				argsPrefix: ["-lc"],
				displayName: "sh",
			};
		case "pwsh":
			return {
				platform,
				shell,
				executable: executableOverride ?? "pwsh.exe",
				argsPrefix: [
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-EncodedCommand",
				],
				displayName: "PowerShell 7",
			};
		case "powershell":
			return {
				platform,
				shell,
				executable: executableOverride ?? "powershell.exe",
				argsPrefix: [
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-EncodedCommand",
				],
				displayName: "Windows PowerShell",
			};
		case "cmd":
			return {
				platform,
				shell,
				executable: executableOverride ?? "cmd.exe",
				argsPrefix: ["/d", "/s", "/c"],
				displayName: "cmd.exe",
			};
	}
}

interface ShellInvocationOptions {
	/**
	 * Text prepended to every command (e.g. env-file source + captured rc
	 * alias/function definitions). Runs in the same shell as the command so
	 * aliases/functions are available to it.
	 */
	preamble?: string;
}

export function buildShellInvocation(
	shellRuntime: ShellRuntime,
	command: string,
	options: ShellInvocationOptions = {},
): {
	executable: string;
	args: string[];
	/** Temp script file containing the command, when argv would be too large. */
	scriptPath?: string;
} {
	const segments: string[] = [];
	if (options.preamble) {
		segments.push(options.preamble);
	}
	segments.push(command);
	const full = segments.join("\n");

	if (shellRuntime.shell === "powershell" || shellRuntime.shell === "pwsh") {
		return {
			executable: shellRuntime.executable,
			args: [...shellRuntime.argsPrefix, buildPowerShellEncodedCommand(full)],
		};
	}

	// POSIX: write the command to a temp script file and source it. Inlining
	// `full` as a `-c` argument can blow past the OS single-argument limit
	// (MAX_ARG_STRLEN, ~128 KiB) when the captured rc alias/function preamble
	// is large, failing the spawn with E2BIG. Sourcing a file keeps argv tiny.
	const scriptPath = path.join(os.tmpdir(), `sigpi-sh-${randomUUID()}.sh`);
	// Close stdin inside the shell: an agent shell is non-interactive, and a
	// command that wrongly reads stdin (e.g. `rg pattern` without a path,
	// bare `cat`) would otherwise block on the never-closed pipe until the
	// tool timeout kills it. `exec < /dev/null` replaces the shell's own
	// stdin, so every child command inherits /dev/null and sees EOF
	// immediately. This also covers background tasks spawned via this
	// invocation.
	writeFileSync(scriptPath, `exec < /dev/null\n${full}`, "utf8");
	return {
		executable: shellRuntime.executable,
		args: [...shellRuntime.argsPrefix, `. '${scriptPath}'`],
		scriptPath,
	};
}

/**
 * Remove characters that can never appear in a real filesystem path but that
 * sneak in when a path crosses an encoding boundary on Windows — most
 * commonly a UTF-16LE capture file read back as UTF-8, which leaves a NUL
 * byte after every ASCII char, and misdecoded lone surrogates that break the
 * UTF-8 handoff when spawning. NUL bytes are *stripped* rather than treated
 * as invalid because stripping usually recovers the correct path
 * (`C:\u0000U\u0000s\u0000e...` → `C:\Users\...`). Falls back to `fallback`
 * when nothing usable remains.
 */
export function sanitizeWorkingDirectory(
	value: string | undefined,
	fallback: string,
): string {
	const clean = (value ?? "")
		.replace(/\u0000/gu, "")
		.replace(/[\uD800-\uDFFF]/gu, "")
		.trim();
	return clean || fallback;
}

/**
 * Send a signal to a process and, on POSIX, its whole process group. Killing
 * just the direct shell PID leaves the grandchildren the command spawned
 * (e.g. `server &`) running, which is both a process leak and the reason a
 * plain `kill(pid)` never actually stops a command. On Windows there is no
 * process-group concept, so we fall back to the lone PID. No-ops when `pid`
 * is absent/zero (e.g. the process failed to spawn), and swallows ESRCH so a
 * race with an already-exited process is harmless.
 */
export function killProcessGroup(
	pid: number | null | undefined,
	signal: NodeJS.Signals = "SIGTERM",
): void {
	if (!pid || pid <= 0) {
		return;
	}
	if (process.platform === "win32") {
		try {
			process.kill(pid, signal);
		} catch {
			// already gone
		}
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// already gone
		}
	}
}

/**
 * Source a script file in the given shell. POSIX shells use `.` (the portable
 * form of `source`, which is a bash/zsh extension and does not exist in
 * `sh`/`dash`); PowerShell uses `.` as well. Centralizing this behind the
 * `ShellRuntime` seam keeps the bash tool from branching on shell kind.
 */
export function sourceScript(shellRuntime: ShellRuntime, file: string): string {
	// POSIX shells and PowerShell both source with `.` (the portable form of
	// bash/zsh `source`, which does not exist in `sh`/`dash`). The runtime is
	// threaded through so the seam owns any future per-shell divergence.
	void shellRuntime;
	return `. '${file}'`;
}

/**
 * Whether the shell provides the builtins needed to capture rc alias and
 * function definitions. bash/zsh expose `alias`/`declare -f`/`typeset -f`;
 * `sh`/`dash` do not reliably, so rc capture is skipped there rather than
 * running a probe that would error. PowerShell/cmd defer rc capture entirely.
 */
export function supportsRcCapture(shellRuntime: ShellRuntime): boolean {
	return (
		shellRuntime.shell === "bash" ||
		shellRuntime.shell === "zsh" ||
		shellRuntime.shell === "sh"
	);
}

function buildPowerShellEncodedCommand(command: string): string {
	const commandBase64 = Buffer.from(command, "utf8").toString("base64");
	const script = [
		"$__sigpiUtf8 = [System.Text.UTF8Encoding]::new($false)",
		"[Console]::InputEncoding = $__sigpiUtf8",
		"[Console]::OutputEncoding = $__sigpiUtf8",
		"$OutputEncoding = $__sigpiUtf8",
		// Non-interactive: close stdin defensively so a command that reads it
		// fails fast instead of blocking until the tool timeout kills it.
		"try { [Console]::In.Close() } catch { }",
		`$__sigpiCommand = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${commandBase64}'))`,
		"Invoke-Expression $__sigpiCommand",
		"$__sigpiSucceeded = $?",
		"$__sigpiExitCode = $global:LASTEXITCODE",
		"if (-not $__sigpiSucceeded) {",
		"\tif ($__sigpiExitCode -is [int] -and $__sigpiExitCode -ne 0) {",
		"\t\texit $__sigpiExitCode",
		"\t}",
		"\texit 1",
		"}",
	].join("\n");

	return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Capture rc-file alias and function definitions once at session start.
 * Sources the interactive rc (`~/.zshrc` / `~/.bashrc`) in a throwaway probe
 * shell and returns the captured `alias` + function definitions, which the
 * `bash` tool injects as a preamble before each command. This applies
 * aliases/functions without replaying rc side effects (stray `cd`/`export`)
 * into the command's environment.
 *
 * pwsh/cmd profile capture is deferred in v1, so this returns empty there.
 * On `sh`/`dash` the shell lacks the `alias`/`typeset -f` builtins, so we
 * skip the unsupported parts and only source the rc file (which may still set
 * useful state) rather than running a probe that would error.
 */
export async function captureRcDefinitions(
	shellRuntime: ShellRuntime,
): Promise<string> {
	if (!supportsRcCapture(shellRuntime)) {
		return "";
	}

	const rcFile = shellRuntime.shell === "bash" ? "~/.bashrc" : "~/.zshrc";
	const definitionsCommand =
		shellRuntime.shell === "bash" ? "declare -f" : "typeset -f";
	// zsh's bare `alias` prints `name=value` for regular aliases and
	// `name!=value` for global aliases. Neither form is re-sourceable: when
	// injected as a preamble and sourced again, `name=value` is misparsed as a
	// stray command/assignment and `name!=value` is read as a command named
	// `name!`, flooding stderr with `command not found` / `no such file or
	// directory` errors and dropping the aliases. `alias -L` instead prints
	// `alias -- name='value'` (regular) and `alias -g name='value'` (global),
	// which re-source cleanly. bash's `alias` already emits `alias name='value'`,
	// so it needs no change. `sh`/`dash` have no alias/function builtins, so we
	// only source the rc file and capture nothing else.
	const listAliases = shellRuntime.shell === "zsh" ? "alias -L" : "alias";
	const capture =
		shellRuntime.shell === "sh" ? "" : `${listAliases}; ${definitionsCommand}`;
	const probe = `source ${rcFile} 2>/dev/null; ${capture}`;

	try {
		const { stdout } = await execFileAsync(
			shellRuntime.executable,
			[...shellRuntime.argsPrefix, probe],
			{ timeout: 10_000 },
		);
		return stdout.trim();
	} catch {
		return "";
	}
}

function normalizeShellKind(rawShell: string | undefined): ShellKind | null {
	switch (rawShell) {
		case "zsh":
		case "bash":
		case "sh":
		case "pwsh":
		case "powershell":
		case "cmd":
			return rawShell;
		default:
			return null;
	}
}

function normalizeShellExecutable(
	rawExecutable: string | undefined,
): ShellKind | null {
	if (!rawExecutable) {
		return null;
	}

	const normalized = rawExecutable
		.replaceAll("\\", "/")
		.split("/")
		.at(-1)
		?.toLowerCase()
		.replace(/\.exe$/u, "");

	if (!normalized) {
		return null;
	}

	if (normalized === "powershell") {
		return "powershell";
	}

	return normalizeShellKind(normalized);
}

function inferShellFromEnvironment(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): ShellKind | null {
	const shellFromEnv = normalizeShellExecutable(env.SHELL);

	if (platform === "win32") {
		if (shellFromEnv && isWindowsNativeShellKind(shellFromEnv)) {
			return shellFromEnv;
		}

		if (shellFromEnv && isWindowsPosixShellEnvironment(env)) {
			return shellFromEnv;
		}

		if (isWindowsPosixShellEnvironment(env)) {
			return "bash";
		}

		return null;
	}

	if (shellFromEnv) {
		return shellFromEnv;
	}

	return null;
}

function isWindowsNativeShellKind(shell: ShellKind): boolean {
	return shell === "powershell" || shell === "pwsh" || shell === "cmd";
}

function isWindowsPosixShellEnvironment(env: NodeJS.ProcessEnv): boolean {
	return (
		Boolean(env.MSYSTEM) ||
		Boolean(env.MINGW_PREFIX) ||
		Boolean(env.CYGWIN) ||
		env.TERM_PROGRAM === "mintty"
	);
}

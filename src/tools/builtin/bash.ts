import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	closeSync,
	createReadStream,
	createWriteStream,
	openSync,
} from "node:fs";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { z } from "zod";
import type { RunShellConfig } from "../../config.js";
import {
	isTurnInterruptedError,
	TurnInterruptedError,
} from "../../interrupt.js";
import { compactWhitespace, getString, truncate } from "../../progress.js";
import {
	buildShellInvocation,
	detectShellRuntime,
	killProcessGroup,
	sanitizeWorkingDirectory,
	sourceScript,
} from "../../shell.js";
import type { ShellRuntime, ToolDefinition } from "../../types.js";
import { ReadTracker } from "../read-tracker.js";
import { ToolExecutionError } from "../registry.js";
import { joinRenderedSections, withRendered } from "../render.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_LENGTH = 30_000;
const DATA_TRUNCATION_CAP = 4_000;
const OVERFLOW_PREVIEW_CHARS = 2_000;
const BLOCK_START_MARKER = "=== CONTENT START ===";
const BLOCK_END_MARKER = "=== CONTENT END ===";

const bashSchema = z.object({
	command: z.string().min(1),
	timeout: z
		.number()
		.int()
		.positive()
		.max(60 * 60 * 1000)
		.optional(),
	maxOutputChars: z.number().int().positive().optional(),
	description: z.string().optional(),
	// Models sometimes emit boolean arguments as strings (e.g. "true"/
	// "false"). Coerce the common truthy/falsy spellings so a stray string
	// doesn't hard-fail the whole tool call; genuinely unknown values still
	// fail with a clear zod error.
	run_in_background: z.preprocess(coerceBooleanLiteral, z.boolean().optional()),
});

/**
 * Coerce string/number spellings of a boolean (and pass real booleans and
 * undefined through). Unrecognized strings are left untouched so the wrapped
 * `z.boolean()` produces a clear validation error instead of silently
 * coercing (note: `"false"` must map to `false`, which `z.coerce.boolean()`
 * would get wrong).
 */
function coerceBooleanLiteral(value: unknown): unknown {
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "1", "yes", "on"].includes(normalized)) {
			return true;
		}
		if (["false", "0", "no", "off", ""].includes(normalized)) {
			return false;
		}
	}
	return value;
}

type BashArgs = z.infer<typeof bashSchema>;

export function createBashTool(
	shellRuntime: ShellRuntime,
	config: RunShellConfig = {},
	tracker: ReadTracker,
): ToolDefinition<BashArgs> {
	return {
		name: "bash",
		description:
			`Run a command in a shell (${shellRuntime.displayName}). ` +
			"Every command starts in the project directory; a `cd` inside a " +
			"command affects only that command's process and never carries " +
			"into later commands, so write paths relative to the project " +
			"directory (or use absolute paths). " +
			"Returns stdout, stderr, and exit status. For long output it writes " +
			"the full output to a session file and returns the path plus a preview. " +
			"stdin is closed (non-interactive): a command that tries to read stdin " +
			"sees EOF immediately instead of hanging.",
		inputSchema: bashSchema as z.ZodType<BashArgs>,
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description:
						"Shell command to run, for example: ls -la or cat README.md",
				},
				timeout: {
					type: "integer",
					description:
						"Optional timeout in milliseconds (default 120000; clamped to " +
						"the configured maximum, default 600000). For a background task, " +
						"the timeout only applies when you set it explicitly.",
				},
				maxOutputChars: {
					type: "integer",
					description:
						"Optional cap on inline output characters before it is " +
						"written to a session file (default 30000; values above the " +
						"configured max_output_length are clamped down to it).",
				},
				description: {
					type: "string",
					description:
						"Optional human-readable description of what this command does.",
				},
				run_in_background: {
					type: "boolean",
					description:
						"Optional. Run the command as a background task (non-blocking) when " +
						"true; the tool returns a task id and log path you can inspect with " +
						"/tasks. Defaults to false (foreground, waits for completion). If " +
						"timeout is omitted the task runs until it finishes or is stopped. " +
						'Send a real boolean, not a string like "true".',
				},
			},
			required: ["command"],
			additionalProperties: false,
		},
		execute: async (
			{ command, timeout, maxOutputChars, description, run_in_background },
			context,
		) => {
			if (context.abortSignal?.aborted) {
				const reason = context.abortSignal.reason;
				if (isTurnInterruptedError(reason)) {
					throw reason;
				}
				throw new TurnInterruptedError("user_escape", "tool");
			}

			const bash = context.bash;
			// Every command runs in the project directory: `cd` inside a
			// command affects only that command's own process, so there is no
			// working-directory state to carry or reset between calls. The
			// cwd is sanitized anyway because a Windows session can carry a
			// NUL-laden path into `context.cwd`, which would make
			// child_process throw "options.cwd must be a string ... without
			// null bytes" on every spawn.
			const projectDir = sanitizeWorkingDirectory(context.cwd, process.cwd());
			const outputDir =
				bash?.outputDir ?? path.join(os.tmpdir(), "sigpi-bash-outputs");
			const defaultTimeout = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
			const maxTimeout = config.maxTimeoutMs ?? MAX_TIMEOUT_MS;
			const requestedTimeout = timeout ?? defaultTimeout;
			const timeoutMs = Math.min(Math.max(requestedTimeout, 1), maxTimeout);

			const outputLength = config.maxOutputLength ?? DEFAULT_OUTPUT_LENGTH;
			const limit = Math.min(maxOutputChars ?? outputLength, outputLength);

			const preamble = buildPreamble(
				shellRuntime,
				config.envFile,
				bash?.rcDefinitionsFile,
			);

			if (run_in_background) {
				const manager = bash?.tasks;
				if (!manager) {
					throw new ToolExecutionError(
						"run_in_background requires a background task manager, which is unavailable in this runtime",
					);
				}
				// Background tasks are long-running by design, so the timeout
				// only bounds them when the model explicitly set one — the
				// default 120s would otherwise kill a 10-minute build.
				const bgTimeoutMs =
					timeout != null ? Math.min(Math.max(timeout, 1), maxTimeout) : null;
				// Ensure the log directory exists: the foreground path only
				// mkdir's outputDir on overflow, so a background task started
				// before any overflowing foreground call would hit ENOENT when
				// the manager writes its .log file.
				await mkdir(outputDir, { recursive: true });
				const taskId = randomUUID();
				const logPath = path.join(outputDir, `${taskId}.log`);
				const bgInvocation = buildShellInvocation(shellRuntime, command, {
					preamble,
				});
				const task = manager.spawn({
					id: taskId,
					command,
					invocation: {
						executable: bgInvocation.executable,
						args: bgInvocation.args,
					},
					cwd: projectDir,
					logPath,
					description: description ?? null,
					env: { ...process.env, TERM: process.env.TERM ?? "dumb" },
					scriptPath: bgInvocation.scriptPath,
					timeoutMs: bgTimeoutMs,
				});

				return withRendered(
					{
						task_id: task.id,
						pid: task.pid,
						log_path: task.logPath,
						command,
						description: description ?? null,
						status: task.status,
					},
					joinRenderedSections([
						`Background task started: ${task.id}`,
						`Command: ${command}`,
						`Logs: ${task.logPath}`,
						`List tasks with "/tasks"; open a task's details with Enter and press "k" to stop it.`,
					]),
				);
			}

			const invocation = buildShellInvocation(shellRuntime, command, {
				preamble,
			});

			// Redirect stdout/stderr to transient temp files instead of pipes.
			// Pipes are what made the old `execFile` path hang: `execFile`
			// resolves only once the child's stdio pipes fully close, and a
			// command that backgrounds a child (e.g. `server &`) hands the
			// pipe write-end to that grandchild, so the pipe stays open until
			// every grandchild exits — stalling the whole timeout budget and
			// then reporting a misleading success. Files never block the wait,
			// and they remove the old 32MB `maxBuffer` crash: output streams to
			// disk and only the head is buffered for the inline preview.
			const outPath = path.join(
				os.tmpdir(),
				`sigpi-bash-out-${randomUUID()}.out`,
			);
			const errPath = path.join(
				os.tmpdir(),
				`sigpi-bash-err-${randomUUID()}.err`,
			);

			let ok = false;
			let exitCode: number | null = null;
			let signal: string | null = null;
			let timedOut = false;
			let stdout = "";
			let stderr = "";
			let overflowPath: string | undefined;
			let preview: string | undefined;

			try {
				const spawned = await spawnShell({
					executable: invocation.executable,
					args: invocation.args,
					cwd: projectDir,
					env: {
						...process.env,
						TERM: process.env.TERM ?? "dumb",
					},
					timeoutMs,
					abortSignal: context.abortSignal,
					stdoutPath: outPath,
					stderrPath: errPath,
				});

				if (spawned.aborted) {
					const reason = context.abortSignal?.reason;
					if (isTurnInterruptedError(reason)) {
						throw reason;
					}
					throw new TurnInterruptedError("user_escape", "tool");
				}

				exitCode = spawned.exitCode;
				signal = spawned.signal;
				timedOut = spawned.timedOut;

				if (spawned.spawnError) {
					// The shell never started (e.g. the binary is missing). Use
					// `||` (not `??`): the error file is empty and the error
					// message carries the reason, and we never want to hide it.
					stderr =
						(await readHead(errPath, limit)).trimEnd() ||
						spawned.spawnError.message;
				} else {
					ok = spawned.exitCode === 0;
					const outStat = await stat(outPath).catch(() => null);
					const errStat = await stat(errPath).catch(() => null);
					const totalLen = (outStat?.size ?? 0) + (errStat?.size ?? 0);

					if (totalLen > limit) {
						await mkdir(outputDir, { recursive: true });
						overflowPath = path.join(outputDir, `${randomUUID()}.txt`);
						await writeOverflowFile(overflowPath, {
							header: [
								`Command: ${command}`,
								`Cwd: ${projectDir}`,
								`Exit code: ${exitCode ?? "(none)"}`,
								...(signal ? [`Signal: ${signal}`] : []),
								...(timedOut ? [`Timed out after ${timeoutMs}ms`] : []),
							],
							stdoutPath: outPath,
							stderrPath: errPath,
						});
						preview = await readHead(overflowPath, OVERFLOW_PREVIEW_CHARS);
					} else {
						stdout = await readFile(outPath, "utf8").catch(() => "");
						stderr = await readFile(errPath, "utf8").catch(() => "");
					}
				}

				// Record recognized single-file reads so the edit tool's
				// read-before-edit check passes (resolved against the project
				// directory the command ran in).
				if (ok) {
					const readFile0 = detectSingleFileRead(command);
					if (readFile0) {
						await tracker.recordRead(projectDir, readFile0);
					}
				}
			} finally {
				if (invocation.scriptPath) {
					void rm(invocation.scriptPath, { force: true });
				}
				void rm(outPath, { force: true });
				void rm(errPath, { force: true });
			}

			const renderedStdout = overflowPath
				? (preview ?? "")
				: truncateHeadTail(stdout, limit);
			const renderedStderr = overflowPath
				? ""
				: truncateHeadTail(stderr, limit);
			const dataStdout = overflowPath
				? (preview ?? "")
				: truncateHeadTail(stdout, DATA_TRUNCATION_CAP);
			const dataStderr = overflowPath
				? ""
				: truncateHeadTail(stderr, DATA_TRUNCATION_CAP);

			// Surface the failure reason in the rendered text itself: the
			// renderer that feeds the model only reads the `rendered` string,
			// so structured fields like `timedOut`/`signal` would otherwise
			// never reach it and a bare timeout would look like a generic
			// "Command failed" wrapper error.
			const statusLine = ok
				? null
				: [
						`Exit code: ${exitCode ?? "(none)"}`,
						signal ? `Signal: ${signal}` : null,
						timedOut ? `Timed out after ${timeoutMs}ms` : null,
					]
						.filter((part): part is string => part !== null)
						.join(", ");

			return withRendered(
				{
					command,
					description: description ?? null,
					shell: shellRuntime.shell,
					platform: shellRuntime.platform,
					ok,
					exitCode,
					signal,
					timedOut,
					cwd: projectDir,
					overflowPath: overflowPath ?? null,
					stdout: dataStdout,
					stderr: dataStderr,
					stdoutTruncated: overflowPath
						? true
						: stdout.length > DATA_TRUNCATION_CAP,
					stderrTruncated: overflowPath
						? true
						: stderr.length > DATA_TRUNCATION_CAP,
				},
				joinRenderedSections([statusLine, renderedStdout, renderedStderr]),
			);
		},
		describeProgress(args) {
			const command = getString(args.command) ?? "";
			return { summary: `shell ${truncate(compactWhitespace(command), 300)}` };
		},
	};
}

function buildPreamble(
	shellRuntime: ShellRuntime,
	envFile: string | undefined,
	rcDefinitionsFile: string | undefined,
): string {
	const parts: string[] = [];
	if (envFile) {
		parts.push(sourceScript(shellRuntime, envFile));
	}
	if (rcDefinitionsFile) {
		parts.push(sourceScript(shellRuntime, rcDefinitionsFile));
	}
	return parts.join("\n");
}

interface SpawnShellOptions {
	executable: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	abortSignal?: AbortSignal;
	stdoutPath: string;
	stderrPath: string;
}

interface SpawnShellResult {
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	aborted: boolean;
	spawnError: Error | null;
}

/**
 * Spawn a shell command with stdout/stderr redirected to files, resolving as
 * soon as the *direct* shell process exits — never when its stdio pipes close.
 *
 * Waiting on pipe close is what hung the old `execFile` path: a command that
 * backgrounds a child (e.g. `server &`) hands the pipe write-end to that
 * grandchild, so the pipes stay open until every grandchild exits. That stalled
 * the tool for the full timeout budget and then reported a misleading success
 * (`execFile` resolves its timeout as a clean exit, never as a killed error).
 * Redirecting to files decouples our wait from the grandchildren entirely: a
 * background child keeps writing to its own temp file and never blocks the
 * result. Timeout/abort kill the whole process group (SIGTERM, then SIGKILL
 * escalation) so the actual work is stopped, not just the wrapper shell.
 */
async function spawnShell(
	options: SpawnShellOptions,
): Promise<SpawnShellResult> {
	// Open the capture files with plain fds (`openSync`, not `open`/
	// FileHandle) so the fd can be handed straight to `spawn` and closed
	// synchronously afterwards. A `FileHandle` would keep a live reference:
	// its GC finalizer would later `close()` the already-closed fd, raising
	// an EBADF uncaughtException that flakes whatever test/call is running.
	const outFd = openSync(options.stdoutPath, "w");
	const errFd = openSync(options.stderrPath, "w");
	let proc: ChildProcess;
	try {
		proc = spawn(options.executable, options.args, {
			cwd: options.cwd,
			env: options.env,
			// Own process group so `killProcessGroup` can take down the whole
			// tree (the shell *and* any grandchildren it spawned).
			detached: process.platform !== "win32",
			stdio: ["ignore", outFd, errFd],
			windowsHide: true,
		});
	} catch (error) {
		closeSync(outFd);
		closeSync(errFd);
		return {
			exitCode: null,
			signal: null,
			timedOut: false,
			aborted: false,
			spawnError: error as Error,
		};
	}
	// The child inherited these fds; close our copies so we don't leak them.
	// This must be synchronous: an `await` here would yield to the event loop
	// and let a spawn `error` (e.g. ENOENT for a missing shell binary) fire
	// before the listeners below attach, turning it into an uncaught exception
	// that rejects `execute` instead of returning a structured result.
	closeSync(outFd);
	closeSync(errFd);

	const pid = proc.pid ?? 0;

	return new Promise((resolve) => {
		let settled = false;
		let timedOut = false;
		let aborted = false;
		let escalateTimer: NodeJS.Timeout | undefined;

		// SIGTERM the group, then escalate to SIGKILL if it ignores SIGTERM so
		// the tool can never be stuck on a signal-immune process.
		const terminate = () => {
			killProcessGroup(pid, "SIGTERM");
			escalateTimer = setTimeout(() => killProcessGroup(pid, "SIGKILL"), 2_000);
			escalateTimer.unref?.();
		};

		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, options.timeoutMs);
		timeoutTimer.unref?.();

		const onAbort = () => {
			if (aborted) {
				return;
			}
			aborted = true;
			terminate();
		};
		if (options.abortSignal) {
			if (options.abortSignal.aborted) {
				onAbort();
			} else {
				options.abortSignal.addEventListener("abort", onAbort, { once: true });
			}
		}

		const cleanup = () => {
			clearTimeout(timeoutTimer);
			if (escalateTimer) {
				clearTimeout(escalateTimer);
			}
			options.abortSignal?.removeEventListener("abort", onAbort);
		};

		proc.once("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resolve({
				exitCode: null,
				signal: null,
				timedOut,
				aborted,
				spawnError: error,
			});
		});

		proc.once("exit", (code, procSignal) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resolve({
				exitCode: code,
				signal: procSignal,
				timedOut,
				aborted,
				spawnError: null,
			});
		});
	});
}

/**
 * Stream the stdout/stderr temp files into the overflow session file, keeping
 * the same structure the old in-memory path produced (a header line list plus
 * one CONTENT block per stream). Only the head of each file is ever held in
 * memory, so a multi-hundred-MB output spills to disk without buffering it
 * whole — the previous 32MB `maxBuffer` crash is gone.
 */
async function writeOverflowFile(
	overflowPath: string,
	options: {
		header: string[];
		stdoutPath: string;
		stderrPath: string;
	},
): Promise<void> {
	const dest = createWriteStream(overflowPath);
	try {
		for (const line of options.header) {
			dest.write(`${line}\n`);
		}
		dest.write("\n");
		await writeBodyBlock(dest, options.stdoutPath);
		await writeBodyBlock(dest, options.stderrPath);
	} finally {
		dest.end();
	}
	await once(dest, "finish");
}

async function writeBodyBlock(dest: Writable, srcPath: string): Promise<void> {
	const size = (await stat(srcPath).catch(() => null))?.size ?? 0;
	dest.write(`${BLOCK_START_MARKER}\n`);
	if (size === 0) {
		dest.write("(empty)\n");
		dest.write(`${BLOCK_END_MARKER}\n`);
		return;
	}
	const endMarker = await streamBody(dest, srcPath);
	dest.write(`${endMarker}\n`);
}

/**
 * Stream `srcPath` into `dest` while scanning for the end-marker candidates so
 * a marker that collides with the command's own output can be avoided (mirrors
 * the old `chooseUniqueMarker`, but scans without buffering the whole file).
 * Returns the chosen marker; the caller writes it after the body.
 */
async function streamBody(dest: Writable, srcPath: string): Promise<string> {
	const candidates: string[] = [BLOCK_END_MARKER];
	for (let suffix = 1; suffix <= 16; suffix++) {
		candidates.push(`${BLOCK_END_MARKER}_${suffix}`);
	}
	const found = new Set<string>();
	const reader = createReadStream(srcPath);
	let tail = "";
	let lastChar = "";
	for await (const chunk of reader) {
		const text = chunk.toString("utf8");
		const window = tail + text;
		for (const candidate of candidates) {
			if (window.includes(candidate)) {
				found.add(candidate);
			}
		}
		tail = (tail + text).slice(-(BLOCK_END_MARKER.length - 1));
		if (text.length > 0) {
			lastChar = text[text.length - 1];
		}
		if (!dest.write(chunk)) {
			await once(dest, "drain");
		}
	}
	const marker =
		candidates.find((candidate) => !found.has(candidate)) ??
		`${BLOCK_END_MARKER}_${candidates.length}`;
	if (lastChar !== "\n") {
		dest.write("\n");
	}
	return marker;
}

/** Read up to `maxBytes` from the head of a file as UTF-8. */
async function readHead(filePath: string, maxBytes: number): Promise<string> {
	try {
		const handle = await open(filePath, "r");
		try {
			const buffer = Buffer.alloc(maxBytes);
			const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return "";
	}
}

function truncateHeadTail(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}

	const marker = `\n...[truncated ${value.length - maxChars} chars; showing head/tail]...\n`;
	if (maxChars <= marker.length + 20) {
		return `${value.slice(0, maxChars)}\n...[truncated]`;
	}
	const keepChars = maxChars - marker.length;
	const headChars = Math.ceil(keepChars / 2);
	const tailChars = Math.floor(keepChars / 2);
	return `${value.slice(0, headChars)}${marker}${value.slice(value.length - tailChars)}`;
}

/**
 * If `command` is a recognized single-file read understood by Claude Code's
 * read-before-edit rule (cat/head/tail/sed -n 'X,Yp'/grep/egrep/fgrep on a
 * single file, with no pipe or redirect), return that file path. Otherwise
 * return null. Conservative: when in doubt, return null (no read recorded).
 */
function detectSingleFileRead(command: string): string | null {
	const unquoted = stripQuoted(command);
	if (/[|]/.test(unquoted) || /[>]/.test(unquoted)) {
		return null;
	}

	const tokens = tokenize(command);
	if (tokens.length === 0) {
		return null;
	}

	const cmd = tokens[0];
	const args = tokens.slice(1);

	switch (cmd) {
		case "cat":
		case "head":
		case "tail": {
			const files = args.filter((token) => !token.startsWith("-"));
			return files.length === 1 ? files[0] : null;
		}
		case "grep":
		case "egrep":
		case "fgrep": {
			if (
				args.some(
					(token) =>
						token === "-r" || token === "-R" || token === "--recursive",
				)
			) {
				return null;
			}
			const positional = args.filter((token) => !token.startsWith("-"));
			if (positional.length < 2) {
				return null;
			}
			const files = positional.slice(1);
			return files.length === 1 ? files[0] : null;
		}
		case "sed": {
			if (!args.includes("-n")) {
				return null;
			}
			if (args.includes("-i") || args.includes("--in-place")) {
				return null;
			}
			const scriptIndex = args.findIndex((token) => isSedPrintScript(token));
			if (scriptIndex === -1) {
				return null;
			}
			const files = args.filter(
				(token, index) => !token.startsWith("-") && index !== scriptIndex,
			);
			return files.length === 1 ? files[0] : null;
		}
		default:
			return null;
	}
}

function isSedPrintScript(token: string): boolean {
	const stripped = token.replace(/^["']|["']$/g, "");
	return /^\d*(,\d*)?p$/.test(stripped);
}

function stripQuoted(value: string): string {
	let result = "";
	let quote: string | null = null;
	for (const char of value) {
		if (quote) {
			if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		result += char;
	}
	return result;
}

export const bashTool: ToolDefinition<BashArgs> = createBashTool(
	detectShellRuntime(),
	{},
	new ReadTracker(),
);

function tokenize(value: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;
	let escaped = false;

	for (const char of value) {
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
		current += char;
	}

	if (current) {
		tokens.push(current);
	}

	return tokens;
}

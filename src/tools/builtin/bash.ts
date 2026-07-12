import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { RunShellConfig } from "../../config.js";
import {
	isTurnInterruptedError,
	TurnInterruptedError,
} from "../../interrupt.js";
import {
	compactWhitespace,
	getBoolean,
	getNumber,
	getString,
	truncate,
} from "../../progress.js";
import { buildShellInvocation, createShellRuntime } from "../../shell.js";
import type {
	RunShellMode,
	ShellRuntime,
	ToolDefinition,
} from "../../types.js";
import { ReadTracker } from "../read-tracker.js";
import { ToolExecutionError } from "../registry.js";
import {
	formatRawBlock,
	joinRenderedSections,
	withRendered,
} from "../render.js";
import { evaluateCommandPolicy } from "../sandbox-policy.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_LENGTH = 30_000;
const DATA_TRUNCATION_CAP = 4_000;
const OVERFLOW_PREVIEW_CHARS = 2_000;

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
	config: RunShellConfig = { mode: "workspace_write" },
	tracker: ReadTracker,
): ToolDefinition<BashArgs> {
	return {
		name: "bash",
		description:
			"Run a command in a shell. The working directory carries across " +
			"commands in this session (like a terminal): use `cd` to change it, " +
			"and it resets to the project directory if a command leaves it. " +
			"Returns stdout, stderr, and exit status. For long output it writes " +
			"the full output to a session file and returns the path plus a preview.",
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
						"Optional timeout in milliseconds (default 120000, max 600000).",
				},
				maxOutputChars: {
					type: "integer",
					description:
						"Optional cap on inline output characters before it is " +
						"written to a session file (default 30000, max 150000).",
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
						"/tasks. Defaults to false (foreground, waits for completion). Send a " +
						'real boolean, not a string like "true".',
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
			const workingDir = bash?.workingDir ?? {
				current: context.cwd,
				projectDir: context.cwd,
				maintainProjectWorkingDir: false,
			};
			const outputDir =
				bash?.outputDir ?? path.join(os.tmpdir(), "sigpi-bash-outputs");
			const mode = config.mode;
			const denial = evaluateCommandPolicy(command, workingDir.current, mode);

			if (denial) {
				context.logger?.warn("tool_execution_failed", {
					runId: context.runId,
					sessionId: context.sessionId,
					turnId: context.turnId,
					toolName: "bash",
					command,
					mode,
					reason: denial.reason,
				});
				throw new ToolExecutionError(
					`bash denied in ${mode} mode: ${denial.reason}`,
					withRendered(
						{
							command,
							mode,
							reason: denial.reason,
						},
						joinRenderedSections([
							`Command: ${command}`,
							`Mode: ${mode}`,
							`Reason: ${denial.reason}`,
						]),
					),
				);
			}

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
					cwd: workingDir.current,
					logPath,
					description: description ?? null,
					env: { ...process.env, TERM: process.env.TERM ?? "dumb" },
					scriptPath: bgInvocation.scriptPath,
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
						`Use "/tasks" to list tasks or "/tasks stop ${task.id}" to stop it.`,
					]),
				);
			}

			const cwdCaptureFile = path.join(
				os.tmpdir(),
				`sigpi-cwd-${randomUUID()}.txt`,
			);
			const invocation = buildShellInvocation(shellRuntime, command, {
				preamble,
				cwdCaptureFile,
			});

			const result = await execFileAsync(
				invocation.executable,
				invocation.args,
				{
					cwd: workingDir.current,
					timeout: timeoutMs,
					maxBuffer: Math.max(limit * 4, 64 * 1024, 32 * 1024 * 1024),
					signal: context.abortSignal,
					env: {
						...process.env,
						TERM: process.env.TERM ?? "dumb",
					},
				},
			)
				.then(
					({ stdout, stderr }) => ({
						ok: true as const,
						stdout,
						stderr,
						exitCode: 0,
						signal: null as string | null,
						timedOut: false,
					}),
					(
						error: NodeJS.ErrnoException & {
							stdout?: string;
							stderr?: string;
							code?: number | string;
							signal?: string;
							killed?: boolean;
							name?: string;
						},
					) => {
						if (error.name === "AbortError" || error.code === "ABORT_ERR") {
							const reason = context.abortSignal?.reason;
							if (isTurnInterruptedError(reason)) {
								throw reason;
							}
							throw new TurnInterruptedError("user_escape", "tool");
						}

						return {
							ok: false as const,
							stdout: error.stdout ?? "",
							stderr: error.stderr ?? error.message,
							exitCode: typeof error.code === "number" ? error.code : null,
							signal: error.signal ?? null,
							timedOut: error.killed === true && error.signal === "SIGTERM",
						};
					},
				)
				.finally(() => {
					void rm(cwdCaptureFile, { force: true });
					if (invocation.scriptPath) {
						void rm(invocation.scriptPath, { force: true });
					}
				});

			// Capture the resulting working directory from the throwaway file.
			let newCwd = workingDir.current;
			try {
				const captured = (await readFile(cwdCaptureFile, "utf8")).trim();
				if (captured) {
					newCwd = captured;
				}
			} catch {
				// If we couldn't read it, keep the current directory.
			}

			// Apply carry-over / reset semantics.
			let cwdReset = false;
			if (workingDir.maintainProjectWorkingDir) {
				workingDir.current = workingDir.projectDir;
			} else {
				const relative = path.relative(workingDir.projectDir, newCwd);
				const inside =
					relative === "" ||
					(!relative.startsWith("..") && !path.isAbsolute(relative));
				if (inside) {
					workingDir.current = newCwd;
				} else {
					workingDir.current = workingDir.projectDir;
					cwdReset = true;
				}
			}

			// Record recognized single-file reads so the edit tool's
			// read-before-edit check passes (resolved against the command's cwd).
			if (result.ok) {
				const readFile0 = detectSingleFileRead(command);
				if (readFile0) {
					await tracker.recordRead(newCwd, readFile0);
				}
			}

			// Overflow to a session file when output exceeds the limit.
			const totalLen = result.stdout.length + result.stderr.length;
			let overflowPath: string | undefined;
			let preview: string | undefined;
			if (totalLen > limit) {
				await mkdir(outputDir, { recursive: true });
				overflowPath = path.join(outputDir, `${randomUUID()}.txt`);
				const fileContent = [
					`Command: ${command}`,
					`Cwd: ${newCwd}`,
					`Exit code: ${result.exitCode ?? "(none)"}`,
					formatRawBlock("STDOUT", result.stdout || "(empty)", {
						omitLabel: true,
					}),
					formatRawBlock("STDERR", result.stderr || "(empty)", {
						omitLabel: true,
					}),
				].join("\n");
				await writeFile(overflowPath, fileContent, "utf8");
				preview = fileContent.slice(0, OVERFLOW_PREVIEW_CHARS);
			}

			const renderedStdout = overflowPath
				? (preview ?? "")
				: truncateHeadTail(result.stdout, limit);
			const renderedStderr = overflowPath
				? ""
				: truncateHeadTail(result.stderr, limit);
			const dataStdout = overflowPath
				? (preview ?? "")
				: truncateHeadTail(result.stdout, DATA_TRUNCATION_CAP);
			const dataStderr = overflowPath
				? ""
				: truncateHeadTail(result.stderr, DATA_TRUNCATION_CAP);

			return withRendered(
				{
					command,
					description: description ?? null,
					mode,
					shell: shellRuntime.shell,
					platform: shellRuntime.platform,
					ok: result.ok,
					exitCode: result.exitCode,
					signal: result.signal,
					timedOut: result.timedOut,
					cwd: workingDir.current,
					cwdReset,
					overflowPath: overflowPath ?? null,
					stdout: dataStdout,
					stderr: dataStderr,
					stdoutTruncated: overflowPath
						? true
						: result.stdout.length > DATA_TRUNCATION_CAP,
					stderrTruncated: overflowPath
						? true
						: result.stderr.length > DATA_TRUNCATION_CAP,
				},
				renderBashResult({
					command,
					description,
					mode,
					shell: shellRuntime.shell,
					platform: shellRuntime.platform,
					ok: result.ok,
					exitCode: result.exitCode,
					signal: result.signal,
					timedOut: result.timedOut,
					cwd: workingDir.current,
					cwdReset,
					overflowPath,
					stdout: renderedStdout,
					stderr: renderedStderr,
				}),
			);
		},
		describeProgress(args) {
			const command = getString(args.command) ?? "";
			return { summary: `shell ${truncate(compactWhitespace(command), 300)}` };
		},
		recordLedger(recorder, toolCall, result) {
			const command = getString(toolCall.arguments.command) ?? "";
			const data = (result.data ?? null) as Record<string, unknown> | null;
			recorder.shellFinding(
				command,
				getBoolean(data?.ok),
				getNumber(data?.exitCode),
			);
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
		parts.push(sourceCommand(shellRuntime, envFile));
	}
	if (rcDefinitionsFile) {
		parts.push(sourceCommand(shellRuntime, rcDefinitionsFile));
	}
	return parts.join("\n");
}

function sourceCommand(shellRuntime: ShellRuntime, file: string): string {
	if (shellRuntime.shell === "powershell" || shellRuntime.shell === "pwsh") {
		return `. '${file}'`;
	}
	return `source '${file}'`;
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

function renderBashResult(result: {
	command: string;
	description?: string;
	mode: RunShellMode;
	shell: string;
	platform: NodeJS.Platform;
	ok: boolean;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	cwd: string;
	cwdReset: boolean;
	overflowPath?: string;
	stdout: string;
	stderr: string;
}): string {
	const sections = [
		`Command: ${result.command}`,
		result.description ? `Description: ${result.description}` : null,
		`Mode: ${result.mode}`,
		`Shell: ${result.shell} on ${result.platform}`,
		`Cwd: ${result.cwd}`,
		result.cwdReset
			? "Note: Shell cwd was reset to the project directory because the command left the allowed directory."
			: null,
		`Command succeeded: ${result.ok ? "yes" : "no"}`,
		`Exit code: ${result.exitCode ?? "(none)"}`,
		`Signal: ${result.signal ?? "(none)"}`,
		`Timed out: ${result.timedOut ? "yes" : "no"}`,
		result.overflowPath
			? `Full output written to: ${result.overflowPath}`
			: null,
		result.stdout
			? formatRawBlock(
					result.overflowPath ? "STDOUT (preview)" : "STDOUT",
					result.stdout,
				)
			: "STDOUT: (empty)",
		result.stderr
			? formatRawBlock(
					result.overflowPath ? "STDERR (preview)" : "STDERR",
					result.stderr,
				)
			: "STDERR: (empty)",
	];

	return joinRenderedSections(sections);
}

/**
 * If `command` is a recognized single-file read understood by Claude Code's
 * read-before-edit rule (cat/head/tail/sed -n 'X,Yp'/grep/egrep/fgrep on a
 * single file, with no pipe or redirect), return that file path. Otherwise
 * return null. Conservative: when in doubt, return null (no read recorded).
 */
export function detectSingleFileRead(command: string): string | null {
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
	createShellRuntime(
		process.platform === "win32" ? "powershell" : "zsh",
		process.platform,
	),
	{ mode: "workspace_write" },
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

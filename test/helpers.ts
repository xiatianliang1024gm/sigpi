import { execSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultSessionsRoot } from "../src/config.js";
import { resolveSessionStoragePaths } from "../src/session/paths.js";
import { DiskSessionStore } from "../src/session/store.js";
import type {
	ExecutedToolCall,
	ModelProvider,
	ModelRequest,
	ModelResponse,
	RuntimeLogger,
} from "../src/types.js";

export class MockProvider implements ModelProvider {
	public readonly requests: ModelRequest[] = [];
	public readonly maxTokens: number | undefined;

	constructor(
		private readonly responder: (
			request: ModelRequest,
			index: number,
		) => Promise<ModelResponse> | ModelResponse,
		options?: { maxTokens?: number },
	) {
		this.maxTokens = options?.maxTokens;
	}

	async generate(request: ModelRequest): Promise<ModelResponse> {
		this.requests.push(request);
		return this.responder(request, this.requests.length - 1);
	}
}

export class MemoryLogger implements RuntimeLogger {
	public readonly entries: Array<{
		level: string;
		event: string;
		fields?: Record<string, unknown>;
	}> = [];

	debug(event: string, fields?: Record<string, unknown>): void {
		this.entries.push({ level: "debug", event, fields });
	}

	info(event: string, fields?: Record<string, unknown>): void {
		this.entries.push({ level: "info", event, fields });
	}

	warn(event: string, fields?: Record<string, unknown>): void {
		this.entries.push({ level: "warn", event, fields });
	}

	error(event: string, fields?: Record<string, unknown>): void {
		this.entries.push({ level: "error", event, fields });
	}
}

const tempPathsToCleanup = new Set<string>();
let tempCleanupRegistered = false;

/**
 * Run a `git` command in `cwd` for tests, without inheriting a `GIT_DIR` /
 * `GIT_WORK_TREE` from the environment. When tests run inside a git hook
 * the parent process exports an absolute `GIT_DIR`, which would otherwise
 * make every nested `git` call resolve to the outer repository instead of
 * `cwd`.
 */
export function gitIn(cwd: string, command: string): string {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	return execSync(`git ${command}`, {
		cwd,
		env,
		encoding: "utf8",
	}).toString();
}

/**
 * Return a copy of each message with the `id` field stripped. Tests use this
 * to assert on message shape without caring about the randomly-generated
 * stable id that the session store now mints for every persisted message.
 */
export function stripMessageIds<T extends { id?: string }>(
	messages: readonly T[],
): Array<Omit<T, "id">> {
	return messages.map((message) => {
		const { id: _ignored, ...rest } = message;
		return rest;
	});
}

/**
 * Strip ANSI escape sequences from a string. Pi-tui does not export an
 * equivalent, so tests that assert on rendered (ANSI-free) output use this.
 */
const ANSI_RE = /\x1B\[[0-9;]*m|\x1B\][^\x07]*\x07|\x1B[()][AB0-2]/g;

export function stripAnsi(value: string): string {
	return value.replaceAll(ANSI_RE, "");
}

export async function createTempDir(prefix: string): Promise<string> {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
	registerTempPathForCleanup(tempDir);
	return tempDir;
}

export function createTestSessionStore(args: {
	cwd: string;
	homeDir?: string;
}): DiskSessionStore {
	return new DiskSessionStore({
		storagePaths: resolveSessionStoragePaths({
			cwd: args.cwd,
			sessionsRoot: getDefaultSessionsRoot(args.homeDir),
		}),
	});
}

export async function writeWorkspaceFile(
	cwd: string,
	relativePath: string,
	content: string,
): Promise<string> {
	const fullPath = path.join(cwd, relativePath);
	await mkdir(path.dirname(fullPath), { recursive: true });
	await writeFile(fullPath, content, "utf8");
	return fullPath;
}

export async function writeTestConfig(
	homeDir: string,
	overrides?: {
		modelBaseURL?: string;
		modelApiKey?: string;
		modelName?: string;
		hardContextLimit?: number;
		reserveTokens?: number;
	},
): Promise<string> {
	const configDir = path.join(homeDir, ".sigpi");
	const configPath = path.join(configDir, "config.toml");

	await mkdir(configDir, { recursive: true });
	await writeFile(
		configPath,
		[
			"[model]",
			'active = "test"',
			"",
			"[models.test]",
			`base_url = "${overrides?.modelBaseURL ?? "https://example.test/v1"}"`,
			`api_key = "${overrides?.modelApiKey ?? "test-key"}"`,
			`name = "${overrides?.modelName ?? "test-model"}"`,
			"timeout_ms = 2000",
			"max_retries = 0",
			"retry_base_delay_ms = 10",
			`hard_context_limit = ${overrides?.hardContextLimit ?? 200_000}`,
			`reserve_tokens = ${overrides?.reserveTokens ?? 16_384}`,
		].join("\n"),
		"utf8",
	);

	return configPath;
}

export function createTestToolExecution(
	overrides?: Partial<ExecutedToolCall>,
): ExecutedToolCall {
	return {
		toolCall: {
			id: "call_1",
			name: "glob",
			arguments: { pattern: "*.ts" },
			rawArguments: '{"pattern":"*.ts"}',
			...overrides?.toolCall,
		},
		result: {
			ok: true,
			data: { files: ["src/index.ts"], returned: 1 },
			...overrides?.result,
		},
	};
}

export async function runCliCommand(args: {
	cwd: string;
	commandArgs: string[];
	input?: string;
	env?: NodeJS.ProcessEnv;
	cliPath?: string;
	timeoutMs?: number;
	nodeArgs?: string[];
}): Promise<{
	code: number | null;
	stdout: string;
	stderr: string;
}> {
	const captureDir = await mkdtemp(
		path.join(os.tmpdir(), "sigpi-cli-capture-"),
	);
	const stdoutPath = path.join(captureDir, "stdout.log");
	const stderrPath = path.join(captureDir, "stderr.log");
	const stdinPath = path.join(captureDir, "stdin.txt");

	if (args.input !== undefined) {
		await writeFile(stdinPath, args.input, "utf8");
	}

	return new Promise((resolve, reject) => {
		const stdinRedirect =
			args.input !== undefined ? ` < ${shellEscape(stdinPath)}` : "";
		const child = spawn(
			"sh",
			[
				"-lc",
				`${buildCliShellCommand({
					nodePath: process.execPath,
					nodeArgs: args.nodeArgs ?? [],
					cliPath:
						args.cliPath ??
						fileURLToPath(new URL("../src/cli.js", import.meta.url)),
					commandArgs: args.commandArgs,
				})}${stdinRedirect} > ${shellEscape(stdoutPath)} 2> ${shellEscape(stderrPath)}`,
			],
			{
				cwd: args.cwd,
				env: {
					// Inherit the ambient environment, but neutralize any proxy so the
					// fake OpenAI handler is used and no request escapes to the real
					// network: clear ambient HTTP(S)_PROXY and force the active model's
					// proxy to empty via MODEL_PROXY. Callers that need a hermetic run
					// (no dependence on the host's ~/.sigpi config) pass their own HOME
					// via args.env, which overrides the inherited one below.
					...process.env,
					HTTP_PROXY: "",
					HTTPS_PROXY: "",
					http_proxy: "",
					https_proxy: "",
					MODEL_PROXY: "",
					...(args.env ?? {}),
				},
				stdio: "ignore",
			},
		);

		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			void rm(captureDir, { recursive: true, force: true });
			reject(
				new Error(
					`CLI command timed out after ${args.timeoutMs ?? 15_000}ms: ${args.commandArgs.join(" ")}`,
				),
			);
		}, args.timeoutMs ?? 15_000);
		child.on("error", (error) => {
			clearTimeout(timeout);
			void rm(captureDir, { recursive: true, force: true });
			reject(error);
		});
		child.on("close", async (code) => {
			clearTimeout(timeout);
			const stdout = await readCaptureFile(stdoutPath);
			const stderr = await readCaptureFile(stderrPath);
			await rm(captureDir, { recursive: true, force: true });
			resolve({
				code,
				stdout,
				stderr,
			});
		});
	});
}

function registerTempPathForCleanup(targetPath: string): void {
	tempPathsToCleanup.add(targetPath);
	if (tempCleanupRegistered) {
		return;
	}

	tempCleanupRegistered = true;
	process.once("exit", () => {
		for (const tempPath of tempPathsToCleanup) {
			rmSync(tempPath, { recursive: true, force: true });
		}
		tempPathsToCleanup.clear();
	});
}

function buildCliShellCommand(args: {
	nodePath: string;
	nodeArgs: string[];
	cliPath: string;
	commandArgs: string[];
}): string {
	return [
		shellEscape(args.nodePath),
		...args.nodeArgs.map(shellEscape),
		shellEscape(args.cliPath),
		...args.commandArgs.map(shellEscape),
	].join(" ");
}

function shellEscape(value: string): string {
	if (value.length === 0) {
		return "''";
	}

	return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

async function readCaptureFile(filePath: string): Promise<string> {
	try {
		return await readFile(filePath, "utf8");
	} catch {
		return "";
	}
}

/**
 * Poll `predicate` until it returns true or `timeoutMs` elapses.
 * Used by background-task and async shell tests that need to await process state.
 */
export async function waitFor(
	predicate: () => boolean,
	timeoutMs: number,
	intervalMs = 25,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`waitFor timed out after ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

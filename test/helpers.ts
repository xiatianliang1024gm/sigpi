import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
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

export interface FakeOpenAIRequest {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: unknown;
}

export interface FakeOpenAIResponse {
	status?: number;
	headers?: Record<string, string>;
	body?: unknown;
	rawBody?: string;
}

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
	cwd: string,
	overrides?: {
		modelBaseURL?: string;
		modelApiKey?: string;
		modelName?: string;
		contextWindow?: number;
		reserveTokens?: number;
	},
): Promise<string> {
	const configDir = path.join(cwd, ".sigpi");
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
			"",
			"[agent]",
			`context_window = ${overrides?.contextWindow ?? 200_000}`,
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

export async function startFakeOpenAIServer(
	handler: (
		request: FakeOpenAIRequest,
		index: number,
	) => FakeOpenAIResponse | Promise<FakeOpenAIResponse>,
): Promise<{
	baseUrl: string;
	requests: FakeOpenAIRequest[];
	close: () => Promise<void>;
}> {
	const requests: FakeOpenAIRequest[] = [];
	const sockets = new Set<Socket>();
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		const rawBody = Buffer.concat(chunks).toString("utf8");
		const body = rawBody ? JSON.parse(rawBody) : {};
		const requestRecord: FakeOpenAIRequest = {
			method: req.method ?? "GET",
			url: req.url ?? "/",
			headers: req.headers,
			body,
		};
		requests.push(requestRecord);
		const response = await handler(requestRecord, requests.length - 1);
		res.statusCode = response.status ?? 200;
		for (const [key, value] of Object.entries(response.headers ?? {})) {
			res.setHeader(key, value);
		}
		if (response.rawBody !== undefined) {
			res.end(response.rawBody);
			return;
		}
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(response.body ?? {}));
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => {
			sockets.delete(socket);
		});
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	assert(address && typeof address === "object");

	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		close: async () => {
			for (const socket of sockets) {
				socket.destroy();
			}
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
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
					// Keep the host HOME so the child still loads the developer's
					// skills catalog (skill count affects compaction output). But
					// neutralize any proxy so the fake OpenAI handler is used and no
					// request escapes to the real network: clear ambient HTTP(S)_PROXY
					// and force the active model's proxy to empty via MODEL_PROXY.
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

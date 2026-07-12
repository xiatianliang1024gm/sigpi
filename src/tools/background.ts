import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";

export type BackgroundTaskStatus = "running" | "done";

export interface BackgroundTask {
	id: string;
	pid: number | null;
	command: string;
	cwd: string;
	description: string | null;
	startedAt: number;
	status: BackgroundTaskStatus;
	logPath: string;
	exitCode: number | null;
	signal: string | null;
	killed: boolean;
}

export interface SpawnBackgroundOptions {
	id: string;
	command: string;
	/** Resolved shell invocation (executable + args) produced by `buildShellInvocation`. */
	invocation: { executable: string; args: string[] };
	cwd: string;
	logPath: string;
	/** Temp script file the invocation sources; removed once the process exits. */
	scriptPath?: string;
	description: string | null;
	env?: NodeJS.ProcessEnv;
}

/**
 * Tracks background shell tasks spawned by the `bash` tool. Task state is
 * in-memory for the lifetime of the runtime process: a resumed or restarted
 * session does not recover tasks from a previous process. Logs stream to a
 * per-task file under the session's bash-outputs directory.
 */
export class BackgroundTaskManager {
	private readonly tasks = new Map<string, BackgroundTask>();

	spawn(options: SpawnBackgroundOptions): BackgroundTask {
		const task: BackgroundTask = {
			id: options.id,
			pid: null,
			command: options.command,
			cwd: options.cwd,
			description: options.description,
			startedAt: Date.now(),
			status: "running",
			logPath: options.logPath,
			exitCode: null,
			signal: null,
			killed: false,
		};
		this.tasks.set(task.id, task);

		// Create the log file synchronously so it exists immediately for the
		// model to read (and for `existsSync` right after spawn to observe it).
		writeFileSync(
			options.logPath,
			`Command: ${options.command}\n` +
				`Cwd: ${options.cwd}\n` +
				`Started: ${new Date(task.startedAt).toISOString()}\n\n`,
		);
		const log = createWriteStream(options.logPath, { flags: "a" });

		let proc: ChildProcess;
		try {
			proc = spawn(options.invocation.executable, options.invocation.args, {
				cwd: options.cwd,
				env: options.env ?? process.env,
				// Detach so the task survives the parent and forms its own process
				// group that we can signal as a whole on POSIX.
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			task.status = "done";
			task.exitCode = null;
			log.write(
				`\n[spawn error] ${error instanceof Error ? error.message : String(error)}\n`,
			);
			log.end();
			return task;
		}

		task.pid = proc.pid ?? null;
		proc.stdout?.on("data", (chunk: Buffer) => log.write(chunk));
		proc.stderr?.on("data", (chunk: Buffer) => log.write(chunk));

		proc.on("error", (error: Error) => {
			log.write(`\n[spawn error] ${error.message}\n`);
			if (task.status === "running") {
				task.status = "done";
				task.exitCode = null;
				log.end();
			}
		});

		proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
			task.status = "done";
			task.exitCode = code;
			task.signal = signal;
			log.write(
				`\n\nExit code: ${code ?? "unknown"}${signal ? ` (signal ${signal})` : ""}\n` +
					`Finished: ${new Date().toISOString()}\n`,
			);
			log.end();
			if (options.scriptPath) {
				void rm(options.scriptPath, { force: true });
			}
		});

		// Don't keep the event loop alive for background tasks.
		proc.unref();
		return task;
	}

	get(id: string): BackgroundTask | undefined {
		return this.tasks.get(id);
	}

	list(): readonly BackgroundTask[] {
		return [...this.tasks.values()].sort((a, b) => a.startedAt - b.startedAt);
	}

	stop(id: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
		const task = this.tasks.get(id);
		if (!task || task.pid == null || task.status === "done") {
			return false;
		}
		const target = process.platform !== "win32" ? -task.pid : task.pid;
		try {
			process.kill(target, signal);
			task.killed = true;
			return true;
		} catch {
			return false;
		}
	}
}

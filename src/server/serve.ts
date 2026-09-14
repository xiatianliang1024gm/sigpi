import { SessionManager } from "./manager.js";
import { createMultiSessionServer } from "./multi.js";
import { loadProjectRegistry, saveProjectRegistry } from "./project-store.js";

export interface ServeOptions {
	/** Bind host. Defaults to loopback so the agent is not exposed by accident. */
	host: string;
	/** Bind port. `0` picks a free port; defaults to 7878. */
	port: number;
	/** Idle TTL in ms; sessions retired after this long with no activity. */
	idleTtlMs?: number;
	/** Max concurrent live sessions. */
	maxSessions?: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * How long a graceful shutdown may run before the process is force-killed.
 * Short enough to feel responsive, long enough for a normal teardown (closing
 * the listener, dropping sockets, disposing every live session) to finish.
 */
const SHUTDOWN_GRACE_MS = 5_000;

/** Parse `sigpi serve` flags. Pure, so it is unit-testable without a socket. */
export function parseServeArgs(args: string[]): ServeOptions {
	const options: ServeOptions = { host: "127.0.0.1", port: 7878 };

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--host") {
			options.host = args[index + 1] ?? options.host;
			index += 1;
			continue;
		}
		if (arg === "--port") {
			options.port = parseInteger(args[index + 1], "--port", 0, 65_535);
			index += 1;
			continue;
		}
		if (arg === "--idle-ttl") {
			options.idleTtlMs = parseInteger(
				args[index + 1],
				"--idle-ttl",
				0,
				Number.MAX_SAFE_INTEGER,
			);
			index += 1;
			continue;
		}
		if (arg === "--max-sessions") {
			options.maxSessions = parseInteger(
				args[index + 1],
				"--max-sessions",
				0,
				Number.MAX_SAFE_INTEGER,
			);
			index += 1;
			continue;
		}
		throw new Error(`Unknown serve option: ${arg}`);
	}

	return options;
}

function parseInteger(
	raw: string | undefined,
	flag: string,
	min: number,
	max: number,
): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${flag} expects an integer in [${min}, ${max}].`);
	}
	return value;
}

/**
 * Resolve once the process receives its first Ctrl+C (SIGINT) or SIGTERM.
 * Thereafter a second signal exits immediately, so an operator staring at a
 * shutdown that appears wedged (e.g. a client holding a keep-alive stream open)
 * always has an escape hatch short of killing the terminal.
 */
function waitForShutdownSignal(): Promise<void> {
	return new Promise((resolve) => {
		const onSignal = (): void => {
			process.removeListener("SIGINT", onSignal);
			process.removeListener("SIGTERM", onSignal);
			// Any further signal during (or after) teardown: leave now.
			process.once("SIGINT", () => process.exit(130));
			process.once("SIGTERM", () => process.exit(130));
			resolve();
		};
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
	});
}

/**
 * Start the multi-session HTTP/SSE frontend and block until Ctrl+C / SIGTERM,
 * then retire every session and close the server. Session state lives in the
 * `~/.sigpi/projects/<projectKey>` archive and the set of added directories in
 * `~/.sigpi/projects.json`, so a restart resumes cleanly with the same folders.
 */
export async function runServeCommand(args: string[]): Promise<void> {
	const options = parseServeArgs(args);
	const manager = new SessionManager({
		idleTtlMs: options.idleTtlMs,
		maxSessions: options.maxSessions,
		loadProjectRegistry,
		saveProjectRegistry: (projects) => saveProjectRegistry(projects),
	});
	// Bring back the directories added in earlier runs before serving requests.
	await manager.restoreProjects();
	const server = createMultiSessionServer({ manager });

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => resolve());
	});

	const address = server.address();
	const port =
		typeof address === "object" && address ? address.port : options.port;
	console.log(`sigpi web server listening on http://${options.host}:${port}`);
	if (!LOOPBACK_HOSTS.has(options.host)) {
		console.warn(
			"Warning: bound to a non-loopback address with no authentication. " +
				"The agent can run shell commands and write files — only expose this to trusted clients.",
		);
	}

	const sweep =
		options.idleTtlMs && options.idleTtlMs > 0
			? setInterval(
					() => {
						void manager.sweepIdle();
					},
					Math.max(1_000, options.idleTtlMs),
				)
			: null;
	sweep?.unref?.();

	await waitForShutdownSignal();

	// Teardown is now underway. Arm a hard deadline so a wedged shutdown — an
	// in-flight turn, a child process that ignores its kill signal, a socket
	// that never closes — can never leave the process stuck with no way out.
	const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
	forceExit.unref();

	if (sweep) {
		clearInterval(sweep);
	}

	// Stop accepting new connections *before* dropping the live sessions. A
	// browser tab's `EventSource` auto-reconnects within about a second of its
	// stream dropping, so if we only killed the open sockets first it would
	// dial back in during the (async) dispose window and `server.close()` would
	// then wait forever on the fresh keep-alive stream. Closing the listener
	// first, then dropping every remaining socket (idle keep-alives and open
	// SSE streams alike), lets `close()` settle promptly.
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections?.();
	});

	await manager.disposeAll();

	clearTimeout(forceExit);
	// The server and every session are down, but a lingering handle (a stray
	// socket, a child-process pipe, an un-awaited fetch) could still keep the
	// event loop alive; end the process explicitly now that teardown is done.
	process.exit(0);
}

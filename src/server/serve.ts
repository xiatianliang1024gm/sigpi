import { SessionManager } from "./manager.js";
import { createMultiSessionServer } from "./multi.js";

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
 * Start the multi-session HTTP/SSE frontend and block until Ctrl+C / SIGTERM,
 * then retire every session and close the server. Session state lives in the
 * `~/.sigpi/projects/<projectKey>` archive, so a restart resumes cleanly.
 */
export async function runServeCommand(args: string[]): Promise<void> {
	const options = parseServeArgs(args);
	const manager = new SessionManager({
		idleTtlMs: options.idleTtlMs,
		maxSessions: options.maxSessions,
	});
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

	await new Promise<void>((resolve) => {
		process.once("SIGINT", resolve);
		process.once("SIGTERM", resolve);
	});

	if (sweep) {
		clearInterval(sweep);
	}
	server.closeAllConnections?.();
	await manager.disposeAll();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type {
	InterruptAck,
	SessionTurnOutcome,
} from "../session/controller.js";
import type { TurnProgressEvent } from "../types.js";
import { encodeSseComment, encodeSseEvent } from "./sse.js";

/**
 * The headless session surface the HTTP server drives. `SessionController`
 * satisfies this structurally, so the server can be tested with a lightweight
 * fake and never touches the terminal stack.
 */
export interface ChatSessionSource {
	onProgress(listener: (event: TurnProgressEvent) => void): () => void;
	submit(input: string): Promise<SessionTurnOutcome>;
	requestInterrupt(): InterruptAck;
	isTurnActive(): boolean;
}

export interface ChatServerOptions {
	session: ChatSessionSource;
	/** Max `POST /message` body size in bytes. Defaults to 1 MiB. */
	maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * A minimal HTTP/SSE frontend for one {@link SessionController}: the proof
 * that the agent loop is frontend-agnostic. `POST /message` submits a turn,
 * `POST /interrupt` stops it, and `GET /events` streams every turn-progress
 * event as an SSE `message` frame whose JSON body carries the same `type`
 * discriminator the TUI reducer switches on. A browser client can therefore
 * mirror `applyTurnProgress` almost verbatim.
 *
 * Multi-session hosting is out of scope here; a real deployment would key one
 * controller per session and route by path or query param.
 */
export function createChatServer(options: ChatServerOptions): Server {
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	const server = createServer((req, res) => {
		handleRequest(req, res, options.session, maxBodyBytes).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			if (!res.headersSent) {
				writeJson(res, 500, { error: message });
				return;
			}
			res.end();
		});
	});
	return server;
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	session: ChatSessionSource,
	maxBodyBytes: number,
): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");

	if (req.method === "GET" && url.pathname === "/events") {
		handleSessionEvents(req, res, session);
		return;
	}

	if (req.method === "POST" && url.pathname === "/message") {
		await handleSessionMessage(req, res, session, maxBodyBytes);
		return;
	}

	if (req.method === "POST" && url.pathname === "/interrupt") {
		writeJson(res, 200, session.requestInterrupt());
		return;
	}

	writeJson(res, 404, { error: "not_found" });
}

/**
 * Stream one session's progress as SSE until the client disconnects. Reusable
 * by any server that can resolve a {@link ChatSessionSource} for a route.
 */
export function handleSessionEvents(
	req: IncomingMessage,
	res: ServerResponse,
	session: ChatSessionSource,
): void {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	res.write(encodeSseComment("connected"));
	res.write(
		encodeSseEvent("message", {
			type: "ready",
			turnActive: session.isTurnActive(),
		}),
	);

	let closed = false;
	const unsubscribe = session.onProgress((event) => {
		if (closed) {
			return;
		}
		res.write(encodeSseEvent("message", event));
	});

	req.on("close", () => {
		closed = true;
		unsubscribe();
		res.end();
	});
}

/**
 * Submit one turn to a session. Responds `202` and lets the turn's progress
 * flow over the SSE stream; `409` when a turn is already in flight. Reusable
 * by any server that can resolve a {@link ChatSessionSource} for a route.
 */
export async function handleSessionMessage(
	req: IncomingMessage,
	res: ServerResponse,
	session: ChatSessionSource,
	maxBodyBytes: number,
): Promise<void> {
	if (session.isTurnActive()) {
		writeJson(res, 409, { error: "turn_in_flight" });
		return;
	}

	const body = await readBody(req, maxBodyBytes);
	let input = "";
	try {
		const parsed = JSON.parse(body || "{}") as { input?: unknown };
		input = typeof parsed.input === "string" ? parsed.input : "";
	} catch {
		writeJson(res, 400, { error: "invalid_json" });
		return;
	}

	if (!input.trim()) {
		writeJson(res, 400, { error: "empty_input" });
		return;
	}

	// Fire-and-forget: the turn's progress streams over `GET /events`, and its
	// terminal outcome is folded into the same event stream.
	void session.submit(input).catch(() => {
		// Errors surface on the event stream (turn_failed); swallow here so a
		// rejected submit never crashes the server.
	});
	writeJson(res, 202, { accepted: true });
}

/** Read a request body up to `maxBytes`, rejecting when it overruns. */
export function readBody(
	req: IncomingMessage,
	maxBytes: number,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBytes) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** Write a JSON response with the given status. */
export function writeJson(
	res: ServerResponse,
	status: number,
	body: unknown,
): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

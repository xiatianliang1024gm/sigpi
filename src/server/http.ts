import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	InterruptAck,
	SessionTurnOutcome,
} from "../session/controller.js";
import type { TurnProgressEvent } from "../types.js";
import type { LoggedEvent, SessionEventLog } from "./event-log.js";
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

/**
 * The event-stream surface `GET .../events` streams. The session's
 * {@link SessionEventLog} carries the retained (replayable) events; the live
 * flag lets the initial `ready` frame — and the fresh-connect replay decision —
 * reflect whether a turn is in flight.
 */
export interface SessionEventStream {
	events: SessionEventLog;
	isTurnActive(): boolean;
}

/**
 * Stream one session's progress as SSE until the client disconnects.
 *
 * Every frame carries the log's sequence number as its SSE `id:`. On (re)connect
 * the stream is caught up before going live:
 *
 * - A cursor — the browser's `Last-Event-ID` header (set automatically when an
 *   `EventSource` reconnects) or an explicit `?after=<seq>` — replays only the
 *   frames newer than that cursor, so nothing emitted during the gap is lost.
 * - Without a cursor (a fresh view, e.g. after the user switched to another
 *   session and back) the in-flight turn is replayed from its start, so the
 *   client can rebuild a turn whose earlier frames it never saw, while earlier
 *   completed turns remain the job of persisted history.
 */
export function handleSessionEvents(
	req: IncomingMessage,
	res: ServerResponse,
	session: SessionEventStream,
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
	const write = (entry: LoggedEvent): void => {
		if (closed) {
			return;
		}
		res.write(encodeSseEvent("message", entry.event, entry.seq));
	};

	// Catch the client up *before* subscribing: no event can be recorded between
	// these two synchronous statements (recording happens from the runtime's own
	// async context), so nothing slips between the replay and the live stream.
	const after = requestedLastEventId(req);
	const replay =
		after === null
			? session.isTurnActive()
				? session.events.replayCurrentTurn()
				: []
			: session.events.replayAfter(after);
	for (const entry of replay) {
		write(entry);
	}

	const unsubscribe = session.events.subscribe(write);

	req.on("close", () => {
		closed = true;
		unsubscribe();
		res.end();
	});
}

/**
 * The client's resume cursor, if any: the `Last-Event-ID` header an `EventSource`
 * sends on automatic reconnect, or an explicit `?after=<seq>` query parameter
 * for a client that wants to resume a deliberately fresh connection. Returns
 * `null` when neither carries a valid non-negative integer.
 */
function requestedLastEventId(req: IncomingMessage): number | null {
	const header = req.headers["last-event-id"];
	const rawHeader = Array.isArray(header) ? header[header.length - 1] : header;
	const fromHeader = parseSeq(rawHeader);
	if (fromHeader !== null) {
		return fromHeader;
	}
	const after = new URL(req.url ?? "/", "http://localhost").searchParams.get(
		"after",
	);
	return parseSeq(after);
}

/** Coerce an optional string into a non-negative integer sequence, else `null`. */
function parseSeq(raw: string | null | undefined): number | null {
	if (raw === null || raw === undefined || raw.trim() === "") {
		return null;
	}
	const value = Number(raw);
	return Number.isInteger(value) && value >= 0 ? value : null;
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

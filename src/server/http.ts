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
 * flag lets the initial `ready` frame reflect whether a turn is in flight.
 */
export interface SessionEventStream {
	events: SessionEventLog;
	isTurnActive(): boolean;
}

/**
 * Stream one session's progress as SSE until the client disconnects.
 *
 * Every frame carries the log's sequence number as its SSE `id:`. On (re)connect
 * the still-open turn is replayed from its `turn_started` before the live stream
 * begins, so a client that switched away mid-turn — or whose connection dropped
 * — rebuilds the in-flight turn instead of losing the frames emitted while it
 * was away. A completed turn is not replayed: it is already persisted, so the
 * transcript's history supplies it without duplication.
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
	for (const entry of session.events.replayOpenTurn()) {
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

/**
 * Minimal Server-Sent Events encoding for the headless (web) frontend. Kept
 * dependency-free and pure so it is trivially testable and reusable by any
 * HTTP server built on top of a {@link SessionController}.
 *
 * The wire format is the standard `event:` / `data:` framing: a client uses
 * `EventSource` (or any SSE reader) and switches on the event name, which is
 * exactly the `TurnProgressEvent["type"]` the TUI already switches on — so the
 * browser reducer can mirror `applyTurnProgress`.
 */

/**
 * Encode one SSE frame. `data` is JSON-serialized when it is not already a
 * string; multi-line payloads are split across `data:` lines as the SSE spec
 * requires (a bare newline would otherwise terminate the event).
 *
 * When `id` is given it becomes the frame's `id:` field, so a reconnect can
 * resume from exactly where it left off. The server takes the resume cursor as
 * the *larger* of the client's explicit `?after=` and the browser-supplied
 * `Last-Event-ID` (see `handleSessionEvents`), so a stale echoed id can never
 * roll a client back into re-skipping frames it is missing.
 */
export function encodeSseEvent(
	event: string,
	data: unknown,
	id?: number | string,
): string {
	const payload = typeof data === "string" ? data : JSON.stringify(data);
	const dataLines = payload
		.split("\n")
		.map((line) => `data: ${line}`)
		.join("\n");
	const idLine = id === undefined ? "" : `id: ${id}\n`;
	return `${idLine}event: ${event}\n${dataLines}\n\n`;
}

/**
 * Encode a keep-alive comment frame. Comments (lines starting with `:`) are
 * ignored by `EventSource` but keep intermediaries from closing an idle
 * stream.
 */
export function encodeSseComment(comment: string): string {
	return `: ${comment}\n\n`;
}

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
 * When `id` is given it becomes the frame's `id:` field. `EventSource` echoes
 * the last id it saw back as the `Last-Event-ID` header on an automatic
 * reconnect, which is how the server resumes a torn stream without losing the
 * frames emitted during the gap.
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

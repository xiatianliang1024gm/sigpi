import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

/**
 * Exercises the browser client (`src/server/web/app.js`) as a real ES module
 * inside a jsdom document, with `fetch` and `EventSource` faked at the network
 * boundary. The server half is covered end-to-end by
 * `test/chat-server-multi.test.ts`; this closes the gap the handover calls out —
 * the DOM wiring in `app.js` — by driving the same wire protocol the browser
 * would see and asserting what lands in the transcript.
 *
 * Assets load from `dist/src/server/web/` (staged by `scripts/copy-assets.mjs`),
 * so dynamic `import()` returns a *fresh* module per case via a cache-busting
 * query — the module-level state in `app.js` is therefore per-harness.
 */

const htmlUrl = new URL("../src/server/web/index.html", import.meta.url);
const appUrl = new URL("../src/server/web/app.js", import.meta.url);

/** Unique per `import()` so each harness re-evaluates `app.js` from scratch. */
let importCounter = 0;

/** Drain the microtask queue so a click's async `fetch` chain settles. */
const flush = (): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, 0);
	});

interface HttpCall {
	method: string;
	path: string;
	body: unknown;
}

interface Project {
	key: string;
	cwd: string;
}

interface LiveSession {
	sessionId: string;
	turnActive: boolean;
}

interface SessionList {
	stored: Array<Record<string, unknown>>;
	live: LiveSession[];
}

/** The subset of `Response` that `app.js` actually reads. */
interface FakeResponse {
	status: number;
	ok: boolean;
	text: () => Promise<string>;
}

/** The subset of the DOM `EventSource` surface that `app.js` uses. */
interface FakeEventSource {
	readonly url: string;
	closed: boolean;
	emit: (type: string, data?: unknown) => void;
	message: (payload: unknown) => void;
}

function jsonResponse(status: number, body: unknown): FakeResponse {
	return {
		status,
		ok: status >= 200 && status < 300,
		text: () => Promise.resolve(JSON.stringify(body)),
	};
}

/** Build a fresh `EventSource` class whose instances register themselves. */
function createEventSourceClass(registry: FakeEventSource[]) {
	return class FakeEventSourceImpl {
		readonly url: string;
		closed = false;
		private readonly listeners = new Map<
			string,
			Array<(event: { data?: string }) => void>
		>();

		constructor(url: string) {
			this.url = url;
			registry.push(this);
		}

		addEventListener(
			type: string,
			listener: (event: { data?: string }) => void,
		): void {
			const list = this.listeners.get(type) ?? [];
			list.push(listener);
			this.listeners.set(type, list);
		}

		close(): void {
			this.closed = true;
		}

		emit(type: string, data?: unknown): void {
			const event = data === undefined ? {} : { data: JSON.stringify(data) };
			for (const listener of this.listeners.get(type) ?? []) {
				listener(event);
			}
		}

		message(payload: unknown): void {
			this.emit("message", payload);
		}
	};
}

class Harness {
	private readonly dom: JSDOM;

	readonly document: Document;
	readonly sources: FakeEventSource[] = [];
	readonly calls: HttpCall[] = [];
	readonly sessions = new Map<string, SessionList>();
	projects: Project[] = [];
	messageStatus = 202;
	/** Path `POST /projects/pick` hands back; `null` simulates a cancel. */
	pickPath: string | null = "/tmp/demo";
	/**
	 * Canned history pages keyed by the `before` query param (`""` when the
	 * client asks for the newest page). Each entry drives `GET .../messages`.
	 */
	historyPages = new Map<
		string,
		{ items: Array<Record<string, unknown>>; cursor: number | null }
	>();

	private constructor(dom: JSDOM) {
		this.dom = dom;
		this.document = dom.window.document;
	}

	/** Load the real page, point the DOM globals at it, and boot `app.js`. */
	static async create(): Promise<Harness> {
		const html = await readFile(htmlUrl, "utf8");
		const harness = new Harness(new JSDOM(html, { url: "http://localhost/" }));
		harness.install();
		await harness.importApp();
		return harness;
	}

	/** A cancelable submit `Event` from this document's realm. */
	submitEvent(): Event {
		const ctor = (this.dom.window as unknown as { Event: typeof Event }).Event;
		return new ctor("submit", { bubbles: true, cancelable: true });
	}

	/** A bubbling `keydown` `KeyboardEvent` from this document's realm. */
	keydownEvent(init: KeyboardEventInit): KeyboardEvent {
		const ctor = (
			this.dom.window as unknown as { KeyboardEvent: typeof KeyboardEvent }
		).KeyboardEvent;
		return new ctor("keydown", { bubbles: true, cancelable: true, ...init });
	}

	/** HTTP calls recorded for a given method + path. */
	callsTo(method: string, path: string): HttpCall[] {
		return this.calls.filter(
			(call) => call.method === method && call.path === path,
		);
	}

	private install(): void {
		globalThis.document = this.document;
		const EventSourceClass = createEventSourceClass(this.sources);
		globalThis.EventSource = EventSourceClass as unknown as typeof EventSource;
		globalThis.fetch = this.handleFetch as unknown as typeof fetch;
	}

	private async importApp(): Promise<void> {
		importCounter += 1;
		await import(`${appUrl.href}?case=${importCounter}`);
		await flush();
	}

	/** A tiny in-memory stand-in for the routes in `src/server/multi.ts`. */
	private readonly handleFetch = async (
		path: string,
		init?: { method?: string; body?: string },
	): Promise<FakeResponse> => {
		const method = init?.method ?? "GET";
		const body = init?.body
			? (JSON.parse(init.body) as Record<string, unknown>)
			: undefined;
		this.calls.push({ method, path, body });
		const pathname = path.split("?")[0] ?? path;

		if (method === "GET" && pathname === "/projects") {
			return jsonResponse(200, { projects: this.projects });
		}
		if (method === "POST" && pathname === "/projects/pick") {
			return jsonResponse(200, { path: this.pickPath });
		}
		if (method === "POST" && pathname === "/projects") {
			const project = { key: "k1", cwd: String(body?.path ?? "") };
			this.projects = [project];
			return jsonResponse(201, { key: project.key });
		}

		const sessions = /^\/projects\/([^/]+)\/sessions$/.exec(pathname);
		if (sessions) {
			const key = decodeURIComponent(sessions[1] ?? "");
			if (method === "GET") {
				return jsonResponse(
					200,
					this.sessions.get(key) ?? { stored: [], live: [] },
				);
			}
			if (method === "POST") {
				const sessionId = "s1";
				this.sessions.set(key, {
					stored: [],
					live: [{ sessionId, turnActive: false }],
				});
				return jsonResponse(201, { sessionId });
			}
		}

		if (
			method === "GET" &&
			/^\/projects\/[^/]+\/sessions\/[^/]+\/messages$/.test(pathname)
		) {
			const before = new URLSearchParams(path.split("?")[1] ?? "").get(
				"before",
			);
			const page = this.historyPages.get(before ?? "") ?? {
				items: [],
				cursor: null,
			};
			return jsonResponse(200, page);
		}
		if (
			method === "POST" &&
			/^\/projects\/[^/]+\/sessions\/[^/]+\/message$/.test(pathname)
		) {
			return jsonResponse(this.messageStatus, { accepted: true });
		}
		if (
			method === "POST" &&
			/^\/projects\/[^/]+\/sessions\/[^/]+\/interrupt$/.test(pathname)
		) {
			return jsonResponse(200, { accepted: true });
		}

		throw new Error(`unexpected request: ${method} ${pathname}`);
	};
}

/** Fetch a required element from a document, failing loudly when absent. */
function element<T extends HTMLElement>(doc: Document, id: string): T {
	const found = doc.getElementById(id);
	assert.ok(found, `expected #${id} in the document`);
	return found as unknown as T;
}

/** Add a project and open a fresh session, leaving the SSE stream connected. */
async function openSession(): Promise<Harness> {
	const harness = await Harness.create();
	element<HTMLButtonElement>(harness.document, "add-project").click();
	await flush();
	element<HTMLButtonElement>(harness.document, "new-session").click();
	await flush();
	return harness;
}

test("boots empty, then wires project → session → SSE stream", async () => {
	const harness = await Harness.create();

	assert.deepEqual(harness.calls[0], {
		method: "GET",
		path: "/projects",
		body: undefined,
	});
	assert.equal(
		element<HTMLButtonElement>(harness.document, "new-session").disabled,
		true,
	);
	assert.equal(
		harness.document.querySelectorAll("#projects .list-item").length,
		0,
	);

	element<HTMLButtonElement>(harness.document, "add-project").click();
	await flush();

	const projects = harness.document.querySelectorAll("#projects .list-item");
	assert.equal(projects.length, 1);
	assert.equal(projects[0]?.textContent, "/tmp/demo");
	assert.match(projects[0]?.className ?? "", /active/);
	assert.equal(
		element<HTMLButtonElement>(harness.document, "new-session").disabled,
		false,
	);

	element<HTMLButtonElement>(harness.document, "new-session").click();
	await flush();

	const source = harness.sources.at(-1);
	assert.ok(source, "an EventSource was opened");
	assert.equal(source.url, "/projects/k1/sessions/s1/events");
	assert.equal(source.closed, false);

	const live = harness.document.querySelectorAll("#sessions .list-item");
	assert.equal(live.length, 1);
	assert.match(live[0]?.textContent ?? "", /live/);
	assert.equal(
		element<HTMLTextAreaElement>(harness.document, "input").disabled,
		false,
	);

	// The server replays a `ready` frame; it flips the composer out of idle.
	source.message({ type: "ready", turnActive: false });
	await flush();
	assert.equal(
		element<HTMLButtonElement>(harness.document, "send").disabled,
		false,
	);
	assert.equal(
		element<HTMLButtonElement>(harness.document, "interrupt").disabled,
		true,
	);
});

test("add-project asks the server to pick a folder and registers the result", async () => {
	const harness = await Harness.create();
	harness.pickPath = "/tmp/demo";

	element<HTMLButtonElement>(harness.document, "add-project").click();
	await flush();

	assert.equal(harness.callsTo("POST", "/projects/pick").length, 1);
	const added = harness.callsTo("POST", "/projects");
	assert.equal(added.length, 1);
	assert.deepEqual(added[0]?.body, { path: "/tmp/demo" });
	assert.equal(
		harness.document.querySelector("#projects .list-item")?.textContent,
		"/tmp/demo",
	);
});

test("add-project ignores a cancelled picker", async () => {
	const harness = await Harness.create();
	harness.pickPath = null;

	element<HTMLButtonElement>(harness.document, "add-project").click();
	await flush();

	assert.equal(harness.callsTo("POST", "/projects/pick").length, 1);
	assert.equal(harness.callsTo("POST", "/projects").length, 0);
	assert.equal(
		harness.document.querySelectorAll("#projects .list-item").length,
		0,
	);
});

test("folds a streamed turn into the DOM transcript", async () => {
	const harness = await openSession();
	const source = harness.sources.at(-1);
	assert.ok(source, "an EventSource was opened");
	source.message({ type: "ready", turnActive: false });
	await flush();

	source.message({ type: "turn_started", turnId: "t", userInput: "hi" });
	await flush();
	assert.equal(
		element<HTMLButtonElement>(harness.document, "send").disabled,
		true,
	);
	assert.equal(
		element<HTMLButtonElement>(harness.document, "interrupt").disabled,
		false,
	);
	assert.equal(harness.document.body.classList.contains("busy"), true);

	source.message({ type: "model_delta", step: 1, contentDelta: "Hel" });
	source.message({ type: "model_delta", step: 1, contentDelta: "lo" });
	assert.equal(
		harness.document.querySelector("#transcript .msg.assistant .content")
			?.textContent,
		"Hello",
	);

	source.message({
		type: "tool_execution_started",
		step: 1,
		toolName: "read",
		toolCallId: "t1",
		message: "Reading a.ts",
	});
	const tool = harness.document.querySelector("#transcript .tool");
	assert.equal(tool?.textContent, "⚙ Reading a.ts");
	assert.match(tool?.className ?? "", /running/);

	source.message({
		type: "tool_execution_finished",
		step: 1,
		toolName: "read",
		toolCallId: "t1",
		ok: true,
	});
	assert.equal(tool?.textContent, "✓ Reading a.ts");
	assert.match(tool?.className ?? "", /ok/);

	const before = harness.callsTo("GET", "/projects/k1/sessions").length;
	source.message({ type: "turn_finished", step: 1 });
	await flush();
	assert.equal(
		element<HTMLButtonElement>(harness.document, "send").disabled,
		false,
	);
	assert.equal(harness.document.body.classList.contains("busy"), false);
	assert.ok(
		harness.callsTo("GET", "/projects/k1/sessions").length > before,
		"the session list is refreshed after the turn ends",
	);
});

test("sends a turn and interrupts through the composer", async () => {
	const harness = await openSession();
	const source = harness.sources.at(-1);
	assert.ok(source, "an EventSource was opened");
	source.message({ type: "ready", turnActive: false });
	await flush();

	element<HTMLTextAreaElement>(harness.document, "input").value = "hello agent";
	element<HTMLFormElement>(harness.document, "composer").dispatchEvent(
		harness.submitEvent(),
	);
	await flush();

	assert.equal(
		harness.document.querySelector("#transcript .msg.user")?.textContent,
		"hello agent",
	);
	const sent = harness.callsTo("POST", "/projects/k1/sessions/s1/message");
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]?.body, { input: "hello agent" });
	assert.equal(
		element<HTMLButtonElement>(harness.document, "send").disabled,
		true,
	);
	assert.equal(
		element<HTMLButtonElement>(harness.document, "interrupt").disabled,
		false,
	);

	element<HTMLButtonElement>(harness.document, "interrupt").click();
	await flush();
	assert.equal(
		harness.callsTo("POST", "/projects/k1/sessions/s1/interrupt").length,
		1,
	);

	// A terminal frame clears the busy state and re-enables the composer.
	source.message({ type: "turn_finished", step: 1 });
	await flush();
	assert.equal(
		element<HTMLButtonElement>(harness.document, "send").disabled,
		false,
	);
});

test("Enter sends the composer, but empty input and Shift+Enter do not", async () => {
	const harness = await openSession();
	const source = harness.sources.at(-1);
	assert.ok(source, "an EventSource was opened");
	source.message({ type: "ready", turnActive: false });
	await flush();

	const input = element<HTMLTextAreaElement>(harness.document, "input");
	const messageCalls = () =>
		harness.callsTo("POST", "/projects/k1/sessions/s1/message");

	// A blank (or whitespace-only) box must not send.
	input.value = "   ";
	input.dispatchEvent(harness.keydownEvent({ key: "Enter" }));
	await flush();
	assert.equal(messageCalls().length, 0);

	// Shift+Enter keeps the newline and does not send.
	input.value = "line one";
	input.dispatchEvent(harness.keydownEvent({ key: "Enter", shiftKey: true }));
	await flush();
	assert.equal(messageCalls().length, 0);
	assert.equal(input.value, "line one");

	// A plain Enter trims, sends, and clears the box.
	input.value = "  hello from enter  ";
	input.dispatchEvent(harness.keydownEvent({ key: "Enter" }));
	await flush();
	assert.equal(messageCalls().length, 1);
	assert.deepEqual(messageCalls()[0]?.body, { input: "hello from enter" });
	assert.equal(input.value, "");
	assert.equal(
		harness.document.querySelector("#transcript .msg.user")?.textContent,
		"hello from enter",
	);
});

test("loads a resumed session's history and pages older messages", async () => {
	const harness = await Harness.create();
	element<HTMLButtonElement>(harness.document, "add-project").click();
	await flush();

	// The newest page (cursor 4 points at older entries) is ready before the
	// session opens, so the client's first fetch picks it up.
	harness.historyPages.set("", {
		items: [
			{ kind: "user", text: "earlier question" },
			{ kind: "assistant", text: "earlier answer", reasoning: null },
		],
		cursor: 4,
	});
	element<HTMLButtonElement>(harness.document, "new-session").click();
	await flush();

	const transcript = harness.document.getElementById("transcript");
	assert.equal(transcript?.querySelectorAll(".msg.user").length, 1);
	assert.equal(
		transcript?.querySelector(".msg.user")?.textContent,
		"earlier question",
	);
	assert.equal(
		transcript?.querySelector(".msg.assistant .content")?.textContent,
		"earlier answer",
	);
	assert.equal(
		element<HTMLButtonElement>(harness.document, "load-earlier").hidden,
		false,
	);

	// The next older page arrives when the reader asks for it.
	harness.historyPages.set("4", {
		items: [{ kind: "tool", name: "read" }],
		cursor: null,
	});
	element<HTMLButtonElement>(harness.document, "load-earlier").click();
	await flush();

	const first = transcript?.firstElementChild;
	assert.equal(first?.className, "tool ok");
	assert.equal(first?.textContent, "✓ read");
	assert.equal(
		transcript?.querySelectorAll(".msg.user").length,
		1,
		"older page is prepended, not replacing the current transcript",
	);
	assert.equal(
		element<HTMLButtonElement>(harness.document, "load-earlier").hidden,
		true,
		"no older pages remain, so the control hides",
	);

	assert.equal(
		harness.callsTo(
			"GET",
			"/projects/k1/sessions/s1/messages?limit=30&before=4",
		).length,
		1,
		"the cursor is sent back as `before`",
	);
});

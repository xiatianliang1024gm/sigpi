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
	name?: string;
}

interface LiveSession {
	sessionId: string;
	turnActive: boolean;
	title?: string | null;
	lastCompletedUserInput?: string | null;
	turnCount?: number;
	archived?: boolean;
	lastActivityAt?: number;
	updatedAt?: string | null;
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
		{
			items: Array<Record<string, unknown>>;
			cursor: number | null;
			/** Persisted event seq the client resumes its stream from. */
			eventsCursor?: number;
		}
	>();
	/** When set, `GET .../messages` awaits it before responding (ordering tests). */
	historyGate: Promise<void> | null = null;
	/** The model-picker snapshot served by `GET .../model`. */
	modelState: {
		current: string;
		models: Array<{ id: string; name: string }>;
	} = {
		current: "m1",
		models: [
			{ id: "m1", name: "Model One" },
			{ id: "m2", name: "Model Two" },
		],
	};
	/** The context-window usage snapshot served by `GET .../context`. */
	contextState: {
		limit: number;
		usedTokens: number | null;
		modelName: string;
	} = { limit: 100000, usedTokens: 2500, modelName: "Model One" };
	/** The session statistics snapshot served by `GET .../stats`. */
	statsState: Record<string, unknown> = {
		turns: 2,
		steps: 108,
		inputTokens: 11200000,
		outputTokens: 62400,
		cacheReadTokens: 990000,
		cacheWriteTokens: 0,
		llmMs: 354000,
		toolMs: 314000,
		firstTokenAvgMs: 1000,
		tokensPerSecond: 255,
	};
	/** Background tasks served by `GET .../tasks` (mutated by the kill route). */
	tasks: Array<{
		id: string;
		pid: number | null;
		command: string;
		cwd: string;
		description: string | null;
		startedAt: number;
		endedAt: number | null;
		status: "running" | "done";
		exitCode: number | null;
		signal: string | null;
		killed: boolean;
		timedOut: boolean;
	}> = [];
	/** Canned output tails served by `GET .../tasks/:id`, keyed by task id. */
	taskOutput = new Map<string, { output: string; truncated: boolean }>();

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

	/** A bubbling `change` `Event` from this document's realm. */
	changeEvent(): Event {
		const ctor = (this.dom.window as unknown as { Event: typeof Event }).Event;
		return new ctor("change", { bubbles: true });
	}

	/** A bubbling `input` `Event` from this document's realm. */
	inputEvent(): Event {
		const ctor = (this.dom.window as unknown as { Event: typeof Event }).Event;
		return new ctor("input", { bubbles: true });
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
			const project = {
				key: `k${this.projects.length + 1}`,
				cwd: String(body?.path ?? ""),
			};
			// Append (rather than replace) so a test can stand up several
			// workspaces; each still gets a distinct key.
			this.projects = [...this.projects, project];
			return jsonResponse(201, { key: project.key });
		}
		if (method === "PATCH" && /^\/projects\/[^/]+$/.test(pathname)) {
			const key = decodeURIComponent(pathname.split("/")[2] ?? "");
			const project = this.projects.find((p) => p.key === key);
			if (project && typeof body?.name === "string") {
				project.name = body.name;
			}
			return jsonResponse(200, { key, name: body?.name ?? null });
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
			if (this.historyGate) await this.historyGate;
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
			method === "GET" &&
			/^\/projects\/[^/]+\/sessions\/[^/]+\/model$/.test(pathname)
		) {
			return jsonResponse(200, this.modelState);
		}
		if (
			method === "POST" &&
			/^\/projects\/[^/]+\/sessions\/[^/]+\/model$/.test(pathname)
		) {
			this.modelState = {
				...this.modelState,
				current: String(body?.modelId ?? this.modelState.current),
			};
			return jsonResponse(200, this.modelState);
		}
		if (
			method === "GET" &&
			/^\/projects\/[^/]+\/sessions\/[^/]+\/context$/.test(pathname)
		) {
			return jsonResponse(200, this.contextState);
		}
		if (
			method === "GET" &&
			/^\/projects\/[^/]+\/sessions\/[^/]+\/stats$/.test(pathname)
		) {
			return jsonResponse(200, this.statsState);
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
		if (
			method === "GET" &&
			/^\/projects\/[^/]+\/sessions\/[^/]+\/tasks$/.test(pathname)
		) {
			return jsonResponse(200, { tasks: this.tasks });
		}
		const taskKill =
			/^\/projects\/[^/]+\/sessions\/[^/]+\/tasks\/([^/]+)\/kill$/.exec(
				pathname,
			);
		if (method === "POST" && taskKill) {
			const id = decodeURIComponent(taskKill[1] ?? "");
			const task = this.tasks.find((candidate) => candidate.id === id);
			if (!task) return jsonResponse(404, { error: "task_not_found" });
			const wasRunning = task.status === "running";
			task.status = "done";
			task.killed = true;
			task.endedAt = Date.now();
			return jsonResponse(200, { killed: wasRunning });
		}
		const taskDetail =
			/^\/projects\/[^/]+\/sessions\/[^/]+\/tasks\/([^/]+)$/.exec(pathname);
		if (method === "GET" && taskDetail) {
			const id = decodeURIComponent(taskDetail[1] ?? "");
			const task = this.tasks.find((candidate) => candidate.id === id);
			if (!task) return jsonResponse(404, { error: "task_not_found" });
			const out = this.taskOutput.get(id) ?? { output: "", truncated: false };
			return jsonResponse(200, {
				task,
				output: out.output,
				truncated: out.truncated,
			});
		}

		const sessionPatch = /^\/projects\/([^/]+)\/sessions\/([^/]+)$/.exec(
			pathname,
		);
		if (method === "PATCH" && sessionPatch) {
			const key = decodeURIComponent(sessionPatch[1] ?? "");
			const id = decodeURIComponent(sessionPatch[2] ?? "");
			const list = this.sessions.get(key);
			if (list) {
				const apply = (s: LiveSession | Record<string, unknown>): void => {
					if (typeof body?.title === "string") {
						(s as { title?: string }).title = body.title as string;
					}
					if (body?.archived === true) {
						(s as { archived?: boolean }).archived = true;
					}
				};
				list.live.forEach(apply);
				list.stored.forEach(apply);
			}
			// A renamed/archived session keeps its id; the id is unused here.
			void id;
			return jsonResponse(200, { updated: true });
		}

		const sessionDelete = /^\/projects\/([^/]+)\/sessions\/([^/]+)$/.exec(
			pathname,
		);
		if (method === "DELETE" && sessionDelete) {
			const key = decodeURIComponent(sessionDelete[1] ?? "");
			const id = decodeURIComponent(sessionDelete[2] ?? "");
			const list = this.sessions.get(key);
			if (list) {
				list.live = list.live.filter((s) => s.sessionId !== id);
				list.stored = list.stored.filter((s) => s.sessionId !== id);
			}
			return jsonResponse(200, { removed: true });
		}

		const projectDelete = /^\/projects\/([^/]+)$/.exec(pathname);
		if (method === "DELETE" && projectDelete) {
			const key = decodeURIComponent(projectDelete[1] ?? "");
			this.projects = this.projects.filter((p) => p.key !== key);
			this.sessions.delete(key);
			return jsonResponse(200, { removed: true });
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

/** Open the (first) project's "⋯" menu and return the item matching `selector`. */
async function chooseProjectMenu(
	harness: Harness,
	selector: string,
): Promise<HTMLButtonElement | null> {
	const trigger = harness.document.querySelector<HTMLButtonElement>(
		".project-header .menu-button",
	);
	assert.ok(trigger, "the project header renders a menu trigger");
	trigger.click();
	await flush();
	return harness.document.querySelector<HTMLButtonElement>(selector);
}

/** Add a project and open a fresh session, leaving the SSE stream connected. */
async function openSession(): Promise<Harness> {
	const harness = await Harness.create();
	element<HTMLButtonElement>(harness.document, "add-project").click();
	await flush();
	const newSession = await chooseProjectMenu(harness, ".menu-new-session");
	assert.ok(newSession, "the project menu offers a new session");
	newSession.click();
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
		harness.document.querySelectorAll("#projects .project").length,
		0,
	);

	element<HTMLButtonElement>(harness.document, "add-project").click();
	await flush();

	const project = harness.document.querySelector("#projects .project");
	assert.ok(project, "the project node renders");
	assert.equal(
		project.querySelector(".project-name")?.textContent,
		"demo",
		"only the folder's last path segment is shown",
	);
	assert.equal(
		project.querySelector(".project-name")?.getAttribute("title"),
		"/tmp/demo",
		"the full path stays available on hover",
	);
	assert.match(project.className, /active/);

	const newSession = await chooseProjectMenu(harness, ".menu-new-session");
	assert.ok(newSession, "the project menu offers a new session");
	newSession.click();
	await flush();

	const source = harness.sources.at(-1);
	assert.ok(source, "an EventSource was opened");
	assert.equal(source.url, "/projects/k1/sessions/s1/events?after=0");
	assert.equal(source.closed, false);

	const live = harness.document.querySelectorAll("#projects .session-row");
	assert.equal(live.length, 1);
	const liveLabel = live[0]?.querySelector(".session")?.textContent;
	assert.equal(
		liveLabel,
		"新会话",
		"a fresh session shows a friendly placeholder, never its id",
	);
	assert.doesNotMatch(liveLabel ?? "", /s1/);
	assert.equal(
		element<HTMLTextAreaElement>(harness.document, "input").disabled,
		false,
	);

	// The server replays a `ready` frame; it flips the composer out of idle.
	source.message({ type: "ready", turnActive: false });
	await flush();
	const submit = element<HTMLButtonElement>(harness.document, "submit");
	assert.equal(submit.disabled, false);
	assert.equal(submit.classList.contains("is-stop"), false);
});

test("a live session shows its derived title once the server reports one", async () => {
	const harness = await openSession();
	const liveSession = harness.sessions.get("k1")?.live[0];
	assert.ok(liveSession, "the live session is registered");
	// The server derives a title from the first user input; the client should
	// surface it on the live row instead of the session id.
	liveSession.title = "Fix the flaky test";
	liveSession.lastCompletedUserInput = "Fix the flaky test";

	const source = harness.sources.at(-1);
	assert.ok(source, "an EventSource was opened");
	source.message({ type: "turn_finished", step: 1 });
	await flush();

	const row = harness.document.querySelector("#projects .session-row .session");
	assert.equal(row?.textContent, "Fix the flaky test");
	assert.doesNotMatch(row?.textContent ?? "", /s1/);
});

test("a live session falls back to the last input when it has no title", async () => {
	const harness = await openSession();
	const liveSession = harness.sessions.get("k1")?.live[0];
	assert.ok(liveSession);
	liveSession.lastCompletedUserInput = "run the tests";

	const source = harness.sources.at(-1);
	assert.ok(source);
	source.message({ type: "turn_finished", step: 1 });
	await flush();

	const row = harness.document.querySelector("#projects .session-row .session");
	assert.equal(row?.textContent, "run the tests");
});

test("renders each session row's last-update time relative to now", async () => {
	const harness = await Harness.create();
	const now = Date.now();
	const ago = (ms: number) => new Date(now - ms).toISOString();
	harness.sessions.set("k1", {
		stored: [
			{
				sessionId: "s1",
				title: "Moments ago",
				updatedAt: ago(30 * 1000),
				cwd: "/tmp/demo",
				turnCount: 1,
			},
			{
				sessionId: "s2",
				title: "Days ago",
				updatedAt: ago(2 * 24 * 60 * 60 * 1000),
				cwd: "/tmp/demo",
				turnCount: 2,
			},
			{
				sessionId: "s3",
				title: "A year ago",
				updatedAt: ago(400 * 24 * 60 * 60 * 1000),
				cwd: "/tmp/demo",
				turnCount: 3,
			},
		],
		live: [],
	});

	element<HTMLButtonElement>(harness.document, "add-project").click();
	await flush();

	const times = Array.from(
		harness.document.querySelectorAll("#projects .session-time"),
	).map((el) => el.textContent);
	assert.deepEqual(times, ["刚刚", "2天", "1年"]);

	// The time trails the label and menu, pinned to the row's right edge.
	const row = harness.document.querySelector("#projects .session-row");
	assert.equal(row?.lastElementChild?.className, "session-time");
});

test("uses a live session's last activity for its row time", async () => {
	const harness = await openSession();
	const liveSession = harness.sessions.get("k1")?.live[0];
	assert.ok(liveSession, "the live session is registered");
	liveSession.lastActivityAt = Date.now() - 3 * 60 * 60 * 1000;

	const source = harness.sources.at(-1);
	assert.ok(source, "an EventSource was opened");
	source.message({ type: "turn_finished", step: 1 });
	await flush();

	const time = harness.document.querySelector("#projects .session-time");
	assert.equal(time?.textContent, "3h");
});

test("selecting a session does not bump its row time or reorder it", async () => {
	const harness = await Harness.create();
	const now = Date.now();
	const ago = (ms: number) => new Date(now - ms).toISOString();
	const hour = 60 * 60 * 1000;
	harness.sessions.set("k1", {
		stored: [
			{
				sessionId: "older",
				title: "Older",
				updatedAt: ago(3 * hour),
				cwd: "/tmp/demo",
				turnCount: 1,
			},
			{
				sessionId: "newer",
				title: "Newer",
				updatedAt: ago(hour),
				cwd: "/tmp/demo",
				turnCount: 2,
			},
		],
		live: [
			// "older" is live because it was just selected, so it was touched now
			// (lastActivityAt) even though no message was sent. Its persisted
			// updatedAt is unchanged, so its row must keep the older time and stay
			// below "newer" instead of jumping to the top.
			{
				sessionId: "older",
				title: "Older",
				turnActive: false,
				updatedAt: ago(3 * hour),
				lastActivityAt: now,
			},
		],
	});

	element<HTMLButtonElement>(harness.document, "add-project").click();
	await flush();

	const labels = Array.from(
		harness.document.querySelectorAll("#projects .session-row .session"),
	).map((el) => el.textContent);
	assert.deepEqual(labels, ["Newer · 2 turns", "Older"]);

	const times = Array.from(
		harness.document.querySelectorAll("#projects .session-time"),
	).map((el) => el.textContent);
	assert.deepEqual(times, ["1h", "3h"]);
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
		harness.document.querySelector("#projects .project-name")?.textContent,
		"demo",
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
		harness.document.querySelectorAll("#projects .project").length,
		0,
	);
});

test("collapses and expands every workspace at once", async () => {
	const harness = await Harness.create();
	harness.pickPath = "/tmp/one";
	element<HTMLButtonElement>(harness.document, "add-project").click();
	await flush();
	harness.pickPath = "/tmp/two";
	element<HTMLButtonElement>(harness.document, "add-project").click();
	await flush();

	assert.equal(
		harness.document.querySelectorAll("#projects .project").length,
		2,
		"both workspaces render",
	);
	assert.equal(
		harness.document.querySelectorAll("#projects .sessions").length,
		2,
		"both start expanded",
	);

	element<HTMLButtonElement>(harness.document, "collapse-projects").click();
	await flush();
	assert.equal(
		harness.document.querySelectorAll("#projects .sessions").length,
		0,
		"collapse-all hides every session list",
	);
	const collapsed = Array.from(
		harness.document.querySelectorAll("#projects .project-toggle"),
	);
	assert.ok(
		collapsed.every((el) => el.getAttribute("aria-expanded") === "false"),
		"every workspace reports itself collapsed",
	);

	element<HTMLButtonElement>(harness.document, "expand-projects").click();
	await flush();
	assert.equal(
		harness.document.querySelectorAll("#projects .sessions").length,
		2,
		"expand-all restores every session list",
	);
});

test("copies and saves an assistant message as markdown", async () => {
	const harness = await openSession();
	const originalNavigator = Object.getOwnPropertyDescriptor(
		globalThis,
		"navigator",
	);
	const copied: string[] = [];
	Object.defineProperty(globalThis, "navigator", {
		value: {
			clipboard: {
				writeText: async (text: string) => {
					copied.push(text);
				},
			},
		},
		configurable: true,
	});
	const downloadNames: string[] = [];
	const originalCreateObjectUrl = URL.createObjectURL;
	URL.createObjectURL = () => "blob:test";
	URL.revokeObjectURL = () => {};
	const win = harness.document.defaultView as unknown as {
		HTMLAnchorElement: { prototype: HTMLAnchorElement };
	};
	const anchorProto = win.HTMLAnchorElement.prototype;
	const originalAnchorClick = anchorProto.click;
	anchorProto.click = function (this: HTMLElement): void {
		downloadNames.push((this as HTMLAnchorElement).download);
	};

	try {
		const source = harness.sources.at(-1);
		assert.ok(source, "an EventSource was opened");
		source.message({ type: "ready", turnActive: false });
		source.message({ type: "turn_started", turnId: "t", userInput: "hi" });
		source.message({
			type: "model_delta",
			step: 1,
			contentDelta: "# Title\n\n```js\nrun()\n```",
		});
		await flush();

		const copy = harness.document.querySelector<HTMLButtonElement>(
			".msg.assistant .copy-message",
		);
		assert.ok(copy, "the assistant message offers a copy button");
		copy.click();
		await flush();
		assert.deepEqual(copied, ["# Title\n\n```js\nrun()\n```"]);

		const save = harness.document.querySelector<HTMLButtonElement>(
			".msg.assistant .save-message",
		);
		assert.ok(save, "the assistant message offers a save button");
		save.click();
		await flush();
		assert.equal(downloadNames.length, 1, "saving triggers one download");
		assert.match(downloadNames[0] ?? "", /^sigpi-\d{8}-\d{6}\.md$/);
	} finally {
		URL.createObjectURL = originalCreateObjectUrl;
		anchorProto.click = originalAnchorClick;
		if (originalNavigator) {
			Object.defineProperty(globalThis, "navigator", originalNavigator);
		}
	}
});

test("offers copy/save only on the turn's final assistant message", async () => {
	const harness = await openSession();
	const source = harness.sources.at(-1);
	assert.ok(source, "an EventSource was opened");
	source.message({ type: "ready", turnActive: false });

	source.message({ type: "turn_started", turnId: "t", userInput: "hi" });
	// First step: the model narrates, finalizes, then calls a tool. That is an
	// intermediate step, so it must not carry the copy/save toolbar.
	source.message({
		type: "model_delta",
		step: 1,
		contentDelta: "Let me look.",
	});
	source.message({ type: "model_request_finished", step: 1 });
	source.message({
		type: "tool_execution_started",
		step: 1,
		toolName: "read",
		toolCallId: "t1",
		message: "Reading a.ts",
	});
	source.message({
		type: "tool_execution_finished",
		step: 1,
		toolName: "read",
		toolCallId: "t1",
		ok: true,
	});
	// Second step: the final answer, which keeps the toolbar.
	source.message({ type: "model_delta", step: 2, contentDelta: "Done." });
	source.message({ type: "turn_finished", step: 2 });
	await flush();

	const messages = harness.document.querySelectorAll(
		"#transcript .msg.assistant",
	);
	assert.equal(messages.length, 2, "both assistant steps render");
	assert.equal(
		messages[0]?.querySelector(".copy-message"),
		null,
		"the intermediate step offers no copy button",
	);
	assert.equal(
		messages[0]?.querySelector(".save-message"),
		null,
		"the intermediate step offers no save button",
	);
	assert.ok(
		messages[1]?.querySelector(".copy-message"),
		"the final step offers the copy button",
	);
	assert.equal(
		harness.document.querySelectorAll("#transcript .copy-message").length,
		1,
		"exactly one copy button is present for the turn",
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
	const submit = element<HTMLButtonElement>(harness.document, "submit");
	assert.equal(submit.disabled, false);
	assert.equal(submit.classList.contains("is-stop"), true);
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
	assert.equal(submit.disabled, false);
	assert.equal(submit.classList.contains("is-stop"), false);
	assert.equal(harness.document.body.classList.contains("busy"), false);
	assert.ok(
		harness.callsTo("GET", "/projects/k1/sessions").length > before,
		"the session list is refreshed after the turn ends",
	);
});

test("rebuilds the in-flight turn when a reconnect replays turn_started", async () => {
	const harness = await openSession();
	const source = harness.sources.at(-1);
	assert.ok(source, "an EventSource was opened");

	source.message({ type: "ready", turnActive: true });
	source.message({ type: "turn_started", turnId: "t", userInput: "hi" });
	source.message({ type: "model_delta", step: 1, contentDelta: "Hel" });
	source.message({ type: "model_delta", step: 1, contentDelta: "lo" });
	await flush();
	const content = () =>
		harness.document.querySelector("#transcript .msg.assistant .content")
			?.textContent;
	assert.equal(content(), "Hello");

	// The stream drops and reconnects; the server replays the whole open turn
	// from its start. The client must rebuild in place, not append a second copy.
	source.message({ type: "ready", turnActive: true });
	source.message({ type: "turn_started", turnId: "t", userInput: "hi" });
	source.message({ type: "model_delta", step: 1, contentDelta: "Hel" });
	source.message({ type: "model_delta", step: 1, contentDelta: "lo" });
	source.message({ type: "model_delta", step: 1, contentDelta: "!!" });
	await flush();

	assert.equal(
		harness.document.querySelectorAll("#transcript .msg.assistant").length,
		1,
		"the replayed turn replaces the prior partial copy instead of stacking",
	);
	assert.equal(content(), "Hello!!");
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
	const submit = element<HTMLButtonElement>(harness.document, "submit");
	assert.equal(submit.classList.contains("is-stop"), true);

	// The merged button interrupts instead of sending while a turn runs.
	submit.click();
	await flush();
	assert.equal(
		harness.callsTo("POST", "/projects/k1/sessions/s1/interrupt").length,
		1,
	);

	// A terminal frame clears the busy state and re-enables the composer.
	source.message({ type: "turn_finished", step: 1 });
	await flush();
	assert.equal(submit.classList.contains("is-stop"), false);
	assert.equal(submit.disabled, false);
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

test("keeps unsubmitted composer text per session across switches", async () => {
	const harness = await Harness.create();
	// Two live sessions in one workspace so switching never hits the resume POST.
	harness.sessions.set("k1", {
		stored: [],
		live: [
			{ sessionId: "s1", title: "One", turnActive: false },
			{ sessionId: "s2", title: "Two", turnActive: false },
		],
	});
	element<HTMLButtonElement>(harness.document, "add-project").click();
	await flush();

	const input = element<HTMLTextAreaElement>(harness.document, "input");
	const openRow = async (label: string): Promise<void> => {
		const button = Array.from(
			harness.document.querySelectorAll<HTMLButtonElement>(
				"#projects .session-row .session",
			),
		).find((el) => el.textContent === label);
		assert.ok(button, `the ${label} session row exists`);
		button.click();
		await flush();
	};

	// Draft in session one, then switch away before submitting.
	await openRow("One");
	input.value = "draft one";
	input.dispatchEvent(harness.inputEvent());
	await openRow("Two");
	assert.equal(
		input.value,
		"",
		"a fresh session starts with an empty composer, not the previous draft",
	);

	// Draft in session two, then switch back: each session keeps its own text.
	input.value = "draft two";
	input.dispatchEvent(harness.inputEvent());
	await openRow("One");
	assert.equal(input.value, "draft one", "session one restores its own draft");
	await openRow("Two");
	assert.equal(input.value, "draft two", "session two restores its own draft");

	// Submitting clears the box and the stored draft.
	await openRow("One");
	harness.document
		.getElementById("composer")
		?.dispatchEvent(harness.submitEvent());
	await flush();
	assert.equal(input.value, "");
	await openRow("Two");
	await openRow("One");
	assert.equal(
		input.value,
		"",
		"a submitted draft is not restored on the next visit",
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
		// The persisted transcript reaches event seq 7, so the event stream must
		// resume strictly after it.
		eventsCursor: 7,
	});
	const newSession = await chooseProjectMenu(harness, ".menu-new-session");
	assert.ok(newSession, "the project menu offers a new session");
	newSession.click();
	await flush();

	// The stream resumes from the history cursor, so the frames the history
	// already rendered are neither replayed nor skipped.
	assert.equal(
		harness.sources.at(-1)?.url,
		"/projects/k1/sessions/s1/events?after=7",
	);

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
		items: [{ kind: "tool", name: "bash", label: "shell git status" }],
		cursor: null,
	});
	element<HTMLButtonElement>(harness.document, "load-earlier").click();
	await flush();

	const first = transcript?.firstElementChild;
	assert.equal(first?.className, "tool ok");
	// The historical tool line renders the server-reconstructed call summary,
	// not just the bare tool name, matching the live `tool_execution_started`
	// line the user saw during the turn.
	assert.equal(first?.textContent, "✓ shell git status");
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

test("opens the event stream only after the session's history has loaded", async () => {
	const harness = await Harness.create();
	// Block the history response so we can observe that the stream waits for it.
	let release: () => void = () => {};
	harness.historyGate = new Promise<void>((resolve) => {
		release = resolve;
	});

	element<HTMLButtonElement>(harness.document, "add-project").click();
	await flush();

	const newSession = await chooseProjectMenu(harness, ".menu-new-session");
	assert.ok(newSession, "the project menu offers a new session");
	newSession.click();
	await flush();

	assert.equal(
		harness.sources.length,
		0,
		"the stream is not opened while history is still loading",
	);
	release();
	await flush();
	assert.ok(
		harness.sources.length > 0,
		"the stream opens once history has rendered",
	);
});

test("archives a session from its row menu", async () => {
	const harness = await openSession();
	const source = harness.sources.at(-1);
	assert.ok(source, "an EventSource was opened");
	source.message({ type: "ready", turnActive: false });
	await flush();

	const trigger = harness.document.querySelector<HTMLButtonElement>(
		".session-row .menu-button",
	);
	assert.ok(trigger, "the session row has a menu trigger");
	trigger.click();
	await flush();

	const archive =
		harness.document.querySelector<HTMLButtonElement>(".menu-archive");
	assert.ok(archive, "the session menu offers archive");
	archive.click();
	await flush();

	const updates = harness.callsTo("PATCH", "/projects/k1/sessions/s1");
	assert.equal(updates.length, 1);
	assert.deepEqual(updates[0]?.body, { archived: true });
	assert.equal(
		harness.document.querySelector(".session-row"),
		null,
		"the archived session disappears from the tree",
	);
});

test("renames a session from its row menu", async () => {
	const harness = await openSession();
	const source = harness.sources.at(-1);
	assert.ok(source, "an EventSource was opened");
	source.message({ type: "ready", turnActive: false });
	await flush();

	const trigger = harness.document.querySelector<HTMLButtonElement>(
		".session-row .menu-button",
	);
	assert.ok(trigger);
	trigger.click();
	await flush();

	const rename =
		harness.document.querySelector<HTMLButtonElement>(".menu-rename");
	assert.ok(rename, "the session menu offers rename");
	rename.click();
	await flush();

	const input =
		harness.document.querySelector<HTMLInputElement>(".rename-input");
	assert.ok(input, "the label becomes an editable input");
	input.value = "My session";
	input.dispatchEvent(harness.keydownEvent({ key: "Enter" }));
	await flush();

	const updates = harness.callsTo("PATCH", "/projects/k1/sessions/s1");
	assert.equal(updates.length, 1);
	assert.deepEqual(updates[0]?.body, { title: "My session" });
});

test("renames a workspace from its menu", async () => {
	const harness = await openSession();
	const trigger = harness.document.querySelector<HTMLButtonElement>(
		".project-header .menu-button",
	);
	assert.ok(trigger);
	trigger.click();
	await flush();

	const rename =
		harness.document.querySelector<HTMLButtonElement>(".menu-rename");
	assert.ok(rename, "the workspace menu offers rename");
	rename.click();
	await flush();

	const input =
		harness.document.querySelector<HTMLInputElement>(".rename-input");
	assert.ok(input, "the workspace name becomes an editable input");
	input.value = "我的工作区";
	input.dispatchEvent(harness.keydownEvent({ key: "Enter" }));
	await flush();

	assert.equal(harness.callsTo("PATCH", "/projects/k1").length, 1);
	assert.deepEqual(harness.callsTo("PATCH", "/projects/k1")[0]?.body, {
		name: "我的工作区",
	});
	assert.equal(
		harness.document.querySelector(".project-name")?.textContent,
		"我的工作区",
	);
});

test("deletes a workspace from its menu after a confirming second click", async () => {
	const harness = await openSession();

	const del = () =>
		harness.document.querySelector<HTMLButtonElement>(".menu-delete");
	let button = await chooseProjectMenu(harness, ".menu-delete");
	assert.ok(button, "the workspace menu offers delete");

	// First click only arms the confirmation; no request goes out.
	button.click();
	await flush();
	assert.equal(harness.callsTo("DELETE", "/projects/k1").length, 0);
	button = del();
	assert.ok(button, "the delete item is armed in place");
	assert.match(button.className, /armed/);

	// Second click confirms and issues the DELETE.
	button.click();
	await flush();
	assert.equal(harness.callsTo("DELETE", "/projects/k1").length, 1);
	assert.equal(harness.document.querySelector("#projects .project"), null);
	assert.equal(harness.document.querySelectorAll("#projects .empty").length, 1);
});

test("shows the session's models and switches from the dropdown", async () => {
	const harness = await openSession();
	await flush();

	const select = element<HTMLSelectElement>(harness.document, "model-select");
	assert.equal(select.disabled, false);
	assert.deepEqual(
		Array.from(select.options).map((option) => option.value),
		["m1", "m2"],
	);
	assert.equal(select.value, "m1");

	select.value = "m2";
	select.dispatchEvent(harness.changeEvent());
	await flush();

	const switched = harness.callsTo("POST", "/projects/k1/sessions/s1/model");
	assert.equal(switched.length, 1);
	assert.deepEqual(switched[0]?.body, { modelId: "m2" });
	assert.equal(select.value, "m2");
	assert.equal(
		harness.callsTo("GET", "/projects/k1/sessions/s1/model").length,
		1,
	);
});

test("shows the context-window usage as a ring next to the model picker", async () => {
	const harness = await openSession();
	await flush();

	const el = element<HTMLElement>(harness.document, "context-usage");
	assert.equal(el.hidden, false);
	// The ring conveys the ratio; the token figures live in the tooltip, in
	// compact units so a large window stays legible.
	assert.ok(el.querySelector("svg.context-ring"), "renders the ring svg");
	assert.equal(
		el.querySelector(".context-ring-label")?.textContent,
		"3%",
		"the label shows the rounded percentage",
	);
	assert.match(el.title, /3%/);
	assert.match(el.title, /2\.5K/);
	assert.match(el.title, /100K/);
	assert.equal(
		harness.callsTo("GET", "/projects/k1/sessions/s1/context").length,
		1,
	);
});

test("folds live context estimates and refreshes after the turn ends", async () => {
	const harness = await openSession();
	await flush();
	const source = harness.sources.at(-1);
	assert.ok(source, "an EventSource was opened");
	const el = element<HTMLElement>(harness.document, "context-usage");

	// An in-flight frame's estimate updates the indicator immediately.
	source.message({
		type: "model_delta",
		step: 1,
		estimatedContextTokens: 4200,
	});
	await flush();
	assert.equal(el.querySelector(".context-ring-label")?.textContent, "4%");

	// The terminal frame refetches the measured usage from the server.
	source.message({ type: "turn_finished", step: 1, usage: null });
	await flush();
	assert.equal(
		harness.callsTo("GET", "/projects/k1/sessions/s1/context").length,
		2,
	);
});

test("hides the context indicator before any usage is known", async () => {
	const harness = await Harness.create();
	harness.contextState = {
		limit: 100000,
		usedTokens: null,
		modelName: "Model One",
	};
	element<HTMLButtonElement>(harness.document, "add-project").click();
	await flush();
	const newSession = await chooseProjectMenu(harness, ".menu-new-session");
	assert.ok(newSession, "the project menu offers a new session");
	newSession.click();
	await flush();

	const el = element<HTMLElement>(harness.document, "context-usage");
	assert.equal(el.hidden, false);
	assert.equal(el.querySelector(".context-ring-label")?.textContent, "?");
});

test("keeps the task badge hidden until a session is open", async () => {
	const harness = await Harness.create();
	const button = element<HTMLButtonElement>(harness.document, "tasks-button");
	assert.equal(button.hidden, true, "no session means no badge");
});

test("lists background tasks, shows output, and kills one from the badge", async () => {
	const harness = await openSession();
	await flush();

	const button = element<HTMLButtonElement>(harness.document, "tasks-button");
	assert.equal(button.hidden, false, "an open session shows the badge");
	assert.equal(
		button.querySelector(".tasks-count")?.textContent,
		"0",
		"the badge starts at zero",
	);
	// The badge leads the action row, filling the blank space on its left.
	const actions = harness.document.querySelector(".composer .composer-actions");
	assert.equal(actions?.firstElementChild?.id, "tasks");

	harness.tasks = [
		{
			id: "t1",
			pid: 5,
			command: "sleep 10",
			cwd: "/tmp/demo",
			description: "long job",
			startedAt: Date.now() - 5000,
			endedAt: null,
			status: "running",
			exitCode: null,
			signal: null,
			killed: false,
			timedOut: false,
		},
	];
	harness.taskOutput.set("t1", {
		output: "line one\nline two",
		truncated: false,
	});

	button.click();
	await flush();

	const panel = element<HTMLElement>(harness.document, "tasks-panel");
	assert.equal(panel.hidden, false, "clicking the badge opens the popover");
	assert.equal(
		button.querySelector(".tasks-count")?.textContent,
		"1",
		"the badge reflects the refreshed count",
	);
	const item = harness.document.querySelector<HTMLButtonElement>(".task-item");
	assert.ok(item, "the task row renders");
	assert.match(item.textContent ?? "", /long job/);
	assert.match(item.textContent ?? "", /运行中/);

	item.click();
	await flush();
	assert.equal(
		harness.document.querySelector(".task-output")?.textContent,
		"line one\nline two",
	);
	const kill = harness.document.querySelector<HTMLButtonElement>(".task-kill");
	assert.ok(kill, "a running task offers a stop button");
	kill.click();
	await flush();
	assert.equal(
		harness.callsTo("POST", "/projects/k1/sessions/s1/tasks/t1/kill").length,
		1,
	);
	// After the kill the detail refreshes: the task is done, so the stop button
	// is gone and the status reads as finished.
	assert.equal(harness.document.querySelector(".task-kill"), null);
	assert.match(
		harness.document.querySelector(".task-detail-meta")?.textContent ?? "",
		/完成/,
	);
});

test("closes the task popover from the badge and the close button", async () => {
	const harness = await openSession();
	await flush();
	const button = element<HTMLButtonElement>(harness.document, "tasks-button");
	const panel = element<HTMLElement>(harness.document, "tasks-panel");

	button.click();
	await flush();
	assert.equal(panel.hidden, false);
	button.click();
	await flush();
	assert.equal(panel.hidden, true, "clicking the badge again closes it");

	button.click();
	await flush();
	element<HTMLButtonElement>(harness.document, "tasks-close").click();
	await flush();
	assert.equal(panel.hidden, true, "the close button closes it");
});

test("renders the session info line in the composer", async () => {
	const harness = await openSession();
	await flush();

	const el = element<HTMLElement>(harness.document, "session-info");
	assert.equal(el.hidden, false);
	assert.equal(
		el.textContent,
		"2 轮 · 108 步| LLM 5分54秒 · 工具调用 5分14秒| 首 token 平均 1秒 · 255 tok/s| 缓存命中 8%| 输入 11.2M tok · 输出 62.4K tok",
	);
	// The line leads the composer action row: text first (left), then the model
	// picker / context ring and the send button (right), all on the same row.
	const actions = harness.document.querySelector(".composer .composer-actions");
	assert.ok(actions, "the composer action row renders");
	const tokens = Array.from(actions.children).map((node) => {
		if (node.id === "tasks") return "tasks";
		if (node.id === "session-info") return "info";
		if (node.classList.contains("composer-meta")) return "meta";
		if (node.id === "submit") return "submit";
		return "other";
	});
	assert.deepEqual(
		tokens,
		["tasks", "info", "meta", "submit"],
		"task badge leads, then info text, model picker/context ring and send button",
	);
	assert.equal(
		harness.callsTo("GET", "/projects/k1/sessions/s1/stats").length,
		1,
	);
});

test("refreshes the session info line after the turn ends", async () => {
	const harness = await openSession();
	await flush();
	const source = harness.sources.at(-1);
	assert.ok(source, "an EventSource was opened");

	source.message({ type: "turn_finished", step: 1, usage: null });
	await flush();
	assert.equal(
		harness.callsTo("GET", "/projects/k1/sessions/s1/stats").length,
		2,
	);
});

test("refreshes the session info line at each step, before the turn ends", async () => {
	const harness = await openSession();
	await flush();
	const source = harness.sources.at(-1);
	assert.ok(source, "an EventSource was opened");
	const statsCalls = () =>
		harness.callsTo("GET", "/projects/k1/sessions/s1/stats").length;
	assert.equal(statsCalls(), 1, "opening the session fetches the stats once");

	// The turn is still running — only a step boundary has passed — yet the line
	// must already pick up the new totals rather than waiting for turn end.
	source.message({ type: "turn_started", turnId: "t", userInput: "hi" });
	source.message({ type: "step_started", step: 1 });
	await flush();
	assert.equal(statsCalls(), 2, "a step boundary refreshes mid-turn");

	harness.statsState = { turns: 1, steps: 1 };
	source.message({ type: "step_started", step: 2 });
	await flush();
	assert.equal(
		element<HTMLElement>(harness.document, "session-info").textContent,
		"1 轮 · 1 步",
		"the refreshed totals render while the turn is still open",
	);
});

test("renders streamed reasoning in a collapsed details panel", async () => {
	const harness = await openSession();
	const source = harness.sources.at(-1);
	assert.ok(source, "an EventSource was opened");
	source.message({ type: "ready", turnActive: false });
	await flush();

	source.message({ type: "turn_started", turnId: "t", userInput: "hi" });
	source.message({
		type: "model_delta",
		step: 1,
		reasoningDelta: "Let me think",
	});
	source.message({ type: "model_delta", step: 1, reasoningDelta: " about it" });

	const details = harness.document.querySelector<HTMLDetailsElement>(
		"#transcript .msg.assistant details.reasoning",
	);
	assert.ok(details, "reasoning renders as a <details> panel");
	assert.equal(details.hidden, false);
	assert.equal(details.open, false, "collapsed by default (a single line)");
	assert.equal(
		details.querySelector("summary")?.textContent?.includes("思考"),
		true,
		"the summary carries a label",
	);
	assert.equal(
		details.querySelector(".reasoning-preview")?.textContent,
		"Let me think about it",
		"the summary previews the first line",
	);
	assert.equal(
		details.querySelector(".reasoning-body")?.textContent,
		"Let me think about it",
		"the full reasoning is retained for when it is expanded",
	);

	// The panel expands on demand.
	details.open = true;
	assert.equal(details.open, true);

	// Finalizing without content keeps the reasoning panel in place.
	source.message({ type: "model_request_finished", step: 1 });
	await flush();
	assert.ok(
		harness.document.querySelector("#transcript details.reasoning"),
		"reasoning survives finalize when the model emitted only reasoning",
	);
});

test("renders assistant output as markdown and hides absent reasoning", async () => {
	const harness = await openSession();
	const source = harness.sources.at(-1);
	assert.ok(source, "an EventSource was opened");
	source.message({ type: "ready", turnActive: false });
	await flush();

	source.message({ type: "turn_started", turnId: "t", userInput: "hi" });
	source.message({
		type: "model_delta",
		step: 1,
		contentDelta: "# Title\n\n- one\n- two\n\n**bold** and `code`",
	});
	await flush();

	const content = harness.document.querySelector(
		"#transcript .msg.assistant .content",
	);
	assert.ok(content, "the assistant content node renders");
	assert.equal(content.querySelector("h1")?.textContent, "Title");
	assert.deepEqual(
		Array.from(content.querySelectorAll("ul li")).map((li) => li.textContent),
		["one", "two"],
	);
	assert.equal(content.querySelector("strong")?.textContent, "bold");
	assert.equal(content.querySelector("code")?.textContent, "code");

	// No reasoning was emitted, so the panel is hidden until finalize drops it.
	const details = harness.document.querySelector<HTMLDetailsElement>(
		"#transcript details.reasoning",
	);
	assert.equal(details?.hidden, true);
	source.message({ type: "model_request_finished", step: 1 });
	await flush();
	assert.equal(
		harness.document.querySelector("#transcript details.reasoning"),
		null,
		"an empty reasoning panel is removed once the message finalizes",
	);
});

test("renders resumed history reasoning and markdown content", async () => {
	const harness = await Harness.create();
	element<HTMLButtonElement>(harness.document, "add-project").click();
	await flush();

	harness.historyPages.set("", {
		items: [
			{
				kind: "assistant",
				text: "## Answer\n\n- a\n- b",
				reasoning: "first line\nsecond line",
			},
		],
		cursor: null,
	});
	const newSession = await chooseProjectMenu(harness, ".menu-new-session");
	assert.ok(newSession, "the project menu offers a new session");
	newSession.click();
	await flush();

	const details = harness.document.querySelector<HTMLDetailsElement>(
		"#transcript details.reasoning",
	);
	assert.ok(details, "history reasoning renders as a <details> panel");
	assert.equal(details.open, false, "collapsed by default");
	assert.equal(
		details.querySelector(".reasoning-preview")?.textContent,
		"first line",
		"the summary shows the first reasoning line",
	);
	assert.equal(
		details.querySelector(".reasoning-body")?.textContent,
		"first line\nsecond line",
	);

	const content = harness.document.querySelector(
		"#transcript .msg.assistant .content",
	);
	assert.equal(content?.querySelector("h2")?.textContent, "Answer");
	assert.equal(content?.querySelectorAll("ul li").length, 2);
});

test("resumed history offers copy/save only on the final assistant step", async () => {
	const harness = await Harness.create();
	element<HTMLButtonElement>(harness.document, "add-project").click();
	await flush();

	harness.historyPages.set("", {
		items: [
			{ kind: "user", text: "hi" },
			{ kind: "assistant", text: "On it.", reasoning: null, final: false },
			{ kind: "tool", name: "read", label: "read" },
			{ kind: "assistant", text: "Done.", reasoning: null, final: true },
		],
		cursor: null,
	});
	const newSession = await chooseProjectMenu(harness, ".menu-new-session");
	assert.ok(newSession, "the project menu offers a new session");
	newSession.click();
	await flush();

	const messages = harness.document.querySelectorAll(
		"#transcript .msg.assistant",
	);
	assert.equal(messages.length, 2, "both persisted assistant steps render");
	assert.equal(
		messages[0]?.querySelector(".copy-message"),
		null,
		"the intermediate step offers no copy button",
	);
	assert.ok(
		messages[1]?.querySelector(".copy-message"),
		"the final step offers the copy button",
	);
});

test("adjusts the workspace width with the divider", async () => {
	const harness = await Harness.create();
	const root = harness.document.documentElement;
	assert.equal(root.style.getPropertyValue("--sidebar-width"), "280px");

	const resizer = element<HTMLDivElement>(harness.document, "resizer");
	resizer.dispatchEvent(
		harness.keydownEvent({ key: "ArrowRight", shiftKey: true }),
	);
	assert.equal(root.style.getPropertyValue("--sidebar-width"), "304px");

	resizer.dispatchEvent(
		harness.keydownEvent({ key: "ArrowLeft", shiftKey: true }),
	);
	assert.equal(root.style.getPropertyValue("--sidebar-width"), "280px");
});

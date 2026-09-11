import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DirectoryPickerUnavailableError } from "../src/server/directory-picker.js";
import type { ManagedRuntime } from "../src/server/manager.js";
import { SessionManager } from "../src/server/manager.js";
import { createMultiSessionServer } from "../src/server/multi.js";
import type {
	SessionProgressBus,
	SessionTurnOutcome,
	SessionTurnRunner,
} from "../src/session/controller.js";
import type {
	PersistedSession,
	RuntimeLogger,
	SessionEntry,
	SessionSummary,
	TurnProgressEvent,
} from "../src/types.js";

const noopLogger: RuntimeLogger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

/** Progress bus: fans out events the fake turn fires. */
class FakeProgressBus implements SessionProgressBus {
	private readonly listeners = new Set<(event: TurnProgressEvent) => void>();

	onProgress(listener: (event: TurnProgressEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	emitProgress(): void {}

	fire(event: TurnProgressEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

/** Turn runner that emits a couple of progress events per submitted turn. */
class FakeTurnRunner implements SessionTurnRunner {
	readonly submitted: string[] = [];

	constructor(private readonly bus: FakeProgressBus) {}

	async runTurn(input: string): Promise<SessionTurnOutcome> {
		this.submitted.push(input);
		this.bus.fire({
			type: "turn_started",
			turnId: "t",
			userInput: input,
		} as TurnProgressEvent);
		return { ok: true, completionStatus: "completed", outputText: "done" };
	}
}

function makeRuntime(sessionId: string): ManagedRuntime {
	const bus = new FakeProgressBus();
	return {
		runner: bus,
		turn: new FakeTurnRunner(bus),
		logger: noopLogger,
		sessionId,
		dispose() {},
	};
}

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object", "server has an address");
	return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections?.();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Read SSE frames (split on blank lines) until `count` have arrived. */
async function readFrames(
	response: Response,
	count: number,
	timeoutMs = 5000,
): Promise<string[]> {
	const reader = response.body?.getReader();
	assert.ok(reader, "response has a body stream");
	const decoder = new TextDecoder();
	const frames: string[] = [];
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	while (frames.length < count) {
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${count} SSE frames`);
		}
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let index = buffer.indexOf("\n\n");
		while (index !== -1) {
			frames.push(buffer.slice(0, index));
			buffer = buffer.slice(index + 2);
			index = buffer.indexOf("\n\n");
		}
	}
	return frames;
}

async function withServer(
	run: (baseUrl: string, manager: SessionManager) => Promise<void>,
): Promise<void> {
	let counter = 0;
	const manager = new SessionManager({
		createRuntime: async ({ sessionId }) =>
			makeRuntime(sessionId ?? `sess-${++counter}`),
		listStoredSessions: async () => [],
	});
	const server = createMultiSessionServer({ manager });
	const baseUrl = await listen(server);
	try {
		await run(baseUrl, manager);
	} finally {
		await manager.disposeAll();
		await close(server);
	}
}

async function addProject(baseUrl: string, cwd: string): Promise<string> {
	const response = await fetch(`${baseUrl}/projects`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path: cwd }),
	});
	assert.equal(response.status, 201);
	const body = (await response.json()) as { key: string };
	return body.key;
}

test("GET / serves the bundled browser client", async () => {
	await withServer(async (baseUrl) => {
		const response = await fetch(`${baseUrl}/`);
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /text\/html/);
		const html = await response.text();
		assert.match(html, /\/app\.js/);
	});
});

test("client assets are served and unknown paths still 404", async () => {
	await withServer(async (baseUrl) => {
		const app = await fetch(`${baseUrl}/app.js`);
		assert.equal(app.status, 200);
		assert.match(app.headers.get("content-type") ?? "", /javascript/);
		assert.match(await app.text(), /applyTurnProgress/);

		const reducer = await fetch(`${baseUrl}/reducer.js`);
		assert.equal(reducer.status, 200);
		assert.match(await reducer.text(), /export function applyTurnProgress/);

		const markdown = await fetch(`${baseUrl}/markdown.js`);
		assert.equal(markdown.status, 200);
		assert.match(markdown.headers.get("content-type") ?? "", /javascript/);
		assert.match(await markdown.text(), /export function renderMarkdown/);

		const css = await fetch(`${baseUrl}/styles.css`);
		assert.equal(css.status, 200);
		assert.match(css.headers.get("content-type") ?? "", /text\/css/);

		const missing = await fetch(`${baseUrl}/nope.js`);
		assert.equal(missing.status, 404);
		assert.deepEqual(await missing.json(), { error: "not_found" });
	});
});

test("GET /projects lists registered directories", async () => {
	await withServer(async (baseUrl) => {
		let response = await fetch(`${baseUrl}/projects`);
		assert.deepEqual(await response.json(), { projects: [] });

		const dir = await mkdtemp(path.join(os.tmpdir(), "sigpi-web-"));
		const key = await addProject(baseUrl, dir);

		response = await fetch(`${baseUrl}/projects`);
		const body = (await response.json()) as {
			projects: Array<{ key: string; cwd: string }>;
		};
		assert.equal(body.projects.length, 1);
		assert.equal(body.projects[0]?.key, key);
		assert.equal(body.projects[0]?.cwd, path.resolve(dir));
	});
});

test("POST /projects rejects a missing path", async () => {
	await withServer(async (baseUrl) => {
		const response = await fetch(`${baseUrl}/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "" }),
		});
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: "missing_path" });
	});
});

test("POST /projects rejects a non-existent directory", async () => {
	await withServer(async (baseUrl) => {
		const response = await fetch(`${baseUrl}/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				path: path.join(os.tmpdir(), "nope-does-not-exist"),
			}),
		});
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: "invalid_project_path" });
	});
});

test("a session round-trips submit + SSE + interrupt under a project", async () => {
	await withServer(async (baseUrl) => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "sigpi-web-"));
		const key = await addProject(baseUrl, dir);

		const createResponse = await fetch(`${baseUrl}/projects/${key}/sessions`, {
			method: "POST",
		});
		assert.equal(createResponse.status, 201);
		const { sessionId } = (await createResponse.json()) as {
			sessionId: string;
		};

		const listResponse = await fetch(`${baseUrl}/projects/${key}/sessions`);
		const list = (await listResponse.json()) as {
			stored: unknown[];
			live: Array<{ sessionId: string }>;
		};
		assert.deepEqual(
			list.live.map((live) => live.sessionId),
			[sessionId],
		);

		const ac = new AbortController();
		try {
			const eventsResponse = await fetch(
				`${baseUrl}/projects/${key}/sessions/${sessionId}/events`,
				{ signal: ac.signal },
			);
			assert.equal(eventsResponse.status, 200);
			assert.match(
				eventsResponse.headers.get("content-type") ?? "",
				/text\/event-stream/,
			);
			// comment + ready + turn_started
			const framesPromise = readFrames(eventsResponse, 3);

			const messageResponse = await fetch(
				`${baseUrl}/projects/${key}/sessions/${sessionId}/message`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ input: "hi" }),
				},
			);
			assert.equal(messageResponse.status, 202);
			assert.deepEqual(await messageResponse.json(), { accepted: true });

			const frames = await framesPromise;
			assert.match(frames[0] ?? "", /^: connected/);
			assert.match(frames[1] ?? "", /"type":"ready"/);
			assert.match(frames[2] ?? "", /"type":"turn_started"/);

			const interruptResponse = await fetch(
				`${baseUrl}/projects/${key}/sessions/${sessionId}/interrupt`,
				{ method: "POST" },
			);
			assert.equal(interruptResponse.status, 200);
			assert.deepEqual(await interruptResponse.json(), {
				accepted: false,
				alreadyRequested: false,
				stage: null,
				message: null,
			});
		} finally {
			ac.abort();
		}
	});
});

test("GET/POST .../model lists and switches a live session's model", async () => {
	const switched: string[] = [];
	const manager = new SessionManager({
		createRuntime: async () => {
			let current = "m1";
			const bus = new FakeProgressBus();
			return {
				runner: bus,
				turn: new FakeTurnRunner(bus),
				logger: noopLogger,
				sessionId: "sess",
				dispose() {},
				getModelState: () => ({
					current,
					models: [
						{ id: "m1", name: "Model One" },
						{ id: "m2", name: "Model Two" },
					],
				}),
				setModel: (modelId: string) => {
					if (modelId !== "m1" && modelId !== "m2") {
						return false;
					}
					current = modelId;
					switched.push(modelId);
					return true;
				},
			};
		},
		listStoredSessions: async () => [],
	});
	const server = createMultiSessionServer({ manager });
	const baseUrl = await listen(server);
	try {
		const dir = await mkdtemp(path.join(os.tmpdir(), "sigpi-web-"));
		const key = await addProject(baseUrl, dir);
		await fetch(`${baseUrl}/projects/${key}/sessions`, { method: "POST" });
		const base = `${baseUrl}/projects/${key}/sessions/sess/model`;

		const list = await fetch(base);
		assert.equal(list.status, 200);
		assert.deepEqual(await list.json(), {
			current: "m1",
			models: [
				{ id: "m1", name: "Model One" },
				{ id: "m2", name: "Model Two" },
			],
		});

		const switchResponse = await fetch(base, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ modelId: "m2" }),
		});
		assert.equal(switchResponse.status, 200);
		assert.equal(
			((await switchResponse.json()) as { current: string }).current,
			"m2",
		);
		assert.deepEqual(switched, ["m2"]);

		const unknown = await fetch(base, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ modelId: "nope" }),
		});
		assert.equal(unknown.status, 404);
		assert.deepEqual(await unknown.json(), { error: "unknown_model" });

		const missing = await fetch(base, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		assert.equal(missing.status, 400);
		assert.deepEqual(await missing.json(), { error: "missing_model_id" });
	} finally {
		await manager.disposeAll();
		await close(server);
	}
});

test("GET .../model reports 501 when the runtime has no model control", async () => {
	await withServer(async (baseUrl) => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "sigpi-web-"));
		const key = await addProject(baseUrl, dir);
		await fetch(`${baseUrl}/projects/${key}/sessions`, { method: "POST" });

		const response = await fetch(
			`${baseUrl}/projects/${key}/sessions/sess-1/model`,
		);
		assert.equal(response.status, 501);
		assert.deepEqual(await response.json(), {
			error: "model_control_unavailable",
		});
	});
});

test("routes to unknown projects and sessions return 404", async () => {
	await withServer(async (baseUrl) => {
		let response = await fetch(`${baseUrl}/projects/missing/sessions`);
		assert.equal(response.status, 404);

		const dir = await mkdtemp(path.join(os.tmpdir(), "sigpi-web-"));
		const key = await addProject(baseUrl, dir);
		response = await fetch(`${baseUrl}/projects/${key}/sessions/nope/message`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "hi" }),
		});
		assert.equal(response.status, 404);
		assert.deepEqual(await response.json(), { error: "session_not_found" });
	});
});

test("PATCH /projects/:key renames and persists the workspace", async () => {
	const saved: Array<Array<{ cwd: string; name?: string }>> = [];
	const manager = new SessionManager({
		createRuntime: async () => makeRuntime("sess"),
		listStoredSessions: async () => [],
		saveProjectRegistry: async (projects) => {
			saved.push(
				projects.map((project) => ({ cwd: project.cwd, name: project.name })),
			);
		},
	});
	const server = createMultiSessionServer({ manager });
	const baseUrl = await listen(server);
	try {
		const dir = await mkdtemp(path.join(os.tmpdir(), "sigpi-web-"));
		const key = await addProject(baseUrl, dir);

		const response = await fetch(`${baseUrl}/projects/${key}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "我的工作区" }),
		});
		assert.equal(response.status, 200);
		const body = (await response.json()) as { name: string | null };
		assert.equal(body.name, "我的工作区");
		assert.equal(manager.getProject(key)?.name, "我的工作区");
		assert.equal(saved.at(-1)?.[0]?.name, "我的工作区");

		// GET /projects surfaces the custom name for the client tree.
		const list = await fetch(`${baseUrl}/projects`);
		const listed = (await list.json()) as {
			projects: Array<{ key: string; name: string | null }>;
		};
		assert.equal(listed.projects[0]?.name, "我的工作区");

		const missing = await fetch(`${baseUrl}/projects/nope`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "x" }),
		});
		assert.equal(missing.status, 404);
		assert.deepEqual(await missing.json(), { error: "project_not_found" });
	} finally {
		await manager.disposeAll();
		await close(server);
	}
});

test("PATCH /projects/:key/sessions/:id renames and archives a session", async () => {
	const renamed: Array<[string, string | null]> = [];
	const archived: Array<[string, boolean]> = [];
	const manager = new SessionManager({
		createRuntime: async () => makeRuntime("sess"),
		listStoredSessions: async () => [],
		renameStoredSession: async (_cwd, sessionId, title) => {
			renamed.push([sessionId, title]);
			return sessionId === "sess";
		},
		setStoredSessionArchived: async (_cwd, sessionId, value) => {
			archived.push([sessionId, value]);
			return sessionId === "sess";
		},
	});
	const server = createMultiSessionServer({ manager });
	const baseUrl = await listen(server);
	try {
		const dir = await mkdtemp(path.join(os.tmpdir(), "sigpi-web-"));
		const key = await addProject(baseUrl, dir);
		const base = `${baseUrl}/projects/${key}/sessions/sess`;

		const renameResponse = await fetch(base, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Renamed" }),
		});
		assert.equal(renameResponse.status, 200);
		assert.deepEqual(renamed, [["sess", "Renamed"]]);

		const archiveResponse = await fetch(base, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ archived: true }),
		});
		assert.equal(archiveResponse.status, 200);
		assert.deepEqual(archived, [["sess", true]]);

		const unknown = await fetch(`${baseUrl}/projects/${key}/sessions/nope`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ archived: true }),
		});
		assert.equal(unknown.status, 404);
		assert.deepEqual(await unknown.json(), { error: "session_not_found" });

		const emptyBody = await fetch(base, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		assert.equal(emptyBody.status, 400);
		assert.deepEqual(await emptyBody.json(), { error: "missing_update" });
	} finally {
		await manager.disposeAll();
		await close(server);
	}
});

test("DELETE /projects/:key/sessions/:id retires the session", async () => {
	await withServer(async (baseUrl, manager) => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "sigpi-web-"));
		const key = await addProject(baseUrl, dir);
		const createResponse = await fetch(`${baseUrl}/projects/${key}/sessions`, {
			method: "POST",
		});
		const { sessionId } = (await createResponse.json()) as {
			sessionId: string;
		};

		const deleteResponse = await fetch(
			`${baseUrl}/projects/${key}/sessions/${sessionId}`,
			{ method: "DELETE" },
		);
		assert.equal(deleteResponse.status, 200);
		assert.deepEqual(await deleteResponse.json(), { removed: true });
		assert.equal(manager.getSession(key, sessionId), undefined);

		const again = await fetch(
			`${baseUrl}/projects/${key}/sessions/${sessionId}`,
			{ method: "DELETE" },
		);
		assert.equal(again.status, 404);
	});
});

test("DELETE /projects/:key/sessions/:id deletes the stored messages", async () => {
	const deleted: Array<[string, string]> = [];
	const manager = new SessionManager({
		createRuntime: async () => makeRuntime("sess"),
		listStoredSessions: async () => [],
		deleteStoredSession: async (cwd, sessionId) => {
			deleted.push([cwd, sessionId]);
			return true;
		},
	});
	const server = createMultiSessionServer({ manager });
	const baseUrl = await listen(server);
	try {
		const dir = await mkdtemp(path.join(os.tmpdir(), "sigpi-web-"));
		const key = await addProject(baseUrl, dir);

		// No live session with this id: deletion still succeeds via the store.
		const response = await fetch(
			`${baseUrl}/projects/${key}/sessions/stored-1`,
			{ method: "DELETE" },
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { removed: true });
		assert.deepEqual(deleted, [[path.resolve(dir), "stored-1"]]);
	} finally {
		await manager.disposeAll();
		await close(server);
	}
});

test("DELETE /projects/:key deletes the project's stored archive", async () => {
	const removed: string[] = [];
	const manager = new SessionManager({
		createRuntime: async () => makeRuntime("sess"),
		listStoredSessions: async () => [],
		deleteStoredProject: async (cwd) => {
			removed.push(cwd);
		},
	});
	const server = createMultiSessionServer({ manager });
	const baseUrl = await listen(server);
	try {
		const dir = await mkdtemp(path.join(os.tmpdir(), "sigpi-web-"));
		const key = await addProject(baseUrl, dir);

		const response = await fetch(`${baseUrl}/projects/${key}`, {
			method: "DELETE",
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { removed: true });
		assert.deepEqual(removed, [path.resolve(dir)]);
	} finally {
		await manager.disposeAll();
		await close(server);
	}
});

test("GET .../sessions labels a live session with its persisted title", async () => {
	const summary: SessionSummary = {
		sessionId: "sess-1",
		title: "Fix the build",
		lastCompletedUserInput: "Fix the build",
		updatedAt: "2024-01-01T00:00:00.000Z",
		cwd: "/tmp/x",
		turnCount: 2,
		lastTurnStatus: null,
		estimatedTokens: null,
	};
	const manager = new SessionManager({
		createRuntime: async ({ sessionId }) => makeRuntime(sessionId ?? "sess-1"),
		listStoredSessions: async () => [summary],
	});
	const server = createMultiSessionServer({ manager });
	const baseUrl = await listen(server);
	try {
		const dir = await mkdtemp(path.join(os.tmpdir(), "sigpi-web-"));
		const key = await addProject(baseUrl, dir);
		await fetch(`${baseUrl}/projects/${key}/sessions`, { method: "POST" });

		const response = await fetch(`${baseUrl}/projects/${key}/sessions`);
		const body = (await response.json()) as {
			live: Array<{
				sessionId: string;
				title: string | null;
				turnCount: number;
			}>;
		};
		const live = body.live.find((session) => session.sessionId === "sess-1");
		assert.ok(live, "the live session is listed");
		assert.equal(live.title, "Fix the build");
		assert.equal(live.turnCount, 2);
	} finally {
		await manager.disposeAll();
		await close(server);
	}
});

test("GET .../sessions leaves a live session's title null when unpersisted", async () => {
	await withServer(async (baseUrl) => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "sigpi-web-"));
		const key = await addProject(baseUrl, dir);
		await fetch(`${baseUrl}/projects/${key}/sessions`, { method: "POST" });

		const response = await fetch(`${baseUrl}/projects/${key}/sessions`);
		const body = (await response.json()) as {
			live: Array<{ title: string | null; turnCount: number }>;
		};
		assert.equal(body.live.length, 1);
		assert.equal(body.live[0]?.title, null);
		assert.equal(body.live[0]?.turnCount, 0);
	});
});

/** A manager whose one stored session (`sessionId`) exposes `entries`. */
async function withHistoryServer(
	sessionId: string,
	entries: SessionEntry[],
	run: (baseUrl: string) => Promise<void>,
): Promise<void> {
	const manager = new SessionManager({
		createRuntime: async () => makeRuntime("sess"),
		listStoredSessions: async () => [],
		readStoredSession: async (_cwd, id) => {
			if (id !== sessionId) {
				throw new Error(`Session ${id} not found`);
			}
			return { sessionId: id, entries } as unknown as PersistedSession;
		},
	});
	const server = createMultiSessionServer({ manager });
	const baseUrl = await listen(server);
	try {
		await run(baseUrl);
	} finally {
		await manager.disposeAll();
		await close(server);
	}
}

function historyUserEntry(text: string, id: string): SessionEntry {
	return {
		kind: "message",
		id,
		turnId: null,
		timestamp: "2025-01-01T00:00:00.000Z",
		message: { role: "user", content: text, id: `${id}-msg` },
	};
}

test("GET .../messages pages a stored session's history newest-first", async () => {
	const entries = Array.from({ length: 5 }, (_, i) =>
		historyUserEntry(`m${i}`, `e${i}`),
	);

	await withHistoryServer("stored", entries, async (baseUrl) => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "sigpi-web-"));
		const key = await addProject(baseUrl, dir);
		const base = `${baseUrl}/projects/${key}/sessions/stored/messages`;

		const first = await fetch(`${base}?limit=2`);
		assert.equal(first.status, 200);
		const page1 = (await first.json()) as {
			items: Array<{ text: string }>;
			cursor: number | null;
		};
		assert.deepEqual(
			page1.items.map((item) => item.text),
			["m3", "m4"],
		);
		assert.equal(page1.cursor, 3);

		const second = await fetch(`${base}?limit=2&before=3`);
		const page2 = (await second.json()) as {
			items: Array<{ text: string }>;
			cursor: number | null;
		};
		assert.deepEqual(
			page2.items.map((item) => item.text),
			["m1", "m2"],
		);
		assert.equal(page2.cursor, 1);

		const unknownSession = await fetch(
			`${baseUrl}/projects/${key}/sessions/nope/messages`,
		);
		assert.equal(unknownSession.status, 404);
		assert.deepEqual(await unknownSession.json(), {
			error: "session_not_found",
		});

		const unknownProject = await fetch(
			`${baseUrl}/projects/missing/sessions/stored/messages`,
		);
		assert.equal(unknownProject.status, 404);
		assert.deepEqual(await unknownProject.json(), {
			error: "project_not_found",
		});
	});
});

async function withPickedServer(
	pickDirectory: () => Promise<string | null>,
	run: (baseUrl: string) => Promise<void>,
): Promise<void> {
	const manager = new SessionManager({
		createRuntime: async () => makeRuntime("sess"),
		listStoredSessions: async () => [],
	});
	const server = createMultiSessionServer({ manager, pickDirectory });
	const baseUrl = await listen(server);
	try {
		await run(baseUrl);
	} finally {
		await manager.disposeAll();
		await close(server);
	}
}

test("POST /projects/pick returns the chosen directory", async () => {
	await withPickedServer(
		async () => "/tmp/chosen",
		async (baseUrl) => {
			const response = await fetch(`${baseUrl}/projects/pick`, {
				method: "POST",
			});
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { path: "/tmp/chosen" });
		},
	);
});

test("POST /projects/pick reports a cancel as a null path", async () => {
	await withPickedServer(
		async () => null,
		async (baseUrl) => {
			const response = await fetch(`${baseUrl}/projects/pick`, {
				method: "POST",
			});
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { path: null });
		},
	);
});

test("POST /projects/pick maps an unavailable picker to 501", async () => {
	await withPickedServer(
		async () => {
			throw new DirectoryPickerUnavailableError("no chooser");
		},
		async (baseUrl) => {
			const response = await fetch(`${baseUrl}/projects/pick`, {
				method: "POST",
			});
			assert.equal(response.status, 501);
			assert.deepEqual(await response.json(), { error: "picker_unavailable" });
		},
	);
});

test("GET /projects/pick is not allowed", async () => {
	await withPickedServer(
		async () => null,
		async (baseUrl) => {
			const response = await fetch(`${baseUrl}/projects/pick`);
			assert.equal(response.status, 405);
		},
	);
});

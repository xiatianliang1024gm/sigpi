import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
	ManagedRuntime,
	SessionManagerOptions,
} from "../src/server/manager.js";
import {
	SessionManager,
	SessionManagerError,
	sessionKey,
} from "../src/server/manager.js";
import {
	loadProjectRegistry,
	saveProjectRegistry,
} from "../src/server/project-store.js";
import type {
	SessionController,
	SessionProgressBus,
	SessionTurnOutcome,
	SessionTurnRunner,
} from "../src/session/controller.js";
import type {
	PersistedSession,
	RuntimeLogger,
	SessionEntry,
	TurnProgressEvent,
} from "../src/types.js";

const noopLogger: RuntimeLogger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

class FakeProgressBus implements SessionProgressBus {
	onProgress(_listener: (event: TurnProgressEvent) => void): () => void {
		return () => {};
	}
	emitProgress(): void {}
}

class FakeTurnRunner implements SessionTurnRunner {
	async runTurn(): Promise<SessionTurnOutcome> {
		return { ok: true, completionStatus: "completed", outputText: null };
	}
}

interface FakeRuntime extends ManagedRuntime {
	disposed: number;
}

function makeRuntime(sessionId: string): FakeRuntime {
	const runtime: FakeRuntime = {
		runner: new FakeProgressBus(),
		turn: new FakeTurnRunner(),
		logger: noopLogger,
		sessionId,
		disposed: 0,
		dispose() {
			this.disposed += 1;
		},
	};
	return runtime;
}

/** A manager whose runtimes are fakes and whose new sessions get `sess-N`. */
function makeManager(overrides: Partial<SessionManagerOptions> = {}): {
	manager: SessionManager;
	runtimes: FakeRuntime[];
} {
	const runtimes: FakeRuntime[] = [];
	const manager = new SessionManager({
		createRuntime: async ({ sessionId }) => {
			const runtime = makeRuntime(sessionId ?? `sess-${runtimes.length + 1}`);
			runtimes.push(runtime);
			return runtime;
		},
		listStoredSessions: async () => [],
		...overrides,
	});
	return { manager, runtimes };
}

async function tempDir(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "sigpi-project-"));
}

test("addProject validates the directory and is idempotent", async () => {
	const dir = await tempDir();
	const { manager } = makeManager();

	const first = await manager.addProject(dir);
	const second = await manager.addProject(dir);

	assert.equal(first.key, second.key, "re-adding returns the same entry");
	assert.equal(first.cwd, path.resolve(dir));
	assert.deepEqual(
		manager.listProjects().map((project) => project.key),
		[first.key],
	);

	await assert.rejects(
		() => manager.addProject(path.join(dir, "does-not-exist")),
		(error) =>
			error instanceof SessionManagerError &&
			error.code === "invalid_project_path",
	);
});

test("renameProject sets and clears the display name and persists", async () => {
	const dir = await tempDir();
	const saved: Array<Array<{ cwd: string; name?: string }>> = [];
	const { manager } = makeManager({
		saveProjectRegistry: async (projects) => {
			saved.push(
				projects.map((project) => ({ cwd: project.cwd, name: project.name })),
			);
		},
	});
	const project = await manager.addProject(dir);

	const renamed = await manager.renameProject(project.key, "我的工作区");
	assert.equal(renamed?.name, "我的工作区");
	assert.equal(saved.at(-1)?.[0]?.name, "我的工作区");

	// A blank name clears the override back to the folder name.
	await manager.renameProject(project.key, "   ");
	assert.equal(manager.getProject(project.key)?.name, undefined);

	assert.equal(await manager.renameProject("nope", "x"), undefined);
});

test("renameSession and setSessionArchived delegate to the stored store", async () => {
	const dir = await tempDir();
	const renamed: Array<[string, string | null]> = [];
	const archived: Array<[string, boolean]> = [];
	const { manager } = makeManager({
		renameStoredSession: async (_cwd, sessionId, title) => {
			renamed.push([sessionId, title]);
			return true;
		},
		setStoredSessionArchived: async (_cwd, sessionId, value) => {
			archived.push([sessionId, value]);
			return true;
		},
	});
	const project = await manager.addProject(dir);

	assert.equal(await manager.renameSession(project.key, "s1", "Title"), true);
	assert.deepEqual(renamed, [["s1", "Title"]]);
	assert.equal(await manager.setSessionArchived(project.key, "s1", true), true);
	assert.deepEqual(archived, [["s1", true]]);

	assert.equal(await manager.renameSession("nope", "s1", "T"), false);
	assert.equal(await manager.setSessionArchived("nope", "s1", true), false);
});

test("createSession starts fresh sessions with isolated runtimes", async () => {
	const dir = await tempDir();
	const { manager } = makeManager();
	const project = await manager.addProject(dir);

	const a = await manager.createSession({ projectKey: project.key });
	const b = await manager.createSession({ projectKey: project.key });

	assert.equal(a.sessionId, "sess-1");
	assert.equal(b.sessionId, "sess-2");
	assert.notEqual(a.key, b.key);
	assert.notEqual(a.runtime, b.runtime);
	assert.equal(a.key, sessionKey(project.cwd, a.sessionId));
	assert.equal(manager.listSessions(project.key).length, 2);
});

test("createSession is idempotent for an already-live session id", async () => {
	const dir = await tempDir();
	const { manager, runtimes } = makeManager();
	const project = await manager.addProject(dir);

	const first = await manager.createSession({ projectKey: project.key });
	const again = await manager.createSession({
		projectKey: project.key,
		sessionId: first.sessionId,
	});

	assert.equal(first, again, "returns the same live entry");
	assert.equal(runtimes.length, 1, "no second runtime constructed");
});

test("createSession rejects an unknown project", async () => {
	const { manager } = makeManager();
	await assert.rejects(
		() => manager.createSession({ projectKey: "nope" }),
		(error) =>
			error instanceof SessionManagerError &&
			error.code === "project_not_found",
	);
});

test("disposeSession retires the runtime and the registry entry", async () => {
	const dir = await tempDir();
	const { manager } = makeManager();
	const project = await manager.addProject(dir);
	const session = await manager.createSession({ projectKey: project.key });

	assert.equal(
		await manager.disposeSession(project.key, session.sessionId),
		true,
	);
	assert.equal(
		(session.runtime as FakeRuntime).disposed,
		1,
		"runtime.dispose was called",
	);
	assert.equal(manager.getSession(project.key, session.sessionId), undefined);
	assert.equal(
		await manager.disposeSession(project.key, session.sessionId),
		false,
		"second dispose is a no-op",
	);
});

test("removeProject disposes every session it hosts", async () => {
	const dir = await tempDir();
	const { manager } = makeManager();
	const project = await manager.addProject(dir);
	const a = await manager.createSession({ projectKey: project.key });
	const b = await manager.createSession({ projectKey: project.key });

	assert.equal(await manager.removeProject(project.key), true);
	assert.equal((a.runtime as FakeRuntime).disposed, 1);
	assert.equal((b.runtime as FakeRuntime).disposed, 1);
	assert.equal(manager.listProjects().length, 0);
	assert.equal(await manager.removeProject(project.key), false);
});

test("removeProject deletes the project's stored archive", async () => {
	const dir = await tempDir();
	const removed: string[] = [];
	const { manager } = makeManager({
		deleteStoredProject: async (cwd) => {
			removed.push(cwd);
		},
	});
	const project = await manager.addProject(dir);
	await manager.createSession({ projectKey: project.key });

	assert.equal(await manager.removeProject(project.key), true);
	assert.deepEqual(removed, [path.resolve(dir)]);
});

test("deleteSession disposes a live session and deletes its stored messages", async () => {
	const dir = await tempDir();
	const deleted: Array<[string, string]> = [];
	const { manager } = makeManager({
		deleteStoredSession: async (cwd, sessionId) => {
			deleted.push([cwd, sessionId]);
			return true;
		},
	});
	const project = await manager.addProject(dir);
	const session = await manager.createSession({ projectKey: project.key });

	assert.equal(
		await manager.deleteSession(project.key, session.sessionId),
		true,
	);
	assert.equal((session.runtime as FakeRuntime).disposed, 1);
	assert.deepEqual(deleted, [[path.resolve(dir), session.sessionId]]);
	assert.equal(manager.getSession(project.key, session.sessionId), undefined);

	// Unknown project: `false`.
	assert.equal(await manager.deleteSession("nope", "s1"), false);
});

test("deleteSession removes a stored-only session that is not live", async () => {
	const dir = await tempDir();
	const deleted: string[] = [];
	const { manager } = makeManager({
		deleteStoredSession: async (_cwd, sessionId) => {
			deleted.push(sessionId);
			return true;
		},
	});
	const project = await manager.addProject(dir);

	assert.equal(await manager.deleteSession(project.key, "stored-1"), true);
	assert.deepEqual(deleted, ["stored-1"]);
});

test("maxSessions caps concurrent live sessions", async () => {
	const dir = await tempDir();
	const { manager } = makeManager({ maxSessions: 1 });
	const project = await manager.addProject(dir);

	await manager.createSession({ projectKey: project.key });
	await assert.rejects(
		() => manager.createSession({ projectKey: project.key }),
		(error) =>
			error instanceof SessionManagerError &&
			error.code === "session_limit_reached",
	);
});

test("sweepIdle retires idle sessions but spares an active turn", async () => {
	const dir = await tempDir();
	let clock = 0;
	const { manager } = makeManager({
		now: () => clock,
		idleTtlMs: 1_000,
	});
	const project = await manager.addProject(dir);
	const session = await manager.createSession({ projectKey: project.key });

	// Idle but not yet expired.
	clock = 500;
	assert.equal(await manager.sweepIdle(), 0);
	assert.ok(manager.getSession(project.key, session.sessionId));

	// Past the TTL: retired.
	clock = 2_000;
	assert.equal(await manager.sweepIdle(), 1);
	assert.equal(manager.getSession(project.key, session.sessionId), undefined);

	// A session whose turn is active is never swept.
	const active = await manager.createSession({ projectKey: project.key });
	const activeManager = new SessionManager({
		createRuntime: async () => active.runtime,
		createController: () =>
			({ isTurnActive: () => true }) as unknown as SessionController,
		now: () => clock,
		idleTtlMs: 1_000,
	});
	const activeProject = await activeManager.addProject(dir);
	await activeManager.createSession({ projectKey: activeProject.key });
	clock = 10_000;
	assert.equal(await activeManager.sweepIdle(), 0);
});

test("sweepIdle is a no-op without a TTL", async () => {
	const dir = await tempDir();
	const { manager } = makeManager();
	const project = await manager.addProject(dir);
	await manager.createSession({ projectKey: project.key });
	assert.equal(await manager.sweepIdle(), 0);
});

test("listStoredSessions returns null for an unknown project", async () => {
	const { manager } = makeManager();
	assert.equal(await manager.listStoredSessions("nope"), null);
});

function messageEntry(
	role: "user" | "assistant",
	content: string,
	id: string,
): SessionEntry {
	return {
		kind: "message",
		id,
		turnId: null,
		timestamp: "2025-01-01T00:00:00.000Z",
		message: { role, content, id: `${id}-msg` },
	};
}

test("readSessionEntries returns a stored session's entry stream", async () => {
	const dir = await tempDir();
	const entries: SessionEntry[] = [
		messageEntry("user", "hi", "m1"),
		messageEntry("assistant", "hello", "m2"),
	];
	const { manager } = makeManager({
		readStoredSession: async () => ({ entries }) as unknown as PersistedSession,
	});
	const project = await manager.addProject(dir);

	assert.deepEqual(
		await manager.readSessionEntries(project.key, "s1"),
		entries,
	);
});

test("readSessionEntries is null for an unknown project or session", async () => {
	const dir = await tempDir();
	const { manager } = makeManager({
		readStoredSession: async () => {
			throw new Error("Session not found");
		},
	});

	assert.equal(await manager.readSessionEntries("nope", "s1"), null);

	const project = await manager.addProject(dir);
	assert.equal(await manager.readSessionEntries(project.key, "s1"), null);
});

test("restoreProjects re-registers remembered directories", async () => {
	const dir = await tempDir();
	const saved: Array<{ cwd: string }> = [];
	const { manager } = makeManager({
		loadProjectRegistry: async () => [{ cwd: dir, addedAt: 123 }],
		saveProjectRegistry: async (projects) => {
			saved.push(...projects.map((p) => ({ cwd: p.cwd })));
		},
	});

	await manager.restoreProjects();
	const projects = manager.listProjects();
	assert.equal(projects.length, 1);
	assert.equal(projects[0]?.cwd, path.resolve(dir));
	assert.equal(projects[0]?.addedAt, 123, "addedAt is preserved for ordering");

	// Idempotent: a second restore does not duplicate the entry.
	await manager.restoreProjects();
	assert.equal(manager.listProjects().length, 1);
});

test("restoreProjects drops directories that no longer exist", async () => {
	const missing = path.join(os.tmpdir(), `sigpi-gone-${Date.now()}`);
	const saved: string[] = [];
	const { manager } = makeManager({
		loadProjectRegistry: async () => [{ cwd: missing, addedAt: 1 }],
		saveProjectRegistry: async (projects) => {
			saved.push(...projects.map((p) => p.cwd));
		},
	});

	await manager.restoreProjects();
	assert.equal(manager.listProjects().length, 0);
	assert.deepEqual(saved, [], "the pruned list is written back");
});

test("addProject and removeProject persist the registry", async () => {
	const dir = await tempDir();
	const snapshots: string[][] = [];
	const { manager } = makeManager({
		saveProjectRegistry: async (projects) => {
			snapshots.push(projects.map((p) => p.cwd));
		},
	});

	const project = await manager.addProject(dir);
	assert.deepEqual(snapshots, [[path.resolve(dir)]]);

	// Re-adding the same directory is idempotent and does not re-persist.
	await manager.addProject(dir);
	assert.equal(snapshots.length, 1);

	await manager.removeProject(project.key);
	assert.deepEqual(snapshots.at(-1), []);
});

test("a bare SessionManager never touches a project registry", async () => {
	// No loader/saver injected: restore is a no-op and add/remove stay in memory.
	const dir = await tempDir();
	const { manager } = makeManager();
	await manager.restoreProjects();
	const project = await manager.addProject(dir);
	assert.equal(manager.listProjects().length, 1);
	assert.equal(await manager.removeProject(project.key), true);
	assert.equal(manager.listProjects().length, 0);
});

test("projects survive a restart when the file-backed registry is used", async () => {
	const dir = await tempDir();
	const homeDir = await mkdtemp(path.join(os.tmpdir(), "sigpi-home-"));
	const withStore = (): SessionManager =>
		makeManager({
			loadProjectRegistry: () => loadProjectRegistry({ homeDir }),
			saveProjectRegistry: (projects) =>
				saveProjectRegistry(projects, { homeDir }),
		}).manager;

	// First run: add a directory. This writes the registry to disk.
	const first = withStore();
	await first.addProject(dir);

	// "Restart": a brand-new manager reads the same file and remembers `dir`.
	const second = withStore();
	await second.restoreProjects();
	const projects = second.listProjects();
	assert.equal(projects.length, 1);
	assert.equal(projects[0]?.cwd, path.resolve(dir));
});

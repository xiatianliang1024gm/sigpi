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
import type {
	SessionController,
	SessionProgressBus,
	SessionTurnOutcome,
	SessionTurnRunner,
} from "../src/session/controller.js";
import type { RuntimeLogger, TurnProgressEvent } from "../src/types.js";

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

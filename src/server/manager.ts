import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { getDefaultSessionsRoot } from "../config.js";
import { createAgentRuntime, createRuntimeSessionStore } from "../runtime.js";
import {
	SessionController,
	type SessionControllerRuntime,
} from "../session/controller.js";
import {
	createProjectKey,
	resolveSessionStoragePaths,
} from "../session/paths.js";
import type {
	PersistedSession,
	SessionEntry as SessionStreamEntry,
	SessionSummary,
} from "../types.js";

/**
 * The slice of a runtime a {@link SessionManager} owns: the headless
 * `SessionControllerRuntime` surface plus the identity (`sessionId`) and
 * teardown (`dispose`) the registry needs. `AgentRuntime` satisfies this once
 * adapted (see {@link defaultCreateRuntime}), and tests inject a lighter fake.
 */
export interface ManagedRuntime extends SessionControllerRuntime {
	/** Persisted id of the runtime's active session. */
	readonly sessionId: string;
	/** Release the runtime's per-session resources. */
	dispose(): void | Promise<void>;
}

/** A directory the server has been told to host sessions for. */
export interface ProjectEntry {
	/** Stable `<slug>-<sha256前16>` key from {@link createProjectKey}. */
	key: string;
	/** Absolute, normalized project directory. */
	cwd: string;
	addedAt: number;
}

/** One live, in-process session and everything needed to drive and retire it. */
export interface SessionEntry {
	/** `${cwd}\u0000${sessionId}` — unique across projects. */
	key: string;
	projectKey: string;
	cwd: string;
	sessionId: string;
	controller: SessionController;
	runtime: ManagedRuntime;
	createdAt: number;
	lastActivityAt: number;
}

/** A project directory remembered across restarts. */
export interface RegisteredProject {
	/** Absolute, normalized project directory. */
	cwd: string;
	/** Epoch ms the directory was first registered (stables list ordering). */
	addedAt: number;
}

export interface SessionManagerOptions {
	/**
	 * Build a runtime for a project. Mirrors `createAgentRuntime`'s session
	 * arguments: pass `sessionId` to resume, omit it to start a fresh session.
	 * Injected in tests so no real runtime/provider is constructed.
	 */
	createRuntime?: (args: {
		cwd: string;
		sessionId?: string;
	}) => Promise<ManagedRuntime>;
	/** Wrap a runtime in a controller. Defaults to `new SessionController`. */
	createController?: (runtime: ManagedRuntime) => SessionController;
	/** List persisted session summaries for a project directory. */
	listStoredSessions?: (cwd: string) => Promise<SessionSummary[]>;
	/**
	 * Read one persisted session (its full entry stream) from a project
	 * directory. Injected in tests so history paging needs no real disk store.
	 * Defaults to reading the on-disk session store.
	 */
	readStoredSession?: (
		cwd: string,
		sessionId: string,
	) => Promise<PersistedSession>;
	/**
	 * Permanently delete one persisted session (its files and index entry).
	 * Returns whether anything existed to delete. Injected in tests so deletion
	 * needs no real disk store.
	 */
	deleteStoredSession?: (cwd: string, sessionId: string) => Promise<boolean>;
	/**
	 * Permanently delete a project's entire on-disk archive (every session file
	 * plus the index). Injected in tests so it never touches a real archive.
	 */
	deleteStoredProject?: (cwd: string) => Promise<void>;
	/** Injectable clock (tests). Defaults to `Date.now`. */
	now?: () => number;
	/**
	 * Load the project directories remembered from a previous run. Called once
	 * by {@link SessionManager.restoreProjects}. Defaults to an empty list, so a
	 * bare `SessionManager` never persists anything — the server entry point
	 * injects the real file-backed registry (see `serve.ts`).
	 */
	loadProjectRegistry?: () => Promise<RegisteredProject[]>;
	/**
	 * Persist the current project list after a directory is added or removed.
	 * Defaults to a no-op for the same reason as {@link loadProjectRegistry}.
	 */
	saveProjectRegistry?: (projects: ProjectEntry[]) => Promise<void>;
	/** Idle TTL in ms; sessions idle longer are retired by {@link sweepIdle}. */
	idleTtlMs?: number;
	/** Max concurrent live sessions; `0` (default) means unlimited. */
	maxSessions?: number;
}

export type SessionManagerErrorCode =
	| "invalid_project_path"
	| "project_not_found"
	| "session_not_found"
	| "session_limit_reached";

/** Typed failure so the HTTP layer can map a manager error to a status code. */
export class SessionManagerError extends Error {
	readonly code: SessionManagerErrorCode;

	constructor(code: SessionManagerErrorCode, message: string) {
		super(message);
		this.name = "SessionManagerError";
		this.code = code;
	}
}

/** Canonical key for a `(cwd, sessionId)` pair. */
export function sessionKey(cwd: string, sessionId: string): string {
	return `${path.resolve(cwd)}\u0000${sessionId}`;
}

async function defaultCreateRuntime(args: {
	cwd: string;
	sessionId?: string;
}): Promise<ManagedRuntime> {
	// No `sessionId` → start a fresh session; otherwise resume the given one.
	const runtime = await createAgentRuntime({
		cwd: args.cwd,
		sessionId: args.sessionId,
		createSession: args.sessionId ? undefined : true,
	});
	return {
		runner: runtime.runner,
		turn: runtime.turn,
		logger: runtime.logger,
		sessionId: runtime.session?.sessionId ?? "",
		dispose: () => runtime.dispose(),
	};
}

async function defaultListStoredSessions(
	cwd: string,
): Promise<SessionSummary[]> {
	return createRuntimeSessionStore({ cwd }).listSessions();
}

async function defaultReadStoredSession(
	cwd: string,
	sessionId: string,
): Promise<PersistedSession> {
	return createRuntimeSessionStore({ cwd }).getSession(sessionId);
}

/** Delete one persisted session (files + index entry). Returns whether it existed. */
async function defaultDeleteStoredSession(
	cwd: string,
	sessionId: string,
): Promise<boolean> {
	return createRuntimeSessionStore({ cwd }).deleteSession(sessionId);
}

/** Delete a project's whole on-disk archive (all sessions + index). */
async function defaultDeleteStoredProject(cwd: string): Promise<void> {
	const paths = resolveSessionStoragePaths({
		cwd,
		sessionsRoot: getDefaultSessionsRoot(),
	});
	await rm(paths.projectDir, { recursive: true, force: true });
}

/** True when `target` exists and is a directory (used to prune dead projects). */
async function isDirectory(target: string): Promise<boolean> {
	try {
		return (await stat(target)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Process-level registry of hosted projects and their live sessions. A single
 * `SessionManager` backs the multi-session web frontend: each added directory
 * becomes a project (one `projectKey`, so its session files land under that
 * project's directory automatically), and each project can run many sessions
 * in parallel — each with its own runtime, tools, context, and controller.
 *
 * This layer is deliberately UI-neutral and git-free (see the multi-frontend
 * handover): it never touches the terminal, `src/tui/`, or the branch watcher,
 * and it defines no SSE/HTTP concerns — it only owns session lifecycle.
 */
export class SessionManager {
	private readonly projects = new Map<string, ProjectEntry>();
	private readonly sessions = new Map<string, SessionEntry>();
	private readonly createRuntimeFn: (args: {
		cwd: string;
		sessionId?: string;
	}) => Promise<ManagedRuntime>;
	private readonly createControllerFn: (
		runtime: ManagedRuntime,
	) => SessionController;
	private readonly listStoredSessionsFn: (
		cwd: string,
	) => Promise<SessionSummary[]>;
	private readonly readStoredSessionFn: (
		cwd: string,
		sessionId: string,
	) => Promise<PersistedSession>;
	private readonly deleteStoredSessionFn: (
		cwd: string,
		sessionId: string,
	) => Promise<boolean>;
	private readonly deleteStoredProjectFn: (cwd: string) => Promise<void>;
	private readonly loadProjectRegistryFn: () => Promise<RegisteredProject[]>;
	private readonly saveProjectRegistryFn: (
		projects: ProjectEntry[],
	) => Promise<void>;
	private restoredProjects = false;
	private readonly now: () => number;
	readonly idleTtlMs: number;
	readonly maxSessions: number;

	constructor(options: SessionManagerOptions = {}) {
		this.createRuntimeFn = options.createRuntime ?? defaultCreateRuntime;
		this.createControllerFn =
			options.createController ?? ((runtime) => new SessionController(runtime));
		this.listStoredSessionsFn =
			options.listStoredSessions ?? defaultListStoredSessions;
		this.readStoredSessionFn =
			options.readStoredSession ?? defaultReadStoredSession;
		this.deleteStoredSessionFn =
			options.deleteStoredSession ?? defaultDeleteStoredSession;
		this.deleteStoredProjectFn =
			options.deleteStoredProject ?? defaultDeleteStoredProject;
		this.loadProjectRegistryFn =
			options.loadProjectRegistry ?? (async () => []);
		this.saveProjectRegistryFn =
			options.saveProjectRegistry ?? (async () => {});
		this.now = options.now ?? (() => Date.now());
		this.idleTtlMs = options.idleTtlMs ?? 0;
		this.maxSessions = options.maxSessions ?? 0;
	}

	// --- projects ---------------------------------------------------------

	/**
	 * Register a project directory. Validates that the path exists and is a
	 * directory, then keys it by {@link createProjectKey}. Idempotent: adding
	 * an already-known directory returns the existing entry.
	 */
	async addProject(cwd: string): Promise<ProjectEntry> {
		const resolved = path.resolve(cwd);
		const key = createProjectKey(resolved);
		const existing = this.projects.get(key);
		if (existing) {
			return existing;
		}

		let stats: Awaited<ReturnType<typeof stat>>;
		try {
			stats = await stat(resolved);
		} catch {
			throw new SessionManagerError(
				"invalid_project_path",
				`Project directory does not exist: ${resolved}`,
			);
		}
		if (!stats.isDirectory()) {
			throw new SessionManagerError(
				"invalid_project_path",
				`Project path is not a directory: ${resolved}`,
			);
		}

		const entry: ProjectEntry = { key, cwd: resolved, addedAt: this.now() };
		this.projects.set(key, entry);
		await this.persistProjects();
		return entry;
	}

	/**
	 * Register the directories remembered from a previous run (via the injected
	 * {@link SessionManagerOptions.loadProjectRegistry}). Idempotent and safe to
	 * call once at startup; a no-op when no loader was injected. Directories that
	 * no longer exist are skipped and pruned from the persisted registry, so a
	 * stale entry never blocks the sidebar on a folder that has since moved.
	 */
	async restoreProjects(): Promise<void> {
		if (this.restoredProjects) {
			return;
		}
		this.restoredProjects = true;

		const remembered = await this.loadProjectRegistryFn();
		let pruned = false;
		for (const entry of remembered) {
			const resolved = path.resolve(entry.cwd);
			const key = createProjectKey(resolved);
			if (this.projects.has(key)) {
				continue;
			}
			if (!(await isDirectory(resolved))) {
				pruned = true;
				continue;
			}
			this.projects.set(key, { key, cwd: resolved, addedAt: entry.addedAt });
		}
		if (pruned) {
			await this.persistProjects();
		}
	}

	/** Write the current project list to durable storage (best-effort). */
	private async persistProjects(): Promise<void> {
		try {
			await this.saveProjectRegistryFn(this.listProjects());
		} catch {
			// A registry write must never fail the user's add/remove request.
		}
	}

	/** All registered projects, oldest first. */
	listProjects(): ProjectEntry[] {
		return [...this.projects.values()].sort((a, b) => a.addedAt - b.addedAt);
	}

	getProject(projectKey: string): ProjectEntry | undefined {
		return this.projects.get(projectKey);
	}

	/**
	 * Remove a project, retire every session it hosts, and delete its entire
	 * on-disk archive (every session's messages plus the index). Returns `false`
	 * when the project was never registered.
	 *
	 * The archive removal is best-effort: the project is unregistered regardless,
	 * so a filesystem error can never wedge the registry.
	 */
	async removeProject(projectKey: string): Promise<boolean> {
		const project = this.projects.get(projectKey);
		if (!project) {
			return false;
		}
		for (const session of [...this.sessions.values()]) {
			if (session.projectKey === projectKey) {
				await this.disposeSessionEntry(session);
			}
		}
		this.projects.delete(projectKey);
		await this.persistProjects();
		try {
			await this.deleteStoredProjectFn(project.cwd);
		} catch {
			// Best-effort; the in-memory removal already succeeded.
		}
		return true;
	}

	/** Persisted session summaries for a project, or `null` if unknown. */
	async listStoredSessions(
		projectKey: string,
	): Promise<SessionSummary[] | null> {
		const project = this.projects.get(projectKey);
		if (!project) {
			return null;
		}
		return this.listStoredSessionsFn(project.cwd);
	}

	/**
	 * Persisted entry stream for a stored session, used to page a resumed
	 * session's history. Returns `null` when the project is unknown or the
	 * session id maps to neither a live session nor a persisted file, so the
	 * HTTP layer can answer `404`. A live session whose file is not yet readable
	 * (e.g. a brand-new empty session) yields an empty stream so it pages
	 * uniformly.
	 */
	async readSessionEntries(
		projectKey: string,
		sessionId: string,
	): Promise<SessionStreamEntry[] | null> {
		const project = this.projects.get(projectKey);
		if (!project) {
			return null;
		}
		try {
			const session = await this.readStoredSessionFn(project.cwd, sessionId);
			return session.entries;
		} catch {
			const live = this.sessions.get(sessionKey(project.cwd, sessionId));
			return live ? [] : null;
		}
	}

	// --- sessions ---------------------------------------------------------

	/**
	 * Create (or resume) a live session under a project. Omit `sessionId` to
	 * start a fresh session; pass one to reattach an existing persisted
	 * session. Returns the existing entry when already live so clients can
	 * re-`POST` idempotently.
	 */
	async createSession(args: {
		projectKey: string;
		sessionId?: string;
	}): Promise<SessionEntry> {
		const project = this.projects.get(args.projectKey);
		if (!project) {
			throw new SessionManagerError(
				"project_not_found",
				`Unknown project: ${args.projectKey}`,
			);
		}

		if (args.sessionId) {
			const existing = this.sessions.get(
				sessionKey(project.cwd, args.sessionId),
			);
			if (existing) {
				return existing;
			}
		}

		if (this.maxSessions > 0 && this.sessions.size >= this.maxSessions) {
			throw new SessionManagerError(
				"session_limit_reached",
				`Live session limit reached (${this.maxSessions}).`,
			);
		}

		const runtime = await this.createRuntimeFn({
			cwd: project.cwd,
			sessionId: args.sessionId,
		});
		const sessionId = runtime.sessionId || args.sessionId || "";
		const entry: SessionEntry = {
			key: sessionKey(project.cwd, sessionId),
			projectKey: project.key,
			cwd: project.cwd,
			sessionId,
			controller: this.createControllerFn(runtime),
			runtime,
			createdAt: this.now(),
			lastActivityAt: this.now(),
		};
		this.sessions.set(entry.key, entry);
		return entry;
	}

	/** Look up a live session by project and persisted session id. */
	getSession(projectKey: string, sessionId: string): SessionEntry | undefined {
		const project = this.projects.get(projectKey);
		if (!project) {
			return undefined;
		}
		return this.sessions.get(sessionKey(project.cwd, sessionId));
	}

	/** Live sessions, most recently active first; scoped to a project if given. */
	listSessions(projectKey?: string): SessionEntry[] {
		return [...this.sessions.values()]
			.filter((session) => !projectKey || session.projectKey === projectKey)
			.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
	}

	/** Mark a session as active now, so idle sweeping spares it. */
	touch(session: SessionEntry): void {
		session.lastActivityAt = this.now();
	}

	/** Retire one live session. Returns `false` when it was not live. */
	async disposeSession(
		projectKey: string,
		sessionId: string,
	): Promise<boolean> {
		const session = this.getSession(projectKey, sessionId);
		if (!session) {
			return false;
		}
		await this.disposeSessionEntry(session);
		return true;
	}

	/**
	 * Permanently delete a session: retire it if it is live (releasing its
	 * runtime) and delete its persisted messages on disk. Returns `true` when
	 * the session was either live or persisted, `false` when it was unknown
	 * (so the HTTP layer can answer `404`).
	 *
	 * Unlike {@link disposeSession}, which only retires an in-process runtime,
	 * this is destructive and cannot be undone.
	 */
	async deleteSession(projectKey: string, sessionId: string): Promise<boolean> {
		const project = this.projects.get(projectKey);
		if (!project) {
			return false;
		}
		const live = this.getSession(projectKey, sessionId);
		if (live) {
			await this.disposeSessionEntry(live);
		}
		let storedRemoved = false;
		try {
			storedRemoved = await this.deleteStoredSessionFn(project.cwd, sessionId);
		} catch {
			// Best-effort disk removal; a live session is still retired.
		}
		return Boolean(live) || storedRemoved;
	}

	/** Retire every live session (e.g. on server shutdown). */
	async disposeAll(): Promise<void> {
		for (const session of [...this.sessions.values()]) {
			await this.disposeSessionEntry(session);
		}
		this.projects.clear();
	}

	/**
	 * Retire every session idle longer than `idleTtlMs` (a running turn keeps a
	 * session alive). No-op when no TTL is configured. Returns the count
	 * retired.
	 */
	async sweepIdle(): Promise<number> {
		if (this.idleTtlMs <= 0) {
			return 0;
		}
		const cutoff = this.now() - this.idleTtlMs;
		let retired = 0;
		for (const session of [...this.sessions.values()]) {
			if (session.controller.isTurnActive()) {
				continue;
			}
			if (session.lastActivityAt < cutoff) {
				await this.disposeSessionEntry(session);
				retired += 1;
			}
		}
		return retired;
	}

	private async disposeSessionEntry(session: SessionEntry): Promise<void> {
		this.sessions.delete(session.key);
		try {
			await session.runtime.dispose();
		} catch {
			// Teardown is best-effort: a failed dispose must not wedge the
			// registry or block retiring the remaining sessions.
		}
	}
}

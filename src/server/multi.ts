import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import {
	type DirectoryPicker,
	DirectoryPickerUnavailableError,
	pickDirectory as defaultPickDirectory,
} from "./directory-picker.js";
import {
	handleSessionEvents,
	handleSessionMessage,
	readBody,
	writeJson,
} from "./http.js";
import {
	type SessionEntry,
	type SessionManager,
	SessionManagerError,
	type SessionManagerErrorCode,
} from "./manager.js";
import { serveStaticAsset } from "./static.js";

export interface MultiSessionServerOptions {
	/** The registry that owns projects and their live sessions. */
	manager: SessionManager;
	/** Max request body size in bytes. Defaults to 1 MiB. */
	maxBodyBytes?: number;
	/**
	 * Opens the host's native folder chooser for `POST /projects/pick`.
	 * Injectable so tests never block on a real dialog; defaults to the
	 * platform chooser in `./directory-picker.ts`.
	 */
	pickDirectory?: DirectoryPicker;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * The multi-session web frontend: a proof that one process hosts many
 * independent sessions across many project directories. It routes every
 * request through a {@link SessionManager} and reuses the same SSE/message
 * handlers as the single-session server, so the wire format (and thus any
 * browser reducer mirroring `applyTurnProgress`) is identical.
 *
 * Routes (project-scoped so no `cwd` ever rides in a URL):
 *
 * ```
 * GET    /projects                                  list registered projects
 * POST   /projects                { path }          add a project directory
 * POST   /projects/pick                             open a native folder chooser
 * DELETE /projects/:key                             remove a project + its sessions
 * GET    /projects/:key/sessions                    list stored + live sessions
 * POST   /projects/:key/sessions  { sessionId? }    create (or resume) a live session
 * GET    /projects/:key/sessions/:id/events         stream the session's SSE events
 * POST   /projects/:key/sessions/:id/message        submit one turn
 * POST   /projects/:key/sessions/:id/interrupt      interrupt the in-flight turn
 * DELETE /projects/:key/sessions/:id                retire the live session
 * ```
 */
export function createMultiSessionServer(
	options: MultiSessionServerOptions,
): Server {
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	const { manager } = options;
	const pickDirectory = options.pickDirectory ?? defaultPickDirectory;
	const server = createServer((req, res) => {
		route(req, res, manager, maxBodyBytes, pickDirectory).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			if (!res.headersSent) {
				writeJson(res, 500, { error: message });
				return;
			}
			res.end();
		});
	});
	return server;
}

async function route(
	req: IncomingMessage,
	res: ServerResponse,
	manager: SessionManager,
	maxBodyBytes: number,
	pickDirectory: DirectoryPicker,
): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");

	// The bundled browser client is same-origin with this API, so a GET for a
	// known asset path is served directly (see `static.ts`).
	if (req.method === "GET" && (await serveStaticAsset(url.pathname, res))) {
		return;
	}

	const segments = url.pathname
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((segment) => decodeURIComponent(segment));

	if (segments[0] !== "projects") {
		writeJson(res, 404, { error: "not_found" });
		return;
	}

	const method = req.method ?? "GET";

	// /projects
	if (segments.length === 1) {
		if (method === "GET") {
			writeJson(res, 200, {
				projects: manager.listProjects().map((project) => ({
					key: project.key,
					cwd: project.cwd,
					addedAt: project.addedAt,
				})),
			});
			return;
		}
		if (method === "POST") {
			await handleAddProject(req, res, manager, maxBodyBytes);
			return;
		}
		methodNotAllowed(res);
		return;
	}

	const projectKey = segments[1] ?? "";

	// /projects/:key
	if (segments.length === 2) {
		if (method === "POST" && projectKey === "pick") {
			await handlePickDirectory(res, pickDirectory);
			return;
		}
		if (method === "DELETE") {
			const removed = await manager.removeProject(projectKey);
			if (!removed) {
				writeJson(res, 404, { error: "project_not_found" });
				return;
			}
			writeJson(res, 200, { removed: true });
			return;
		}
		methodNotAllowed(res);
		return;
	}

	if (segments[2] !== "sessions") {
		writeJson(res, 404, { error: "not_found" });
		return;
	}

	// /projects/:key/sessions
	if (segments.length === 3) {
		if (method === "GET") {
			await handleListSessions(res, manager, projectKey);
			return;
		}
		if (method === "POST") {
			await handleCreateSession(req, res, manager, projectKey, maxBodyBytes);
			return;
		}
		methodNotAllowed(res);
		return;
	}

	const sessionId = segments[3] ?? "";

	// /projects/:key/sessions/:id
	if (segments.length === 4) {
		if (method === "DELETE") {
			const removed = await manager.disposeSession(projectKey, sessionId);
			if (!removed) {
				writeJson(res, 404, { error: "session_not_found" });
				return;
			}
			writeJson(res, 200, { removed: true });
			return;
		}
		methodNotAllowed(res);
		return;
	}

	// /projects/:key/sessions/:id/<sub>
	if (segments.length === 5) {
		const session = resolveSession(manager, projectKey, sessionId, res);
		if (!session) {
			return;
		}
		const sub = segments[4];
		if (method === "GET" && sub === "events") {
			manager.touch(session);
			handleSessionEvents(req, res, session.controller);
			return;
		}
		if (method === "POST" && sub === "message") {
			manager.touch(session);
			await handleSessionMessage(req, res, session.controller, maxBodyBytes);
			return;
		}
		if (method === "POST" && sub === "interrupt") {
			manager.touch(session);
			writeJson(res, 200, session.controller.requestInterrupt());
			return;
		}
		methodNotAllowed(res);
		return;
	}

	writeJson(res, 404, { error: "not_found" });
}

async function handleAddProject(
	req: IncomingMessage,
	res: ServerResponse,
	manager: SessionManager,
	maxBodyBytes: number,
): Promise<void> {
	let body: string;
	try {
		body = await readBody(req, maxBodyBytes);
	} catch {
		writeJson(res, 413, { error: "body_too_large" });
		return;
	}

	let input = "";
	try {
		const parsed = JSON.parse(body || "{}") as { path?: unknown };
		input = typeof parsed.path === "string" ? parsed.path : "";
	} catch {
		writeJson(res, 400, { error: "invalid_json" });
		return;
	}
	if (!input.trim()) {
		writeJson(res, 400, { error: "missing_path" });
		return;
	}

	try {
		const project = await manager.addProject(input);
		writeJson(res, 201, { key: project.key, cwd: project.cwd });
	} catch (error) {
		sendManagerError(res, error, (code) =>
			code === "invalid_project_path" ? 400 : 500,
		);
	}
}

/**
 * Open the host's native directory chooser and return the chosen absolute path
 * so the browser can add a project without the user typing one. Responds `501`
 * when the host has no chooser, and `{ path: null }` when the user cancels.
 */
async function handlePickDirectory(
	res: ServerResponse,
	pickDirectory: DirectoryPicker,
): Promise<void> {
	let picked: string | null;
	try {
		picked = await pickDirectory();
	} catch (error) {
		if (error instanceof DirectoryPickerUnavailableError) {
			writeJson(res, 501, { error: "picker_unavailable" });
			return;
		}
		writeJson(res, 500, {
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	writeJson(res, 200, { path: picked });
}

async function handleListSessions(
	res: ServerResponse,
	manager: SessionManager,
	projectKey: string,
): Promise<void> {
	const stored = await manager.listStoredSessions(projectKey);
	if (stored === null) {
		writeJson(res, 404, { error: "project_not_found" });
		return;
	}
	writeJson(res, 200, {
		stored,
		live: manager.listSessions(projectKey).map((session) => ({
			sessionId: session.sessionId,
			createdAt: session.createdAt,
			lastActivityAt: session.lastActivityAt,
			turnActive: session.controller.isTurnActive(),
		})),
	});
}

async function handleCreateSession(
	req: IncomingMessage,
	res: ServerResponse,
	manager: SessionManager,
	projectKey: string,
	maxBodyBytes: number,
): Promise<void> {
	let sessionId: string | undefined;
	let body: string;
	try {
		body = await readBody(req, maxBodyBytes);
	} catch {
		writeJson(res, 413, { error: "body_too_large" });
		return;
	}
	if (body.trim()) {
		try {
			const parsed = JSON.parse(body) as { sessionId?: unknown };
			sessionId =
				typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
		} catch {
			writeJson(res, 400, { error: "invalid_json" });
			return;
		}
	}

	let session: SessionEntry;
	try {
		session = await manager.createSession({ projectKey, sessionId });
	} catch (error) {
		sendManagerError(res, error, mapSessionErrorStatus);
		return;
	}
	writeJson(res, 201, {
		sessionId: session.sessionId,
		projectKey: session.projectKey,
		cwd: session.cwd,
	});
}

function resolveSession(
	manager: SessionManager,
	projectKey: string,
	sessionId: string,
	res: ServerResponse,
): SessionEntry | undefined {
	if (!manager.getProject(projectKey)) {
		writeJson(res, 404, { error: "project_not_found" });
		return undefined;
	}
	const session = manager.getSession(projectKey, sessionId);
	if (!session) {
		writeJson(res, 404, { error: "session_not_found" });
		return undefined;
	}
	return session;
}

function mapSessionErrorStatus(code: SessionManagerErrorCode): number {
	switch (code) {
		case "session_limit_reached":
			return 429;
		case "project_not_found":
		case "session_not_found":
			return 404;
		default:
			return 500;
	}
}

function sendManagerError(
	res: ServerResponse,
	error: unknown,
	mapStatus: (code: SessionManagerErrorCode) => number,
): void {
	if (error instanceof SessionManagerError) {
		writeJson(res, mapStatus(error.code), { error: error.code });
		return;
	}
	writeJson(res, 500, {
		error: error instanceof Error ? error.message : String(error),
	});
}

function methodNotAllowed(res: ServerResponse): void {
	writeJson(res, 405, { error: "method_not_allowed" });
}

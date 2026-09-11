import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * A project directory remembered across restarts. `addedAt` preserves insertion
 * order so the sidebar lists directories the same way after a restart.
 */
export interface RegisteredProject {
	cwd: string;
	addedAt: number;
	/** Optional user-chosen display name; falls back to the folder name. */
	name?: string;
}

interface ProjectStoreOptions {
	homeDir?: string;
}

/** Bumped when the on-disk shape changes so a future reader can migrate. */
const REGISTRY_VERSION = 1;

/** Path of the registry file, alongside `state.json` under `~/.sigpi`. */
export function getProjectRegistryPath(homeDir: string = homedir()): string {
	return path.join(homeDir, ".sigpi", "projects.json");
}

/**
 * Read the remembered project directories. Tolerant by design: a missing,
 * unreadable, or corrupt registry all yield `[]` so a bad file can never block
 * server startup — worst case the user re-adds their folders.
 */
export async function loadProjectRegistry(
	options: ProjectStoreOptions = {},
): Promise<RegisteredProject[]> {
	const homeDir = options.homeDir ?? homedir();
	try {
		const raw = await readFile(getProjectRegistryPath(homeDir), "utf8");
		return parseProjectRegistry(raw);
	} catch {
		return [];
	}
}

/**
 * Overwrite the registry with `projects`, atomically (temp file + rename) so a
 * crash mid-write never leaves a half-serialized file behind.
 */
export async function saveProjectRegistry(
	projects: RegisteredProject[],
	options: ProjectStoreOptions = {},
): Promise<void> {
	const homeDir = options.homeDir ?? homedir();
	const filePath = getProjectRegistryPath(homeDir);
	await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });

	const payload = { version: REGISTRY_VERSION, projects };
	const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await rename(tempPath, filePath);
}

/** Parse a registry payload, dropping any entry that is not a usable project. */
function parseProjectRegistry(raw: string): RegisteredProject[] {
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object") {
		return [];
	}
	const entries = (parsed as { projects?: unknown }).projects;
	if (!Array.isArray(entries)) {
		return [];
	}

	const projects: RegisteredProject[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const cwd = (entry as { cwd?: unknown }).cwd;
		if (typeof cwd !== "string" || cwd.length === 0) {
			continue;
		}
		const addedAt = (entry as { addedAt?: unknown }).addedAt;
		const project: RegisteredProject = {
			cwd,
			addedAt:
				typeof addedAt === "number" && Number.isFinite(addedAt) ? addedAt : 0,
		};
		const name = (entry as { name?: unknown }).name;
		if (typeof name === "string" && name.trim()) {
			project.name = name.trim();
		}
		projects.push(project);
	}
	return projects;
}

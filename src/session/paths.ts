import { createHash } from "node:crypto";
import path from "node:path";

export const SESSION_INDEX_FILENAME = "index.json";

export interface SessionStoragePaths {
	cwd: string;
	sessionsRoot: string;
	projectKey: string;
	projectDir: string;
	sessionsDir: string;
	indexPath: string;
}

export function resolveSessionStoragePaths(args: {
	cwd: string;
	sessionsRoot: string;
}): SessionStoragePaths {
	const normalizedCwd = path.resolve(args.cwd);
	const resolvedSessionsRoot = path.resolve(args.sessionsRoot);
	const projectKey = createProjectKey(normalizedCwd);
	const projectDir = path.join(resolvedSessionsRoot, projectKey);

	return {
		cwd: normalizedCwd,
		sessionsRoot: resolvedSessionsRoot,
		projectKey,
		projectDir,
		sessionsDir: path.join(projectDir, "sessions"),
		indexPath: path.join(projectDir, SESSION_INDEX_FILENAME),
	};
}

export function createProjectKey(cwd: string): string {
	const normalizedCwd = path.resolve(cwd);
	const baseName = path.basename(normalizedCwd) || "root";
	const slug =
		baseName
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-+|-+$/gu, "") || "root";
	const digest = createHash("sha256")
		.update(normalizedCwd)
		.digest("hex")
		.slice(0, 16);

	return `${slug}-${digest}`;
}

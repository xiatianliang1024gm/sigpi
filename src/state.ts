import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface AgentState {
	lastModelId: string | null;
}

export interface LoadAgentStateOptions {
	homeDir?: string;
}

export interface SaveAgentStateOptions {
	homeDir?: string;
}

function getStateDir(homeDir: string): string {
	return path.join(homeDir, ".sigpi");
}

function getStatePath(homeDir: string): string {
	return path.join(getStateDir(homeDir), "state.json");
}

export async function loadAgentState(
	options: LoadAgentStateOptions = {},
): Promise<AgentState> {
	const homeDir = options.homeDir ?? homedir();
	const statePath = getStatePath(homeDir);

	try {
		const raw = await readFile(statePath, "utf8");
		return parseAgentState(raw);
	} catch (error) {
		if (isMissingFile(error) || error instanceof SyntaxError) {
			return { lastModelId: null };
		}
		throw error;
	}
}

export function loadAgentStateSync(
	options: LoadAgentStateOptions = {},
): AgentState {
	const homeDir = options.homeDir ?? homedir();
	const statePath = getStatePath(homeDir);

	try {
		const raw = readFileSync(statePath, "utf8");
		return parseAgentState(raw);
	} catch (error) {
		if (isMissingFile(error) || error instanceof SyntaxError) {
			return { lastModelId: null };
		}
		throw error;
	}
}

export async function saveAgentState(
	state: AgentState,
	options: SaveAgentStateOptions = {},
): Promise<void> {
	const homeDir = options.homeDir ?? homedir();
	const stateDir = getStateDir(homeDir);
	const statePath = getStatePath(homeDir);

	await mkdir(stateDir, { recursive: true, mode: 0o700 });

	const tempPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});

	await rename(tempPath, statePath);
}

export async function setLastModelId(
	modelId: string,
	options: SaveAgentStateOptions = {},
): Promise<void> {
	const current = await loadAgentState(options);
	current.lastModelId = modelId;
	await saveAgentState(current, options);
}

function isMissingFile(error: unknown): boolean {
	return Boolean(
		error &&
			typeof error === "object" &&
			"code" in error &&
			((error as { code?: string }).code === "ENOENT" ||
				(error as { code?: string }).code === "ENOTDIR"),
	);
}

function parseAgentState(raw: string): AgentState {
	const parsed = JSON.parse(raw) as unknown;

	if (
		typeof parsed === "object" &&
		parsed !== null &&
		("lastModelId" in parsed || Object.keys(parsed).length === 0)
	) {
		const obj = parsed as Record<string, unknown>;
		return {
			lastModelId:
				typeof obj.lastModelId === "string" && obj.lastModelId.length > 0
					? obj.lastModelId
					: null,
		};
	}

	return { lastModelId: null };
}

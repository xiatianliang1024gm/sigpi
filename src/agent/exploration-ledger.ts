import type {
	ExplorationLedger,
	ExplorationReadRange,
	ExplorationSearchEntry,
	JsonValue,
	LedgerRecorder,
	Message,
	ToolCall,
	ToolExecutionResult,
} from "../types.js";

const MAX_SEARCHES = 40;
const MAX_FILES = 80;
const MAX_READ_RANGES = 80;
const MAX_FINDINGS = 40;
const MAX_PATH_CHARS = 180;
const MAX_FINDING_CHARS = 220;
const EXPLORATION_STATE_MAX_CHARS = 2_400;

export function createEmptyExplorationLedger(): ExplorationLedger {
	return {
		searchedQueries: [],
		candidateFiles: [],
		readRanges: [],
		rejectedPaths: [],
		keyFindings: [],
		modifiedFiles: [],
	};
}

export function normalizeExplorationLedger(
	ledger: ExplorationLedger | null | undefined,
): ExplorationLedger {
	if (!ledger) {
		return createEmptyExplorationLedger();
	}

	return {
		searchedQueries: [...(ledger.searchedQueries ?? [])].slice(-MAX_SEARCHES),
		candidateFiles: normalizeStringList(ledger.candidateFiles, MAX_FILES),
		readRanges: [...(ledger.readRanges ?? [])].slice(-MAX_READ_RANGES),
		rejectedPaths: normalizeStringList(ledger.rejectedPaths, MAX_FILES),
		keyFindings: normalizeStringList(ledger.keyFindings, MAX_FINDINGS),
		modifiedFiles: normalizeStringList(ledger.modifiedFiles, MAX_FILES),
	};
}

export function updateLedgerFromToolExecution(
	ledger: ExplorationLedger,
	toolCall: ToolCall,
	result: ToolExecutionResult,
): ExplorationLedger {
	const next = normalizeExplorationLedger(ledger);
	if (!result.ok) {
		const path = getString(toolCall.arguments.file_path);
		if (path) {
			addUnique(next.rejectedPaths, compactPath(path), MAX_FILES);
		}
	}
	return next;
}

export function updateLedgerFromMessages(
	ledger: ExplorationLedger,
	messages: readonly Message[],
): ExplorationLedger {
	let next = normalizeExplorationLedger(ledger);
	const pendingCalls = new Map<string, ToolCall>();

	for (const message of messages) {
		if (message.role === "assistant") {
			for (const toolCall of message.toolCalls ?? []) {
				pendingCalls.set(toolCall.id, toolCall);
			}
			continue;
		}

		if (message.role !== "tool") {
			continue;
		}

		const toolCall = pendingCalls.get(message.toolCallId);
		if (!toolCall) {
			next = updateLedgerFromRenderedToolMessage(next, message);
			continue;
		}

		const ok = !/^STATUS:\s*error$/m.test(message.content);
		// Replay reconstructor: rebuild successful entries from the tool call
		// args (the structured result is not available when hydrating from a
		// persisted transcript). The live path records through the tool's own
		// `recordLedger` adapter instead.
		recordSuccessfulTool(next, toolCall, { ok });
		next = updateLedgerFromToolExecution(next, toolCall, { ok });
		next = updateLedgerFromRenderedToolMessage(next, message);
	}

	return next;
}

export function renderExplorationState(
	ledger: ExplorationLedger,
): string | null {
	const state = normalizeExplorationLedger(ledger);
	const sections: string[] = [];

	if (state.searchedQueries.length > 0) {
		sections.push(
			[
				"Exploration state:",
				"Searches already run:",
				...state.searchedQueries.slice(-12).map((entry) => {
					const glob = entry.glob ? ` glob=${entry.glob}` : "";
					const repeated =
						entry.repeatedCount > 1 ? ` repeated=${entry.repeatedCount}` : "";
					const count =
						entry.resultCount === null ? "" : ` results=${entry.resultCount}`;
					const truncated = entry.truncated === true ? " truncated=yes" : "";
					return `- ${entry.query}${glob}${count}${truncated}${repeated}`;
				}),
			].join("\n"),
		);
	}

	if (state.candidateFiles.length > 0) {
		sections.push(
			[
				"Candidate files:",
				...state.candidateFiles.slice(-20).map((file) => `- ${file}`),
			].join("\n"),
		);
	}

	if (state.readRanges.length > 0) {
		sections.push(
			[
				"Files/ranges already read:",
				...state.readRanges
					.slice(-20)
					.map((range) => `- ${formatReadRange(range)}`),
			].join("\n"),
		);
	}

	if (state.modifiedFiles.length > 0) {
		sections.push(
			[
				"Files modified:",
				...state.modifiedFiles.slice(-20).map((file) => `- ${file}`),
			].join("\n"),
		);
	}

	if (state.keyFindings.length > 0) {
		sections.push(
			[
				"Key tool findings:",
				...state.keyFindings.slice(-12).map((finding) => `- ${finding}`),
			].join("\n"),
		);
	}

	if (sections.length === 0) {
		return null;
	}

	return truncateText(
		[
			sections.join("\n"),
			"Do NOT repeat equivalent searches or reread the same ranges. Use the exploration state above and existing conversation history to determine if a file or search has already been examined before issuing new tool calls.",
		].join("\n"),
		EXPLORATION_STATE_MAX_CHARS,
	);
}

export function renderExplorationDetails(
	ledger: ExplorationLedger,
): string | null {
	const state = normalizeExplorationLedger(ledger);
	const details = [
		"## Exploration Details",
		"",
		"### Searched Queries",
		...(state.searchedQueries.length > 0
			? state.searchedQueries.map((entry) => `- ${formatSearchEntry(entry)}`)
			: ["- (none)"]),
		"",
		"### Candidate Files",
		...(state.candidateFiles.length > 0
			? state.candidateFiles.map((file) => `- ${file}`)
			: ["- (none)"]),
		"",
		"### Read Files",
		...(state.readRanges.length > 0
			? state.readRanges.map((range) => `- ${formatReadRange(range)}`)
			: ["- (none)"]),
		"",
		"### Modified Files",
		...(state.modifiedFiles.length > 0
			? state.modifiedFiles.map((file) => `- ${file}`)
			: ["- (none)"]),
		"",
		"### Rejected Paths",
		...(state.rejectedPaths.length > 0
			? state.rejectedPaths.map((file) => `- ${file}`)
			: ["- (none)"]),
	].join("\n");

	return details;
}

export function makeLedgerRecorder(ledger: ExplorationLedger): LedgerRecorder {
	return {
		search(entry) {
			upsertSearch(ledger, {
				query: compactText(entry.query, 160),
				glob: entry.glob ?? null,
				output: entry.output ?? null,
				caseSensitive: entry.caseSensitive ?? null,
				resultCount: entry.resultCount ?? null,
				truncated: entry.truncated ?? null,
				repeatedCount: entry.repeatedCount ?? 1,
			});
		},
		read(path, range) {
			addReadRange(ledger, {
				path: compactPath(path),
				startLine: range?.startLine,
				endLine: range?.endLine,
				startChar: range?.startChar,
				endChar: range?.endChar,
				truncated: range?.truncated,
			});
		},
		modified(path) {
			recordPathList(ledger.modifiedFiles, path);
		},
		candidate(path) {
			recordPathList(ledger.candidateFiles, path);
		},
		finding(text) {
			addUnique(ledger.keyFindings, text, MAX_FINDINGS);
		},
		rejected(path) {
			addUnique(ledger.rejectedPaths, compactPath(path), MAX_FILES);
		},
		shellFinding(command, ok, exitCode) {
			addUnique(
				ledger.keyFindings,
				`Ran "${compactText(command, 100)}"${
					ok === null ? "" : ok ? " successfully" : " with failure"
				}${exitCode === null ? "" : ` (exit ${exitCode})`}.`,
				MAX_FINDINGS,
			);
		},
	};
}

function recordSuccessfulTool(
	ledger: ExplorationLedger,
	toolCall: ToolCall,
	result: ToolExecutionResult,
): void {
	const data = result.data;
	switch (toolCall.name) {
		case "grep":
			recordSearch(ledger, toolCall, data);
			recordCandidateFiles(ledger, data);
			recordSearchFinding(ledger, toolCall, data);
			break;
		case "glob":
			recordCandidateFiles(ledger, data);
			break;
		case "read":
			recordReadRange(ledger, toolCall, data);
			break;
		case "write":
		case "edit":
			recordPathList(
				ledger.modifiedFiles,
				getString(toolCall.arguments.file_path),
			);
			recordPathList(ledger.modifiedFiles, getStringFromData(data, "path"));
			break;
		case "bash":
			recordShellFinding(ledger, toolCall, data);
			break;
	}
}

function updateLedgerFromRenderedToolMessage(
	ledger: ExplorationLedger,
	message: Extract<Message, { role: "tool" }>,
): ExplorationLedger {
	const next = normalizeExplorationLedger(ledger);
	const path = matchLine(message.content, /^Path:\s*(.+)$/m);

	if (path) {
		if (message.name === "read") {
			addReadRange(next, { path: compactPath(path) });
		}
		if (message.name === "write" || message.name === "edit") {
			recordPathList(next.modifiedFiles, path);
		}
	}

	if (message.name === "grep") {
		const query = matchLine(message.content, /^Pattern:\s*(.+)$/m);
		if (query) {
			const glob = matchLine(message.content, /^Glob:\s*(.+)$/m);
			const resultCount = Number(
				matchLine(message.content, /^Result count:\s*(\d+)$/m),
			);
			upsertSearch(next, {
				query,
				glob: glob && glob !== "(none)" ? glob : null,
				output: matchLine(message.content, /^Output mode:\s*(.+)$/m),
				caseSensitive: null,
				resultCount: Number.isFinite(resultCount) ? resultCount : null,
				truncated: /Truncated:\s*yes/i.test(message.content),
				repeatedCount: 0,
			});
		}
		recordCandidateFiles(next, { matches: message.content });
	}

	return next;
}

function recordSearch(
	ledger: ExplorationLedger,
	toolCall: ToolCall,
	data: JsonValue | undefined,
): void {
	const query = getString(toolCall.arguments.pattern);
	if (!query) {
		return;
	}

	upsertSearch(ledger, {
		query: compactText(query, 160),
		glob: getString(toolCall.arguments.glob),
		output: getString(toolCall.arguments.output_mode),
		caseSensitive:
			typeof toolCall.arguments.case_sensitive === "boolean"
				? toolCall.arguments.case_sensitive
				: null,
		resultCount:
			getNumberFromData(data, "totalMatchCount") ??
			getNumberFromData(data, "resultCount"),
		truncated: getBooleanFromData(data, "truncated"),
		repeatedCount: 1,
	});
}

function upsertSearch(
	ledger: ExplorationLedger,
	entry: ExplorationSearchEntry,
): void {
	const existing = ledger.searchedQueries.find(
		(candidate) =>
			candidate.query === entry.query &&
			candidate.glob === entry.glob &&
			candidate.output === entry.output &&
			candidate.caseSensitive === entry.caseSensitive,
	);

	if (existing) {
		existing.repeatedCount += entry.repeatedCount;
		existing.resultCount = entry.resultCount ?? existing.resultCount;
		existing.truncated = entry.truncated ?? existing.truncated;
		return;
	}

	ledger.searchedQueries.push({
		...entry,
		repeatedCount: Math.max(1, entry.repeatedCount),
	});
	trimHead(ledger.searchedQueries, MAX_SEARCHES);
}

function recordSearchFinding(
	ledger: ExplorationLedger,
	toolCall: ToolCall,
	data: JsonValue | undefined,
): void {
	const query = getString(toolCall.arguments.pattern);
	if (!query) {
		return;
	}
	const count =
		getNumberFromData(data, "totalMatchCount") ??
		getNumberFromData(data, "resultCount");
	const truncated = getBooleanFromData(data, "truncated");
	const finding = `Search "${compactText(query, 80)}"${count === null ? "" : ` found ${count}`} match(es)${truncated ? " and was truncated" : ""}.`;
	addUnique(ledger.keyFindings, finding, MAX_FINDINGS);
}

function recordShellFinding(
	ledger: ExplorationLedger,
	toolCall: ToolCall,
	data: JsonValue | undefined,
): void {
	const command = getString(toolCall.arguments.command);
	if (!command) {
		return;
	}
	const ok = getBooleanFromData(data, "ok");
	const exitCode = getNumberFromData(data, "exitCode");
	addUnique(
		ledger.keyFindings,
		`Ran "${compactText(command, 100)}"${ok === null ? "" : ok ? " successfully" : " with failure"}${exitCode === null ? "" : ` (exit ${exitCode})`}.`,
		MAX_FINDINGS,
	);
}

function recordCandidateFiles(
	ledger: ExplorationLedger,
	data: JsonValue | undefined,
): void {
	for (const file of getStringArrayFromData(data, "files")) {
		recordPathList(ledger.candidateFiles, file);
	}

	const matches = getStringFromData(data, "matches");
	if (!matches) {
		return;
	}

	for (const file of extractPathsFromSearchOutput(matches)) {
		recordPathList(ledger.candidateFiles, file);
	}
}

function recordReadRange(
	ledger: ExplorationLedger,
	toolCall: ToolCall,
	data: JsonValue | undefined,
): void {
	const dataPath = getStringFromData(data, "path");
	const argPath = getString(toolCall.arguments.file_path);
	const path = dataPath ?? argPath;
	if (!path) {
		return;
	}

	addReadRange(ledger, {
		path: compactPath(path),
		startLine:
			getNumberFromData(data, "returnedLineStart") ??
			getNumber(toolCall.arguments.startLine),
		endLine:
			getNumberFromData(data, "returnedLineEnd") ??
			getNumber(toolCall.arguments.endLine),
		startChar:
			getNumberFromData(data, "returnedCharStart") ??
			getNumber(toolCall.arguments.startChar),
		endChar: getNumberFromData(data, "returnedCharEnd"),
		truncated: getBooleanFromData(data, "truncated"),
	});
}

function addReadRange(
	ledger: ExplorationLedger,
	readRange: ExplorationReadRange,
): void {
	const key = formatReadRange(readRange);
	if (ledger.readRanges.some((range) => formatReadRange(range) === key)) {
		return;
	}
	ledger.readRanges.push(readRange);
	trimHead(ledger.readRanges, MAX_READ_RANGES);
}

function recordPathList(list: string[], path: string | null | undefined): void {
	if (!path) {
		return;
	}
	addUnique(list, compactPath(path), MAX_FILES);
}

export function extractPathsFromSearchOutput(output: string): string[] {
	const paths = new Set<string>();
	for (const line of output.split("\n")) {
		const normalizedLine = line.replace(/^matches:\s*/i, "").trim();
		const match = normalizedLine.match(/^(.+?)(?::\d+:|-\d+:|$)/);
		const candidate = match?.[1]?.trim();
		if (candidate && !candidate.includes(" ") && !candidate.startsWith("===")) {
			paths.add(candidate);
		}
	}
	return [...paths];
}

function formatSearchEntry(entry: ExplorationSearchEntry): string {
	const glob = entry.glob ? ` glob=${entry.glob}` : "";
	const output = entry.output ? ` output=${entry.output}` : "";
	const count =
		entry.resultCount === null ? "" : ` results=${entry.resultCount}`;
	const truncated = entry.truncated === true ? " truncated=yes" : "";
	return `${entry.query}${glob}${output}${count}${truncated}`;
}

function formatReadRange(range: ExplorationReadRange): string {
	const path = compactPath(range.path);
	if (range.startLine !== undefined || range.endLine !== undefined) {
		return `${path}:lines ${range.startLine ?? "?"}-${range.endLine ?? "?"}${range.truncated ? " (truncated)" : ""}`;
	}
	if (range.startChar !== undefined || range.endChar !== undefined) {
		return `${path}:chars ${range.startChar ?? "?"}-${range.endChar ?? "?"}${range.truncated ? " (truncated)" : ""}`;
	}
	return path;
}

function normalizeStringList(
	values: readonly string[] | undefined,
	maxCount: number,
): string[] {
	const result: string[] = [];
	for (const value of values ?? []) {
		addUnique(result, compactText(value, MAX_FINDING_CHARS), maxCount);
	}
	return result;
}

function addUnique(list: string[], value: string, maxCount: number): void {
	const compact = compactText(value, MAX_FINDING_CHARS);
	if (!compact || list.includes(compact)) {
		return;
	}
	list.push(compact);
	trimHead(list, maxCount);
}

function trimHead<T>(list: T[], maxCount: number): void {
	if (list.length > maxCount) {
		list.splice(0, list.length - maxCount);
	}
}

function getString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getDataObject(
	data: JsonValue | undefined,
): Record<string, JsonValue> | null {
	return typeof data === "object" && data !== null && !Array.isArray(data)
		? data
		: null;
}

function getStringFromData(
	data: JsonValue | undefined,
	key: string,
): string | null {
	return getString(getDataObject(data)?.[key]);
}

function getNumberFromData(
	data: JsonValue | undefined,
	key: string,
): number | null {
	return getNumber(getDataObject(data)?.[key]);
}

function getBooleanFromData(
	data: JsonValue | undefined,
	key: string,
): boolean | null {
	const value = getDataObject(data)?.[key];
	return typeof value === "boolean" ? value : null;
}

function getStringArrayFromData(
	data: JsonValue | undefined,
	key: string,
): string[] {
	const value = getDataObject(data)?.[key];
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string");
}

function matchLine(content: string, regex: RegExp): string | null {
	return content.match(regex)?.[1]?.trim() ?? null;
}

function compactPath(value: string): string {
	return compactText(value.replace(/\\/g, "/"), MAX_PATH_CHARS);
}

function compactText(value: string, maxChars: number): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length > maxChars
		? `${compact.slice(0, maxChars - 3).trimEnd()}...`
		: compact;
}

function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}
	return `${value.slice(0, maxChars).trimEnd()}\n[exploration state truncated]`;
}

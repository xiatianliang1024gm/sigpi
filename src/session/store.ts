import { createHash, randomUUID } from "node:crypto";
import {
	access,
	appendFile,
	mkdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { estimateMessageTokens } from "../context-window.js";
import {
	compareTimestampDescending,
	formatLocalTimestamp,
	normalizeTimestampString,
} from "../time.js";
import type {
	ConversationContextState,
	ExecutedToolCall,
	InterruptSource,
	InterruptStage,
	JsonValue,
	LoadedSession,
	PersistedSession,
	RuntimeLogger,
	SessionEntry,
	SessionSummary,
	ToolExecutionResult,
} from "../types.js";
import {
	deriveContextStateFromEntries,
	resolveEntriesForPersist,
} from "./format.js";
import type { SessionStoragePaths } from "./paths.js";

const SESSION_VERSION = 4 as const;

const toolCallSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	arguments: z.record(z.unknown()),
	rawArguments: z.string(),
});

const userMessageSchema = z.object({
	role: z.literal("user"),
	content: z.string(),
	id: z.string().min(1),
});

const assistantMessageSchema = z.object({
	role: z.literal("assistant"),
	content: z.string().nullable(),
	toolCalls: z.array(toolCallSchema).optional(),
	id: z.string().min(1),
});

const toolMessageSchema = z.object({
	role: z.literal("tool"),
	name: z.string().min(1),
	toolCallId: z.string().min(1),
	content: z.string(),
	id: z.string().min(1),
});

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(jsonValueSchema),
		z.record(jsonValueSchema),
	]),
);

const explorationSearchEntrySchema = z.object({
	query: z.string(),
	glob: z.string().nullable(),
	output: z.string().nullable(),
	caseSensitive: z.boolean().nullable(),
	resultCount: z.number().nullable(),
	truncated: z.boolean().nullable(),
	repeatedCount: z.number().int().positive(),
});

const explorationReadRangeSchema = z.object({
	path: z.string(),
	startLine: z.number().nullable().optional(),
	endLine: z.number().nullable().optional(),
	startChar: z.number().nullable().optional(),
	endChar: z.number().nullable().optional(),
	truncated: z.boolean().nullable().optional(),
});

const explorationLedgerSchema = z.object({
	searchedQueries: z.array(explorationSearchEntrySchema),
	candidateFiles: z.array(z.string()),
	readRanges: z.array(explorationReadRangeSchema),
	rejectedPaths: z.array(z.string()),
	keyFindings: z.array(z.string()),
	modifiedFiles: z.array(z.string()),
});

const turnStatusSchema = z.enum([
	"in_progress",
	"completed",
	"failed",
	"interrupted",
]);
const sessionStatusSchema = z.enum(["active", "interrupted", "completed"]);

const sessionTurnRecordSchema = z.object({
	startedAt: z.string().min(1),
	finishedAt: z.string().nullable(),
	status: turnStatusSchema,
	userInput: z.string(),
	assistantOutput: z.string().nullable(),
	toolExecutionCount: z.number().int().nonnegative(),
	errorMessage: z.string().nullable().optional(),
	interruptSource: z
		.enum(["user_escape", "process_recovery"])
		.nullable()
		.optional(),
	interruptStage: z.enum(["model", "tool"]).nullable().optional(),
});

const toolExecutionResultSchema: z.ZodType<ToolExecutionResult> = z.object({
	ok: z.boolean(),
	data: jsonValueSchema.optional(),
	error: z.string().optional(),
	details: jsonValueSchema.optional(),
});

const sessionToolExecutionEntrySchema: z.ZodType<ExecutedToolCall> = z.object({
	toolCall: toolCallSchema,
	result: toolExecutionResultSchema,
});

const sessionTurnHistoryEntrySchema = z.object({
	turnId: z.number().int().positive(),
	startedAt: z.string().min(1),
	finishedAt: z.string().nullable(),
	status: turnStatusSchema,
	userInput: z.string(),
	assistantOutput: z.string().nullable(),
	steps: z.number().int().nonnegative(),
	toolExecutions: z.array(sessionToolExecutionEntrySchema),
	errorMessage: z.string().nullable(),
	interruptSource: z
		.enum(["user_escape", "process_recovery"])
		.nullable()
		.optional(),
	interruptStage: z.enum(["model", "tool"]).nullable().optional(),
});

const messageEntrySchema = z.object({
	kind: z.literal("message"),
	id: z.string().min(1),
	turnId: z.number().int().nullable(),
	timestamp: z.string().min(1),
	// Persisted message entries never include system messages — those are
	// synthesized by `buildMessages` on every request. User / assistant /
	// tool messages must all carry a stable `id` (UUID) so a later compaction
	// entry can reference them via `firstKeptEntryId`.
	message: z.discriminatedUnion("role", [
		userMessageSchema,
		assistantMessageSchema,
		toolMessageSchema,
	]),
});

const compactionEntrySchema = z.object({
	kind: z.literal("compaction"),
	id: z.string().min(1),
	parentId: z.string().nullable(),
	timestamp: z.string().min(1),
	summary: z.string(),
	firstKeptEntryId: z.string().nullable(),
	tokensBefore: z.number().int().nonnegative().optional(),
	details: z
		.object({
			trigger: z.union([z.literal("token"), z.literal("force"), z.null()]),
			keptMessages: z.number().int().nonnegative(),
			summarizedMessages: z.number().int().nonnegative(),
			triggeredBy: z
				.enum(["soft_limit", "hard_limit", "token_estimate", "manual"])
				.optional(),
			customInstructions: z.string().min(1).optional(),
		})
		.optional(),
});

const sessionEntrySchema = z.discriminatedUnion("kind", [
	messageEntrySchema,
	compactionEntrySchema,
]);

const persistedSessionSchema = z.object({
	version: z.literal(SESSION_VERSION),
	sessionId: z.string().uuid(),
	title: z.string().nullable(),
	createdAt: z.string().min(1),
	updatedAt: z.string().min(1),
	cwd: z.string().min(1),
	systemPromptFingerprint: z.string().min(1),
	loadedSkillNames: z.array(z.string().min(1)),
	skillsFingerprint: z.string().nullable(),
	entries: z.array(sessionEntrySchema),
	explorationLedger: explorationLedgerSchema.optional(),
	turnCount: z.number().int().nonnegative(),
	lastCompletedUserInput: z.string().nullable(),
	status: sessionStatusSchema,
	lastTurn: sessionTurnRecordSchema.nullable(),
	turns: z.array(sessionTurnHistoryEntrySchema),
});

const sessionHeaderSchema = persistedSessionSchema
	.omit({ entries: true })
	.extend({ persistedEntryCount: z.number().int().nonnegative() });

const sessionSummarySchema = z.object({
	sessionId: z.string().uuid(),
	title: z.string().nullable(),
	lastCompletedUserInput: z.string().nullable().optional(),
	updatedAt: z.string().min(1),
	status: sessionStatusSchema,
	cwd: z.string().min(1),
	turnCount: z.number().int().nonnegative(),
	lastTurnStatus: turnStatusSchema.nullable(),
	estimatedTokens: z.number().int().nonnegative().nullable().optional(),
});

const sessionIndexSchema = z.object({
	version: z.literal(SESSION_VERSION),
	sessions: z.array(sessionSummarySchema),
});

export class SessionStore {
	private readonly cwd: string;
	private readonly rootDir: string;
	private readonly indexPath: string;
	private readonly storagePaths: SessionStoragePaths;
	private readonly logger?: RuntimeLogger;

	constructor(args: {
		storagePaths: SessionStoragePaths;
		logger?: RuntimeLogger;
	}) {
		this.cwd = args.storagePaths.cwd;
		this.rootDir = args.storagePaths.sessionsDir;
		this.indexPath = args.storagePaths.indexPath;
		this.storagePaths = args.storagePaths;
		this.logger = args.logger;
	}

	async createSession(args: {
		cwd: string;
		systemPromptFingerprint: string;
		title?: string;
		loadedSkillNames?: string[];
		skillsFingerprint?: string | null;
	}): Promise<PersistedSession> {
		const now = formatLocalTimestamp(new Date());
		const session: PersistedSession = {
			version: SESSION_VERSION,
			sessionId: randomUUID(),
			title: normalizeTitle(args.title),
			createdAt: now,
			updatedAt: now,
			cwd: path.resolve(args.cwd),
			systemPromptFingerprint: args.systemPromptFingerprint,
			loadedSkillNames: [...(args.loadedSkillNames ?? [])],
			skillsFingerprint: args.skillsFingerprint ?? null,
			entries: [],
			explorationLedger: undefined,
			turnCount: 0,
			lastCompletedUserInput: null,
			status: "active",
			lastTurn: null,
			turns: [],
		};

		await this.writeSession(session);
		await this.writeIndex(
			await this.upsertSummary(await this.readIndex(), session),
		);
		return session;
	}

	async loadSession(args: {
		sessionId: string;
		cwd: string;
		systemPromptFingerprint: string;
		loadedSkillNames?: string[];
		skillsFingerprint?: string | null;
	}): Promise<LoadedSession> {
		const session = await this.readSession(args.sessionId);
		const warnings: string[] = [];

		if (path.resolve(args.cwd) !== path.resolve(session.cwd)) {
			throw new Error(
				`Session ${args.sessionId} was created for ${session.cwd}, not ${path.resolve(args.cwd)}.`,
			);
		}

		let normalized = session;

		if (session.lastTurn?.status === "in_progress") {
			const interruptedAt = formatLocalTimestamp(new Date());
			const turnId = nextTurnId(session.turns);
			normalized = {
				...session,
				updatedAt: interruptedAt,
				status: "interrupted",
				lastTurn: {
					...session.lastTurn,
					status: "interrupted",
					finishedAt: session.lastTurn.finishedAt ?? interruptedAt,
					errorMessage:
						session.lastTurn.errorMessage ??
						"Session resumed after interruption.",
					interruptSource: "process_recovery",
					interruptStage: null,
				},
				turns: [
					...session.turns,
					{
						turnId,
						startedAt: session.lastTurn.startedAt,
						finishedAt: session.lastTurn.finishedAt ?? interruptedAt,
						status: "interrupted",
						userInput: session.lastTurn.userInput,
						assistantOutput: session.lastTurn.assistantOutput,
						steps: 0,
						toolExecutions: [],
						errorMessage:
							session.lastTurn.errorMessage ??
							"Session resumed after interruption.",
						interruptSource: "process_recovery",
						interruptStage: null,
					},
				],
			};
			warnings.push(
				"Previous run was interrupted. Restored the last completed turn only; re-run the unfinished request manually.",
			);
			await this.writeSession(normalized);
			await this.writeIndex(
				await this.upsertSummary(await this.readIndex(), normalized),
			);
		}

		if (normalized.systemPromptFingerprint !== args.systemPromptFingerprint) {
			warnings.push(
				"System prompt has changed since this session was created.",
			);
		}

		if (
			args.loadedSkillNames !== undefined ||
			args.skillsFingerprint !== undefined
		) {
			const currentSkillNames = [...(args.loadedSkillNames ?? [])].sort();
			const savedSkillNames = [...normalized.loadedSkillNames].sort();
			if (normalized.skillsFingerprint !== (args.skillsFingerprint ?? null)) {
				warnings.push("Loaded skills changed since this session was created.");
			} else if (
				JSON.stringify(savedSkillNames) !== JSON.stringify(currentSkillNames)
			) {
				warnings.push(
					"Loaded skill names changed since this session was created.",
				);
			}
		}

		return { session: normalized, warnings };
	}

	async listSessions(): Promise<SessionSummary[]> {
		const index = await this.readIndex();
		return [...index.sessions].sort((left, right) =>
			compareTimestampDescending(left.updatedAt, right.updatedAt),
		);
	}

	async getSession(sessionId: string): Promise<PersistedSession> {
		return this.readSession(sessionId);
	}

	async pruneEmptySessions(): Promise<number> {
		const index = await this.readIndex();
		const removableIds = new Set<string>();

		for (const summary of index.sessions) {
			if (summary.turnCount !== 0) {
				continue;
			}

			try {
				const session = await this.readSession(summary.sessionId);
				if (isEmptySession(session)) {
					removableIds.add(summary.sessionId);
				}
			} catch (error) {
				if (isMissingFile(error) || error instanceof LegacySessionError) {
					if (error instanceof LegacySessionError) {
						// Orphaned legacy session: leave the file on disk, skip it.
						continue;
					}
					removableIds.add(summary.sessionId);
					continue;
				}
				throw error;
			}
		}

		if (removableIds.size === 0) {
			return 0;
		}

		for (const sessionId of removableIds) {
			await this.deleteSessionFile(sessionId);
		}

		await this.writeIndex({
			version: SESSION_VERSION,
			sessions: index.sessions.filter(
				(session) => !removableIds.has(session.sessionId),
			),
		});

		return removableIds.size;
	}

	async markTurnStarted(args: {
		sessionId: string;
		userInput: string;
	}): Promise<PersistedSession> {
		const session = await this.readSession(args.sessionId);
		const startedAt = formatLocalTimestamp(new Date());
		const updated: PersistedSession = {
			...session,
			updatedAt: startedAt,
			status: "active",
			lastTurn: {
				startedAt,
				finishedAt: null,
				status: "in_progress",
				userInput: args.userInput,
				assistantOutput: null,
				toolExecutionCount: 0,
				interruptSource: null,
				interruptStage: null,
			},
		};

		return this.commit(updated);
	}

	async markTurnCompleted(args: {
		sessionId: string;
		userInput: string;
		assistantOutput: string;
		steps: number;
		toolExecutions: ExecutedToolCall[];
		contextState: ConversationContextState;
	}): Promise<PersistedSession> {
		const session = await this.readSession(args.sessionId);
		const finishedAt = formatLocalTimestamp(new Date());
		const title = session.title ?? deriveTitle(args.userInput);
		const startedAt = session.lastTurn?.startedAt ?? finishedAt;
		const turnId = nextTurnId(session.turns);
		const entries = resolveEntriesForPersist({
			session,
			contextState: args.contextState,
			timestamp: finishedAt,
		});
		const updated: PersistedSession = {
			...session,
			title,
			updatedAt: finishedAt,
			entries,
			explorationLedger: args.contextState.explorationLedger,
			turnCount: session.turnCount + 1,
			lastCompletedUserInput: args.userInput,
			status: "active",
			lastTurn: {
				startedAt,
				finishedAt,
				status: "completed",
				userInput: args.userInput,
				assistantOutput: args.assistantOutput,
				toolExecutionCount: args.toolExecutions.length,
				errorMessage: null,
				interruptSource: null,
				interruptStage: null,
			},
			turns: [
				...session.turns,
				{
					turnId,
					startedAt,
					finishedAt,
					status: "completed",
					userInput: args.userInput,
					assistantOutput: args.assistantOutput,
					steps: args.steps,
					toolExecutions: args.toolExecutions,
					errorMessage: null,
					interruptSource: null,
					interruptStage: null,
				},
			],
		};

		return this.commit(updated);
	}

	async updateSnapshot(args: {
		sessionId: string;
		contextState: ConversationContextState;
	}): Promise<PersistedSession> {
		const session = await this.readSession(args.sessionId);
		const updatedAt = formatLocalTimestamp(new Date());
		const entries = resolveEntriesForPersist({
			session,
			contextState: args.contextState,
			timestamp: updatedAt,
		});
		const updated: PersistedSession = {
			...session,
			updatedAt,
			entries,
			explorationLedger: args.contextState.explorationLedger,
		};

		return this.commit(updated);
	}

	async markTurnFailed(args: {
		sessionId: string;
		userInput: string;
		errorMessage: string;
		assistantOutput?: string | null;
		steps?: number;
		toolExecutions?: ExecutedToolCall[];
		contextState?: ConversationContextState;
	}): Promise<PersistedSession> {
		const session = await this.readSession(args.sessionId);
		const finishedAt = formatLocalTimestamp(new Date());
		const startedAt = session.lastTurn?.startedAt ?? finishedAt;
		const userInput = session.lastTurn?.userInput ?? args.userInput;
		const assistantOutput =
			args.assistantOutput ?? session.lastTurn?.assistantOutput ?? null;
		const toolExecutionCount =
			args.toolExecutions?.length ?? session.lastTurn?.toolExecutionCount ?? 0;
		const turnId = nextTurnId(session.turns);
		const entries = resolveEntriesForPersist({
			session,
			contextState: args.contextState,
			timestamp: finishedAt,
		});
		const updated: PersistedSession = {
			...session,
			updatedAt: finishedAt,
			entries,
			explorationLedger:
				args.contextState?.explorationLedger ?? session.explorationLedger,
			status: "active",
			lastTurn: session.lastTurn
				? {
						...session.lastTurn,
						finishedAt,
						status: "failed",
						userInput,
						assistantOutput,
						toolExecutionCount,
						errorMessage: args.errorMessage,
						interruptSource: null,
						interruptStage: null,
					}
				: {
						startedAt,
						finishedAt,
						status: "failed",
						userInput,
						assistantOutput,
						toolExecutionCount,
						errorMessage: args.errorMessage,
						interruptSource: null,
						interruptStage: null,
					},
			turns: [
				...session.turns,
				{
					turnId,
					startedAt,
					finishedAt,
					status: "failed",
					userInput,
					assistantOutput,
					steps: args.steps ?? 0,
					toolExecutions: args.toolExecutions ?? [],
					errorMessage: args.errorMessage,
					interruptSource: null,
					interruptStage: null,
				},
			],
		};

		return this.commit(updated);
	}

	async markTurnInterrupted(args: {
		sessionId: string;
		userInput: string;
		steps?: number;
		toolExecutions?: ExecutedToolCall[];
		contextState?: ConversationContextState;
		assistantOutput?: string | null;
		interruptSource: InterruptSource;
		interruptStage: InterruptStage;
	}): Promise<PersistedSession> {
		const session = await this.readSession(args.sessionId);
		const finishedAt = formatLocalTimestamp(new Date());
		const startedAt = session.lastTurn?.startedAt ?? finishedAt;
		const userInput = session.lastTurn?.userInput ?? args.userInput;
		const toolExecutionCount =
			args.toolExecutions?.length ?? session.lastTurn?.toolExecutionCount ?? 0;
		const assistantOutput = args.assistantOutput ?? null;
		const turnId = nextTurnId(session.turns);
		const entries = resolveEntriesForPersist({
			session,
			contextState: args.contextState,
			timestamp: finishedAt,
		});
		const updated: PersistedSession = {
			...session,
			updatedAt: finishedAt,
			entries,
			explorationLedger:
				args.contextState?.explorationLedger ?? session.explorationLedger,
			status: "interrupted",
			lastTurn: {
				startedAt,
				finishedAt,
				status: "interrupted",
				userInput,
				assistantOutput,
				toolExecutionCount,
				errorMessage: null,
				interruptSource: args.interruptSource,
				interruptStage: args.interruptStage,
			},
			turns: [
				...session.turns,
				{
					turnId,
					startedAt,
					finishedAt,
					status: "interrupted",
					userInput,
					assistantOutput,
					steps: args.steps ?? 0,
					toolExecutions: args.toolExecutions ?? [],
					errorMessage: null,
					interruptSource: args.interruptSource,
					interruptStage: args.interruptStage,
				},
			],
		};

		return this.commit(updated);
	}

	private async readSession(sessionId: string): Promise<PersistedSession> {
		const metaFile = this.metaPath(sessionId);
		if (!(await pathExists(metaFile))) {
			if (await pathExists(this.legacyPath(sessionId))) {
				throw new LegacySessionError(
					`Session ${sessionId} is in the legacy single-file (.json) format, which is no longer supported. Start a new session, or clear the old session files in ${this.rootDir}.`,
				);
			}
			throw new Error(`Session ${sessionId} not found at ${metaFile}`);
		}

		const metaRaw = await readFile(metaFile, "utf8");
		const metaParsed = sessionHeaderSchema.safeParse(
			JSON.parse(metaRaw) as unknown,
		);
		if (!metaParsed.success) {
			throw new Error(
				`Session ${sessionId} header is invalid: ${metaParsed.error.message}`,
			);
		}

		const { entries, trailingTorn } = await this.readTranscript(
			this.transcriptPath(sessionId),
		);

		// Self-heal a torn trailing line: the persisted entry count must always
		// match the number of valid transcript lines we actually read.
		if (
			trailingTorn ||
			metaParsed.data.persistedEntryCount !== entries.length
		) {
			await writeJsonAtomic(metaFile, {
				...metaParsed.data,
				persistedEntryCount: entries.length,
			});
		}

		const { persistedEntryCount: _omit, ...headerFields } = metaParsed.data;
		return normalizePersistedSessionTimestamps({
			...headerFields,
			entries,
		} as PersistedSession);
	}

	private async commit(session: PersistedSession): Promise<PersistedSession> {
		await this.writeSession(session);
		await this.writeIndex(
			await this.upsertSummary(await this.readIndex(), session),
		);
		return session;
	}

	private async writeSession(session: PersistedSession): Promise<void> {
		await this.ensureSessionRootDir();
		const prevCount = await this.readPersistedEntryCount(session.sessionId);
		const entries = session.entries ?? [];
		if (entries.length < prevCount) {
			throw new Error(
				`Session ${session.sessionId} lost entries (${entries.length} < ${prevCount}); refusing to persist a regressed transcript.`,
			);
		}
		const delta = entries.slice(prevCount);
		if (delta.length > 0) {
			await appendTranscriptLines(
				this.transcriptPath(session.sessionId),
				delta,
			);
		}
		await writeJsonAtomic(
			this.metaPath(session.sessionId),
			toHeader(session, prevCount + delta.length),
		);
	}

	private async readPersistedEntryCount(sessionId: string): Promise<number> {
		const metaFile = this.metaPath(sessionId);
		if (!(await pathExists(metaFile))) {
			return 0;
		}
		try {
			const parsed = sessionHeaderSchema.safeParse(
				JSON.parse(await readFile(metaFile, "utf8")) as unknown,
			);
			if (parsed.success) {
				return parsed.data.persistedEntryCount;
			}
		} catch {
			// fall through to 0
		}
		return 0;
	}

	private async readIndex(): Promise<{
		version: 4;
		sessions: SessionSummary[];
	}> {
		return this.readIndexFile();
	}

	private async writeIndex(index: {
		version: 4;
		sessions: SessionSummary[];
	}): Promise<void> {
		await this.ensureSessionRootDir();
		await writeJsonAtomic(this.indexPath, index);
	}

	private async upsertSummary(
		index: { version: 4; sessions: SessionSummary[] },
		session: PersistedSession,
	): Promise<{ version: 4; sessions: SessionSummary[] }> {
		const summary = toSessionSummary(session);
		const remaining = index.sessions.filter(
			(entry) => entry.sessionId !== session.sessionId,
		);
		return {
			version: SESSION_VERSION,
			sessions: [...remaining, summary].sort((left, right) =>
				compareTimestampDescending(left.updatedAt, right.updatedAt),
			),
		};
	}

	private metaPath(sessionId: string): string {
		return path.join(this.rootDir, `${sessionId}.meta.json`);
	}

	private transcriptPath(sessionId: string): string {
		return path.join(this.rootDir, `${sessionId}.jsonl`);
	}

	private legacyPath(sessionId: string): string {
		return path.join(this.rootDir, `${sessionId}.json`);
	}

	private async ensureSessionRootDir(): Promise<void> {
		await mkdir(this.rootDir, { recursive: true });
	}

	private async readTranscript(
		filePath: string,
	): Promise<{ entries: SessionEntry[]; trailingTorn: boolean }> {
		if (!(await pathExists(filePath))) {
			return { entries: [], trailingTorn: false };
		}
		const raw = await readFile(filePath, "utf8");
		const lines = raw.split("\n");
		const entries: SessionEntry[] = [];
		let trailingTorn = false;
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i];
			if (line.trim() === "") {
				// A trailing empty line is the normal artifact of a file ending in
				// "\n". Any other blank line is unexpected corruption.
				if (i === lines.length - 1) {
					continue;
				}
				throw new Error(
					`Session transcript ${filePath} is corrupt at line ${i + 1}`,
				);
			}
			let parsedJson: unknown;
			let parseError: unknown = null;
			try {
				parsedJson = JSON.parse(line);
			} catch (error) {
				parseError = error;
			}
			if (parseError) {
				if (i === lines.length - 1) {
					trailingTorn = true;
					break;
				}
				throw new Error(
					`Session transcript ${filePath} is corrupt at line ${i + 1}`,
				);
			}
			if (parsedJson === null) {
				if (i === lines.length - 1) {
					trailingTorn = true;
					break;
				}
				throw new Error(
					`Session transcript ${filePath} is corrupt at line ${i + 1}`,
				);
			}
			const parsed = sessionEntrySchema.safeParse(parsedJson);
			if (!parsed.success) {
				// Only the final line may be a torn (partial) append; an interior
				// parse failure indicates real corruption.
				if (i === lines.length - 1) {
					trailingTorn = true;
					break;
				}
				throw new Error(
					`Session transcript ${filePath} is corrupt at line ${i + 1}`,
				);
			}
			entries.push(parsed.data);
		}
		return { entries, trailingTorn };
	}

	private async readIndexFile(): Promise<{
		version: 4;
		sessions: SessionSummary[];
	}> {
		try {
			const raw = await readFile(this.indexPath, "utf8");
			const parsed = sessionIndexSchema.safeParse(JSON.parse(raw));

			if (!parsed.success) {
				throw new Error(parsed.error.message);
			}

			return {
				version: parsed.data.version,
				sessions: parsed.data.sessions.map((session) =>
					normalizeSessionSummaryTimestamps({
						...session,
						lastCompletedUserInput: session.lastCompletedUserInput ?? null,
						estimatedTokens: session.estimatedTokens ?? null,
					}),
				),
			};
		} catch (error) {
			if (isMissingFile(error)) {
				return { version: SESSION_VERSION, sessions: [] };
			}

			throw new Error(
				`Session index is invalid: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async deleteSessionFile(sessionId: string): Promise<void> {
		await this.removeSessionFiles(sessionId);
	}

	private async removeSessionFiles(sessionId: string): Promise<void> {
		for (const file of [
			this.metaPath(sessionId),
			this.transcriptPath(sessionId),
		]) {
			try {
				await unlink(file);
			} catch (error) {
				if (!isMissingFile(error)) {
					throw error;
				}
			}
		}
	}
}

export function sessionToContextState(
	session: PersistedSession,
): ConversationContextState {
	const derived = deriveContextStateFromEntries(session.entries);
	const state: ConversationContextState = {
		summary: derived.summary,
		recentMessages: derived.recentMessages,
	};
	if (session.explorationLedger) {
		state.explorationLedger = session.explorationLedger;
	}
	if (session.entries.length > 0) {
		state.entries = session.entries;
	}
	return state;
}

/**
 * Resolve the entries stream to persist for a write. When the caller hands us
 * a `contextState.entries`, we trust it (the conversation context is the
 * authoritative source for the entry stream). Otherwise we synthesize a
 * stream from `{summary, recentMessages}` so callers that haven't migrated
 * to entry-stream-aware contexts (e.g. tests or legacy code paths) still
 * produce a valid v4 session on disk.
 */
export function createSystemPromptFingerprint(systemPrompt: string): string {
	return createHash("sha256").update(systemPrompt).digest("hex");
}

function toSessionSummary(session: PersistedSession): SessionSummary {
	return {
		sessionId: session.sessionId,
		title: session.title,
		lastCompletedUserInput: session.lastCompletedUserInput,
		updatedAt: session.updatedAt,
		status: session.status,
		cwd: session.cwd,
		turnCount: session.turnCount,
		lastTurnStatus: session.lastTurn?.status ?? null,
		estimatedTokens: estimateSessionTokens(session),
	};
}

function estimateSessionTokens(session: PersistedSession): number {
	let total = 0;
	for (const entry of session.entries) {
		if (entry.kind !== "message") {
			continue;
		}
		const message = entry.message;
		total += estimateMessageTokens(message);
		if (message.role === "assistant" && message.toolCalls) {
			for (const call of message.toolCalls) {
				total += estimateMessageTokens({
					role: "user",
					content: call.rawArguments,
				});
			}
		}
	}
	return total;
}

function normalizePersistedSessionTimestamps(
	session: PersistedSession,
): PersistedSession {
	return {
		...session,
		createdAt: normalizeTimestampString(session.createdAt),
		updatedAt: normalizeTimestampString(session.updatedAt),
		lastTurn: session.lastTurn
			? {
					...session.lastTurn,
					startedAt: normalizeTimestampString(session.lastTurn.startedAt),
					finishedAt: session.lastTurn.finishedAt
						? normalizeTimestampString(session.lastTurn.finishedAt)
						: null,
				}
			: null,
		turns: session.turns.map((turn) => ({
			...turn,
			startedAt: normalizeTimestampString(turn.startedAt),
			finishedAt: turn.finishedAt
				? normalizeTimestampString(turn.finishedAt)
				: null,
		})),
	};
}

function normalizeSessionSummaryTimestamps(
	session: SessionSummary,
): SessionSummary {
	return {
		...session,
		updatedAt: normalizeTimestampString(session.updatedAt),
	};
}

function normalizeTitle(title: string | undefined): string | null {
	const trimmed = title?.trim();
	return trimmed ? trimmed : null;
}

function deriveTitle(userInput: string): string {
	const normalized = userInput.replace(/\s+/gu, " ").trim();
	return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`;
}

function nextTurnId(turns: PersistedSession["turns"]): number {
	return (turns.at(-1)?.turnId ?? 0) + 1;
}

function isEmptySession(session: PersistedSession): boolean {
	if (
		session.turnCount !== 0 ||
		session.turns.length !== 0 ||
		session.lastTurn !== null ||
		session.entries.length !== 0 ||
		session.lastCompletedUserInput !== null
	) {
		return false;
	}
	const { summary, recentMessages } = deriveContextStateFromEntries(
		session.entries,
	);
	return summary === null && recentMessages.length === 0;
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

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath);
		return true;
	} catch (error) {
		if (isMissingFile(error)) {
			return false;
		}
		throw error;
	}
}

function toHeader(
	session: PersistedSession,
	count: number,
): Record<string, unknown> {
	const { entries: _entries, ...rest } = session;
	return { ...rest, persistedEntryCount: count };
}

async function appendTranscriptLines(
	filePath: string,
	entries: SessionEntry[],
): Promise<void> {
	if (entries.length === 0) {
		return;
	}
	await mkdir(path.dirname(filePath), { recursive: true });
	const data = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
	await appendFile(filePath, data, "utf8");
}

class LegacySessionError extends Error {}

async function writeJsonAtomic(
	filePath: string,
	value: unknown,
): Promise<void> {
	const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tempPath, filePath);
}

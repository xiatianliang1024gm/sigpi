import { randomUUID } from "node:crypto";
import type {
	CompactionEntry,
	ContextUpdateResult,
	ConversationContextState,
	Message,
	MessageEntry,
	PersistedSession,
	SessionEntry,
} from "../types.js";

/**
 * Convert a persisted `entries` stream back into the legacy
 * `{summary, recentMessages}` pair used by `ConversationContext`. The last
 * `compaction` entry (if any) provides `summary`; everything after its
 * `firstKeptEntryId` is the live `recentMessages` window. When there is no
 * compaction entry, every message entry is live and `summary` is null.
 */
export function deriveContextStateFromEntries(entries: SessionEntry[]): {
	summary: string | null;
	recentMessages: Message[];
} {
	let lastCompaction: CompactionEntry | null = null;
	let lastCompactionIndex = -1;
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		if (entry && entry.kind === "compaction") {
			lastCompaction = entry;
			lastCompactionIndex = i;
		}
	}

	if (!lastCompaction) {
		const recentMessages: Message[] = [];
		for (const entry of entries) {
			if (entry.kind === "message") {
				recentMessages.push(entry.message);
			}
		}
		return { summary: null, recentMessages };
	}

	const recentMessages: Message[] = [];
	let firstKeptSeen = lastCompaction.firstKeptEntryId === null;
	for (let i = lastCompactionIndex + 1; i < entries.length; i += 1) {
		const entry = entries[i];
		if (!entry || entry.kind !== "message") {
			continue;
		}
		if (!firstKeptSeen) {
			if (entry.id === lastCompaction.firstKeptEntryId) {
				firstKeptSeen = true;
			} else {
				continue;
			}
		}
		recentMessages.push(entry.message);
	}
	return {
		summary: lastCompaction.summary,
		recentMessages,
	};
}

/**
 * Build a fresh `entries` stream that represents the given context state.
 * Used when callers hand us only `{summary, recentMessages}` (e.g. legacy
 * callers or tests that don't maintain the entry stream themselves). The
 * resulting stream contains exactly one synthetic `compaction` entry whose
 * `firstKeptEntryId` points at the first message entry; if no summary and
 * no messages are supplied, an empty stream is returned.
 */
export function buildEntriesFromContextState(args: {
	summary: string | null;
	recentMessages: Message[];
	timestamp?: string;
}): SessionEntry[] {
	const timestamp = args.timestamp ?? new Date().toISOString();
	const messageEntries: MessageEntry[] = args.recentMessages.map(
		(message): MessageEntry => {
			const id = message.id ?? randomUUID();
			return {
				kind: "message",
				id,
				turnId: null,
				timestamp,
				message: withMessageId(message, id),
			};
		},
	);

	if (!args.summary && messageEntries.length === 0) {
		return [];
	}

	if (!args.summary) {
		return messageEntries;
	}

	const firstKeptEntryId = messageEntries[0]?.id ?? null;
	const compactionEntry: CompactionEntry = {
		kind: "compaction",
		id: `compaction-${randomUUID()}`,
		parentId: null,
		timestamp,
		summary: args.summary,
		firstKeptEntryId,
		details: {
			trigger: null,
			keptMessages: messageEntries.length,
			summarizedMessages: 0,
			triggeredBy: "manual",
		},
	};
	return [compactionEntry, ...messageEntries];
}

/**
 * Replace the tail of an entries stream to reflect new compaction state.
 * Returns a new array — does not mutate the input. Caller appends the
 * resulting compaction entry after `messagesToSummarize` are removed from
 * the kept set.
 */
export function appendCompactionEntry(args: {
	entries: SessionEntry[];
	summary: string;
	firstKeptEntryId: string | null;
	tokensBefore?: number;
	timestamp?: string;
	trigger?: ContextUpdateResult["trigger"];
	keptMessages: number;
	summarizedMessages: number;
	triggeredBy?: "soft_limit" | "hard_limit" | "token_estimate" | "manual";
	customInstructions?: string;
}): SessionEntry[] {
	const timestamp = args.timestamp ?? new Date().toISOString();
	const compactionEntry: CompactionEntry = {
		kind: "compaction",
		id: `compaction-${randomUUID()}`,
		parentId: getLastCompactionId(args.entries),
		timestamp,
		summary: args.summary,
		firstKeptEntryId: args.firstKeptEntryId,
		tokensBefore: args.tokensBefore,
		details: {
			trigger: args.trigger ?? null,
			keptMessages: args.keptMessages,
			summarizedMessages: args.summarizedMessages,
			triggeredBy: args.triggeredBy ?? "manual",
			customInstructions: args.customInstructions,
		},
	};
	return [...args.entries, compactionEntry];
}

function getLastCompactionId(entries: SessionEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry && entry.kind === "compaction") {
			return entry.id;
		}
	}
	return null;
}

/**
 * Return a copy of `message` with its `id` field set to `id`. System messages
 * pass through unchanged (they never appear in persisted entries).
 */
function withMessageId(message: Message, id: string): Message {
	if (message.role === "system") {
		return message;
	}
	return { ...message, id } as Message;
}

/**
 * Append message entries for a turn's user input + assistant output + tool
 * results. Each message is required to have an `id` already (callers obtain
 * it via `randomUUID()` when constructing the message).
 */
export function appendMessageEntries(args: {
	entries: SessionEntry[];
	messages: Message[];
	turnId: number | null;
	timestamp?: string;
}): SessionEntry[] {
	const timestamp = args.timestamp ?? new Date().toISOString();
	const newEntries: MessageEntry[] = args.messages.map(
		(message): MessageEntry => {
			if (!message.id) {
				throw new Error(
					"appendMessageEntries requires every message to carry a stable id",
				);
			}
			return {
				kind: "message",
				id: message.id,
				turnId: args.turnId,
				timestamp,
				message,
			};
		},
	);
	return [...args.entries, ...newEntries];
}

export function formatSessionDetails(
	session: PersistedSession,
	recentTurnLimit: number = 3,
): {
	session: {
		sessionId: string;
		title: string | null;
		createdAt: string;
		updatedAt: string;
		cwd: string;
		status: PersistedSession["status"];
	};
	snapshot: {
		summary: string | null;
		recentMessageCount: number;
		turnCount: number;
		lastCompletedUserInput: string | null;
		lastTurn: PersistedSession["lastTurn"];
	};
	history: {
		totalTurns: number;
		recentTurns: Array<{
			status: PersistedSession["turns"][number]["status"];
			userInput: string;
			assistantOutput: string | null;
			toolExecutionCount: number;
			startedAt: string;
			finishedAt: string | null;
		}>;
	};
} {
	const { summary, recentMessages } = deriveContextStateFromEntries(
		session.entries,
	);
	return {
		session: {
			sessionId: session.sessionId,
			title: session.title,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			cwd: session.cwd,
			status: session.status,
		},
		snapshot: {
			summary,
			recentMessageCount: recentMessages.length,
			turnCount: session.turnCount,
			lastCompletedUserInput: session.lastCompletedUserInput,
			lastTurn: session.lastTurn,
		},
		history: {
			totalTurns: session.turns.length,
			recentTurns: session.turns.slice(-recentTurnLimit).map((turn) => ({
				status: turn.status,
				userInput: turn.userInput,
				assistantOutput: turn.assistantOutput,
				toolExecutionCount: turn.toolExecutions.length,
				startedAt: turn.startedAt,
				finishedAt: turn.finishedAt,
			})),
		},
	};
}

/**
 * Resolve the entry stream to persist for a session flush.
 *
 * The `ConversationContext` is the single owner of the entry stream on the
 * happy path: the runtime threads its cumulative `entries` and we persist
 * them directly. When no `contextState` is supplied at all, the caller owns
 * the stream and we leave `session.entries` untouched.
 *
 * Some legacy/test callers hand over only a `{summary, recentMessages}` pair
 * without maintaining the stream. There is exactly one sanctioned way to
 * (re)build an entry stream from that pair — `buildEntriesFromContextState`,
 * the same builder `hydrateState` uses — so persistence and hydration share a
 * single synthesis seam rather than each rolling their own merge.
 */
export function resolveEntriesForPersist(args: {
	session: PersistedSession;
	contextState: ConversationContextState | undefined;
	timestamp?: string;
}): SessionEntry[] {
	// No context involved: the caller owns the entry stream directly.
	if (!args.contextState) return args.session.entries;

	// The ConversationContext owns the entry stream on the happy path. Persist
	// its cumulative `entries` directly — the single authoritative source for
	// what was said this session.
	if (args.contextState.entries && args.contextState.entries.length > 0) {
		return args.contextState.entries;
	}

	// Legacy / test callers may hand over only `{summary, recentMessages}`
	// without maintaining the stream. Extend the persisted cumulative stream
	// with a freshly synthesized *window* built by the single sanctioned
	// builder `buildEntriesFromContextState` (the same one `hydrateState`
	// uses). This keeps the transcript append-only — persistence and hydration
	// now share one synthesis seam instead of each rolling their own merge.
	const base = args.session.entries ?? [];
	const window = buildEntriesFromContextState({
		summary: args.contextState.summary ?? null,
		recentMessages: args.contextState.recentMessages ?? [],
		timestamp: args.timestamp,
	});
	return [...base, ...window];
}

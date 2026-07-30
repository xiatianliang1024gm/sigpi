import { randomUUID } from "node:crypto";
import { estimateContextTokens } from "../context-window.js";
import {
	appendCompactionEntry,
	appendMessageEntries,
	buildEntriesFromContextState,
} from "../session/format.js";
import type {
	ContextBudget,
	ContextManagerOptions,
	ContextUpdateResult,
	ConversationContextState,
	Message,
	MessageEntry,
	ModelProvider,
	ModelUsage,
	SessionEntry,
	ToolCall,
	ToolExecutionResult,
	ToolSchema,
} from "../types.js";
import type { CompactionHookRegistry } from "./compaction-hook.js";
import {
	Compactor,
	type CompactorDeps,
	microCompactMessages,
} from "./compactor.js";

// Re-export for backwards compatibility (tests and potential consumers)
export { microCompactMessages };

import { createSystemMessage, createUserMessage } from "./messages.js";

const DEFAULT_CONTEXT_OPTIONS: ContextManagerOptions = {
	getContextBudget: () => ({
		hardContextLimit: 200_000,
		reserveTokens: 16_384,
		keepRecentTokens: 20_000,
	}),
	summaryEnabled: true,
	keepRecentMessagesFloor: 4,
};

export class ConversationContext {
	private readonly options: ContextManagerOptions;
	private readonly logger;
	private readonly runId;
	private readonly compactionHooks: CompactionHookRegistry | null;
	private sessionId;
	private summary: string | null = null;
	private recentMessages: Message[] = [];
	/**
	 * Flat entry stream backing this context. Kept in lockstep with
	 * `summary` + `recentMessages`: every appended message shows up as a
	 * `MessageEntry` here, and every successful compact appends a
	 * `CompactionEntry` whose `firstKeptEntryId` references the first
	 * surviving message entry. Persisted by the session store as the
	 * source of truth; `summary` / `recentMessages` are derived on demand.
	 */
	private entries: SessionEntry[] = [];
	/**
	 * The most recent provider-reported token usage for this conversation,
	 * together with the index in `recentMessages` of the assistant message
	 * that produced it. Used as the ground-truth baseline for token-based
	 * compact triggers; messages appended after `messageIndex` are added
	 * to `usage.totalTokens` via `estimateMessageTokens`.
	 *
	 * Becomes stale (and is cleared) whenever a compact drops the message
	 * at or before `messageIndex` from `recentMessages`.
	 */
	private lastUsage: { usage: ModelUsage; messageIndex: number } | null = null;
	private readonly compactor: Compactor;

	constructor(options: Partial<ContextManagerOptions> = {}) {
		this.options = { ...DEFAULT_CONTEXT_OPTIONS, ...options };
		this.logger = this.options.logger;
		this.runId = this.options.runId;
		this.compactionHooks = this.options.compactionHooks ?? null;
		this.sessionId = this.options.sessionId ?? null;

		const deps: CompactorDeps = {
			getSummary: () => this.summary,
			setSummary: (v) => {
				this.summary = v;
			},
			getRecentMessages: () => this.recentMessages,
			setRecentMessages: (v) => {
				this.recentMessages = v;
			},
			getEntries: () => this.entries,
			setEntries: (v) => {
				this.entries = v;
			},
			getLastUsage: () => this.lastUsage,
			setLastUsage: (v) => {
				this.lastUsage = v;
			},
			getKeepRecentMessagesFloor: () =>
				this.options.keepRecentMessagesFloor ??
				Compactor.DEFAULT_KEEP_RECENT_MESSAGES_FLOOR,
			isSummaryEnabled: () => this.options.summaryEnabled,
			getCompactionHooks: () => this.compactionHooks,
			getRunId: () => this.runId,
			getSessionId: () => this.sessionId,
			getLogger: () => this.logger,
			getBudget: () => this.getBudget(),
			estimateRequest: (...args) => this.estimateRequest(...args),
			recordCompactionEntry: (args) => this.recordCompaction(args),
		};
		this.compactor = new Compactor(deps);
	}

	bindSession(sessionId: string | null): void {
		this.sessionId = sessionId;
	}

	/**
	 * Record provider-reported token usage for the assistant message that
	 * just landed at `messageIndex` in `recentMessages`. Called by the
	 * runner after each model request so the context manager can compute
	 * token-based triggers with provider-reported ground truth instead of
	 * relying on the chars/4 heuristic.
	 */
	recordUsage(usage: ModelUsage, messageIndex: number): void {
		if (
			messageIndex < 0 ||
			messageIndex >= this.recentMessages.length ||
			this.recentMessages[messageIndex]?.role !== "assistant"
		) {
			return;
		}
		this.lastUsage = { usage, messageIndex };
	}

	buildMessages(systemPrompt: string, pendingUserInput?: string): Message[] {
		const messages: Message[] = [createSystemMessage(systemPrompt)];

		if (this.summary) {
			messages.push(
				createSystemMessage(
					`Conversation summary from earlier turns:\n${this.summary}`,
				),
			);
		}

		messages.push(...microCompactMessages(this.recentMessages));

		if (pendingUserInput) {
			messages.push(createUserMessage(pendingUserInput));
		}

		return messages;
	}

	async appendMessages(
		messages: Message[],
		provider: ModelProvider,
		systemPrompt: string,
		toolSchemas: readonly ToolSchema[],
		requestContext?: {
			turnId?: string;
		},
		options?: {
			/**
			 * Provider-reported usage for the assistant message at the tail
			 * of `messages` (or undefined if the provider did not report it).
			 * When provided, the next compact trigger can use this as the
			 * ground-truth token count instead of the chars/4 estimate.
			 */
			usage?: ModelUsage;
			abortSignal?: AbortSignal;
		},
	): Promise<ContextUpdateResult> {
		const tagged = ensureMessageIds(messages);
		this.recordMessages(tagged);
		this.recentMessages.push(...tagged);
		this.entries = appendMessageEntries({
			entries: this.entries,
			messages: tagged,
			turnId: parseTurnId(requestContext?.turnId),
			timestamp: new Date().toISOString(),
			usage: options?.usage,
		});

		if (options?.usage) {
			// The assistant message that produced `usage` is now the last
			// assistant message in `recentMessages` after the push above.
			let assistantIndex = -1;
			for (let i = this.recentMessages.length - 1; i >= 0; i -= 1) {
				if (this.recentMessages[i].role === "assistant") {
					assistantIndex = i;
					break;
				}
			}
			if (assistantIndex >= 0) {
				this.lastUsage = { usage: options.usage, messageIndex: assistantIndex };
			}
		}

		return this.compact(provider, systemPrompt, toolSchemas, requestContext, {
			abortSignal: options?.abortSignal,
		});
	}

	appendRecoveryMessages(
		messages: Message[],
		systemPrompt: string,
		toolSchemas: readonly ToolSchema[],
		requestContext?: {
			turnId?: string;
		},
	): ContextUpdateResult {
		const tagged = ensureMessageIds(messages);
		this.recordMessages(tagged);
		this.recentMessages.push(...tagged);
		this.entries = appendMessageEntries({
			entries: this.entries,
			messages: tagged,
			turnId: parseTurnId(requestContext?.turnId),
			timestamp: new Date().toISOString(),
		});
		// Recovery bypasses the model, so any prior usage no longer reflects
		// the recovered tail.
		this.lastUsage = null;

		const previousRecentMessageCount = this.recentMessages.length;
		const previousSummaryChars = this.summary?.length ?? 0;
		const estimated = this.estimateRequest(systemPrompt, toolSchemas);
		const trimmed = this.trimToHardLimit(
			systemPrompt,
			toolSchemas,
			requestContext,
		);

		return {
			summarized: false,
			trimmed,
			summary: this.summary,
			recentMessageCount: this.recentMessages.length,
			previousRecentMessageCount,
			summaryChars: this.summary?.length ?? 0,
			previousSummaryChars,
			tokensBefore: estimated.totalTokens,
			tokensAfter: this.estimateRequest(systemPrompt, toolSchemas).totalTokens,
			trigger: null,
		};
	}

	async compactNow(
		provider: ModelProvider,
		systemPrompt: string,
		toolSchemas: readonly ToolSchema[],
		requestContext?: {
			turnId?: string;
		},
		options?: {
			instructions?: string;
			abortSignal?: AbortSignal;
		},
	): Promise<ContextUpdateResult> {
		return this.compactor.compactNow(
			provider,
			systemPrompt,
			toolSchemas,
			requestContext,
			options,
		);
	}

	getSummary(): string | null {
		return this.summary;
	}

	getRecentMessages(): Message[] {
		return [...this.recentMessages];
	}

	recordToolExecution(_toolCall: ToolCall, _result: ToolExecutionResult): void {
		// No-op: exploration ledger has been removed.
	}

	getContextBudget(): ContextBudget {
		const budget = this.options.getContextBudget();
		return {
			hardContextLimit: budget.hardContextLimit ?? 200_000,
			reserveTokens: budget.reserveTokens ?? 16_384,
			keepRecentTokens: budget.keepRecentTokens ?? 20_000,
		};
	}

	getLastUsage(): { usage: ModelUsage; messageIndex: number } | null {
		return this.lastUsage ? { ...this.lastUsage } : null;
	}

	exportState(): ConversationContextState {
		return {
			summary: this.summary,
			recentMessages: [...this.recentMessages],
			entries: this.entries.map((entry) => ({ ...entry })),
		};
	}

	hydrateState(state: ConversationContextState): void {
		this.summary = state.summary;
		this.recentMessages = [...state.recentMessages];
		// Prefer the caller's entry stream when available. Otherwise rebuild
		// it from the legacy {summary, recentMessages} pair (one synthetic
		// compaction entry + one message entry per recent message) so older
		// callers without entry-stream awareness still get a coherent
		// persisted session.
		if (state.entries && state.entries.length > 0) {
			this.entries = state.entries.map((entry) => ({ ...entry }));
		} else {
			this.entries = buildEntriesFromContextState({
				summary: state.summary,
				recentMessages: state.recentMessages,
			});
		}
		// Restore the most recent provider-reported usage from the entry
		// stream so resumed sessions keep the ground-truth token count
		// instead of falling back to the chars/4 heuristic. We scan
		// `recentMessages` (not `entries`) because `lastUsage.messageIndex`
		// is an index into the live window.
		this.lastUsage = null;
		for (let i = this.recentMessages.length - 1; i >= 0; i -= 1) {
			const message = this.recentMessages[i];
			if (message?.role !== "assistant") {
				continue;
			}
			const entry = this.entries.find(
				(candidate): candidate is MessageEntry =>
					candidate.kind === "message" && candidate.id === message.id,
			);
			if (entry?.usage) {
				this.lastUsage = { usage: entry.usage, messageIndex: i };
				break;
			}
		}
	}

	reset(): void {
		this.summary = null;
		this.recentMessages = [];
		this.entries = [];
		this.lastUsage = null;
	}

	private recordMessages(_messages: readonly Message[]): void {
		// No-op: previously updated exploration ledger from messages.
	}

	private recordCompaction(args: {
		summarizedCount: number;
		trigger: ContextUpdateResult["trigger"];
		tokensBefore: number;
		customInstructions?: string;
	}): void {
		const firstKeptEntryId = this.recentMessages[0]?.id ?? null;
		const keptMessages = this.recentMessages.length;
		const triggeredBy: "token_estimate" | "manual" =
			args.trigger === "force" ? "manual" : "token_estimate";
		this.entries = appendCompactionEntry({
			entries: this.entries,
			summary: this.summary ?? "",
			firstKeptEntryId,
			tokensBefore: args.tokensBefore,
			trigger: args.trigger,
			keptMessages,
			summarizedMessages: args.summarizedCount,
			triggeredBy,
			customInstructions: args.customInstructions,
		});
	}

	private getBudget(): ContextBudget {
		return this.getContextBudget();
	}

	private estimateRequest(
		systemPrompt: string,
		toolSchemas: readonly ToolSchema[],
		pendingUserInput?: string,
	): {
		totalTokens: number;
		usedUsage: boolean;
		threshold?: number;
	} {
		const tokens = estimateContextTokens({
			systemPrompt,
			summary: this.summary,
			recentMessages: this.recentMessages,
			toolSchemas,
			pendingUserInput,
			lastUsage: this.lastUsage?.usage ?? null,
			lastUsageMessageIndex: this.lastUsage?.messageIndex ?? null,
		});

		const budget = this.getBudget();
		const threshold = Math.max(
			0,
			budget.hardContextLimit - budget.reserveTokens,
		);

		return {
			totalTokens: tokens.totalTokens,
			usedUsage: tokens.usedUsage,
			threshold,
		};
	}

	async compact(
		provider: ModelProvider,
		systemPrompt: string,
		toolSchemas: readonly ToolSchema[],
		requestContext?: {
			turnId?: string;
		},
		options?: {
			force?: boolean;
			instructions?: string;
			abortSignal?: AbortSignal;
		},
	): Promise<ContextUpdateResult> {
		return this.compactor.compact(
			provider,
			systemPrompt,
			toolSchemas,
			requestContext,
			options,
		);
	}

	private trimToHardLimit(
		systemPrompt: string,
		toolSchemas: readonly ToolSchema[],
		requestContext?: {
			turnId?: string;
		},
	): boolean {
		return this.compactor.trimToHardLimit(
			systemPrompt,
			toolSchemas,
			requestContext,
		);
	}
}

/**
 * Return a copy of each message with a stable `id` filled in if missing.
 * The same message object is reused when an id is already present so that
 * callers that hold a reference continue to see the same identity.
 */
function ensureMessageIds(messages: readonly Message[]): Message[] {
	return messages.map((message) => {
		if (message.role === "system") {
			return message;
		}
		if (message.id) {
			return message;
		}
		return { ...message, id: randomUUID() } as Message;
	});
}

function parseTurnId(raw: string | undefined): number | null {
	if (!raw) return null;
	const parsed = Number.parseInt(raw, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

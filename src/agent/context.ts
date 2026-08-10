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
	ToolSchema,
} from "../types.js";
import { decide, execute, microCompactMessages } from "./compaction.js";
import { CompactionFailedError } from "./compaction-error.js";

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

const DEFAULT_KEEP_RECENT_MESSAGES_FLOOR = 4;

export class ConversationContext {
	private readonly options: ContextManagerOptions;
	private readonly logger;
	private readonly runId;
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

	constructor(options: Partial<ContextManagerOptions> = {}) {
		this.options = { ...DEFAULT_CONTEXT_OPTIONS, ...options };
		this.logger = this.options.logger;
		this.runId = this.options.runId;
		this.sessionId = this.options.sessionId ?? null;
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

	/**
	 * Append messages to the context state. Pure append: compaction decisions
	 * are no longer made here (ADR 0026, D6 — `decide` runs once per request,
	 * immediately before each `generate`, never per append).
	 */
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
		const previousRecentMessageCount = this.recentMessages.length;
		const previousSummaryChars = this.summary?.length ?? 0;
		const tagged = ensureMessageIds(messages);
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

		const estimated = this.estimateRequest(systemPrompt, toolSchemas);

		return {
			summarized: false,
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

	/**
	 * Append recovery messages (e.g. synthetic tool results that close
	 * dangling tool calls after an interrupt) without any compaction side
	 * effects. Recovery bypasses the model, so any prior usage no longer
	 * reflects the recovered tail.
	 */
	appendRecoveryMessages(
		messages: Message[],
		systemPrompt: string,
		toolSchemas: readonly ToolSchema[],
		requestContext?: {
			turnId?: string;
		},
	): ContextUpdateResult {
		const previousRecentMessageCount = this.recentMessages.length;
		const previousSummaryChars = this.summary?.length ?? 0;
		const tagged = ensureMessageIds(messages);
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

		const estimated = this.estimateRequest(systemPrompt, toolSchemas);

		return {
			summarized: false,
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
		return this.compact(provider, systemPrompt, toolSchemas, requestContext, {
			force: true,
			instructions: options?.instructions,
			abortSignal: options?.abortSignal,
		});
	}

	getSummary(): string | null {
		return this.summary;
	}

	getRecentMessages(): Message[] {
		return [...this.recentMessages];
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

	private recordCompaction(args: {
		summarizedCount: number;
		trigger: ContextUpdateResult["trigger"];
		tokensBefore: number;
		tokensAfter?: number;
		customInstructions?: string;
		usage?: ModelUsage;
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
			tokensAfter: args.tokensAfter,
			trigger: args.trigger,
			keptMessages,
			summarizedMessages: args.summarizedCount,
			triggeredBy,
			customInstructions: args.customInstructions,
			usage: args.usage,
		});
	}

	/**
	 * Token snapshot of the current request shape using the best available
	 * information (provider-reported `lastUsage` when present, else the
	 * chars/4 heuristic). Used for `tokensBefore` / `tokensAfter` in
	 * compaction results; the *trigger* decision lives in `decide` (D6).
	 */
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

		const budget = this.getContextBudget();
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

	/**
	 * The single compaction path (ADR 0026, D2): a thin orchestrator around
	 * the two pure functions `decide` and `execute`. Called by the runner
	 * once per request when the estimate exceeds the soft limit, on a
	 * `context_length_exceeded` retry (force), and by `/compact` (force).
	 *
	 * 1. `decide` — pure threshold + split computation.
	 * 2. If `shouldCompact` and `splitIndex > 0`: `execute` (summarize) then
	 *    apply: set summary, slice recent messages, invalidate the usage
	 *    baseline, record a `CompactionEntry` (carrying `usage`, D7).
	 * 3. Post-compaction check (D6): re-estimates; if the window still
	 *    overflows the soft limit after a compaction ran, throws
	 *    `CompactionFailedError` with `reason: "insufficient_compaction"` —
	 *    the user fixes the configuration; nothing is silently dropped (D4).
	 */
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
			pendingUserInput?: string;
		},
	): Promise<ContextUpdateResult> {
		const previousRecentMessageCount = this.recentMessages.length;
		const previousSummaryChars = this.summary?.length ?? 0;
		const tokensBefore = this.estimateRequest(
			systemPrompt,
			toolSchemas,
		).totalTokens;
		let summarized = false;
		let summarizedCount = 0;
		let trigger: ContextUpdateResult["trigger"] = null;

		const budget = this.getContextBudget();
		const floor =
			this.options.keepRecentMessagesFloor ??
			DEFAULT_KEEP_RECENT_MESSAGES_FLOOR;
		const messages = [...this.recentMessages];

		const decision = decide({
			messages,
			budget,
			keepRecentFloor: floor,
			systemPrompt,
			toolSchemas,
			pendingUserInput: options?.pendingUserInput,
			force: options?.force,
		});

		let compactionInstructions: string | undefined;
		let newSummary: string | null = null;
		let newRecentMessages: Message[] = messages;
		let usage: ModelUsage | undefined;

		if (
			this.options.summaryEnabled &&
			decision.shouldCompact &&
			decision.splitIndex > 0
		) {
			trigger = options?.force ? "force" : "token";
			const messagesToSummarize = messages.slice(0, decision.splitIndex);
			const compactAbortController = new AbortController();
			const callerSignal = options?.abortSignal;
			if (callerSignal) {
				if (callerSignal.aborted) {
					compactAbortController.abort(callerSignal.reason);
				} else {
					callerSignal.addEventListener(
						"abort",
						() => compactAbortController.abort(callerSignal.reason),
						{ once: true },
					);
				}
			}
			this.logger?.info("context_summarization_started", {
				runId: this.runId,
				sessionId: this.sessionId,
				turnId: requestContext?.turnId,
				trigger,
				messageCount: messagesToSummarize.length,
				estimatedTokens: tokensBefore,
			});
			let result: { summary: string; usage?: ModelUsage };
			try {
				result = await execute({
					provider,
					systemPrompt,
					messages: messagesToSummarize,
					previousSummary: this.summary,
					instructions: options?.instructions,
					requestContext,
					reserveTokens: budget.reserveTokens,
					abortSignal: compactAbortController.signal,
				});
			} catch (error) {
				this.logger?.error("context_summarization_failed", {
					runId: this.runId,
					sessionId: this.sessionId,
					turnId: requestContext?.turnId,
					trigger,
					error: error instanceof Error ? error.message : String(error),
					messageCount: messagesToSummarize.length,
					estimatedTokens: tokensBefore,
				});
				// D4 — no fallback trimming: summarization failure is a hard
				// error the caller surfaces (the `/compact` command or the
				// runner's turn failure).
				if (error instanceof CompactionFailedError) {
					throw new CompactionFailedError(error.message, {
						reason: error.reason,
						trigger: trigger ?? "force",
					});
				}
				throw new CompactionFailedError(
					error instanceof Error ? error.message : String(error),
					{ reason: "summarize_error", trigger: trigger ?? "force" },
				);
			}
			newSummary = result.summary;
			newRecentMessages = messages.slice(decision.splitIndex);
			usage = result.usage;
			compactionInstructions = options?.instructions?.trim() || undefined;
			summarized = true;
			summarizedCount = messagesToSummarize.length;

			// D6 — post-compaction check: after a compaction ran, the live
			// window must fit the soft limit. An overflow here means the
			// configuration itself cannot fit (huge system prompt / tool
			// schemas / recent window), so surface it as a hard error instead
			// of silently dropping more messages or leaving it to the 400
			// path. The context is NOT mutated on failure: the caller retries
			// or the user fixes the configuration (D4).
			const recheck = decide({
				messages: newRecentMessages,
				budget,
				keepRecentFloor: floor,
				systemPrompt,
				toolSchemas,
				pendingUserInput: options?.pendingUserInput,
				force: false,
			});
			if (recheck.shouldCompact) {
				throw new CompactionFailedError(
					"The context still exceeds the soft limit after compaction. Increase hard_context_limit / reserve_tokens, reduce the system prompt or tool schemas, or start a new session.",
					{ reason: "insufficient_compaction", trigger: trigger ?? "force" },
				);
			}

			this.summary = newSummary;
			this.recentMessages = newRecentMessages;
			this.invalidateLastUsage();
			const tokensAfter = this.estimateRequest(
				systemPrompt,
				toolSchemas,
			).totalTokens;
			this.recordCompaction({
				summarizedCount,
				trigger,
				tokensBefore,
				tokensAfter,
				customInstructions: compactionInstructions,
				usage,
			});
			this.logger?.info("context_summarization_finished", {
				runId: this.runId,
				sessionId: this.sessionId,
				turnId: requestContext?.turnId,
				trigger,
				summaryChars: this.summary.length,
				remainingMessages: this.recentMessages.length,
				// D7 — audit data: the summarize call's provider-reported usage.
				// Recorded on the CompactionEntry too; never a lastUsage baseline.
				usageTokens: usage?.totalTokens ?? null,
			});
		}

		const tokensAfter = this.estimateRequest(
			systemPrompt,
			toolSchemas,
		).totalTokens;

		return {
			summarized,
			summary: this.summary,
			recentMessageCount: this.recentMessages.length,
			previousRecentMessageCount,
			summaryChars: this.summary?.length ?? 0,
			previousSummaryChars,
			tokensBefore,
			tokensAfter,
			trigger,
		};
	}

	/**
	 * Drop the provider-reported usage baseline after messages were removed
	 * from the recent window. A measured `totalTokens` covered the whole
	 * pre-compaction request, so it no longer reflects the shrunken window,
	 * and `messageIndex` is stale once the array has been sliced. Until the
	 * next model response re-records usage, the status bar, `/summary`, and
	 * the runner's in-turn estimate fall back to the chars/4 estimate — the
	 * same computation that produced `tokensAfter`.
	 *
	 * Also scrubs the pre-compaction `usage` off the kept messages' entries:
	 * those entries persist into the session stream, and `hydrateState`
	 * would otherwise restore the stale count on resume.
	 */
	private invalidateLastUsage(): void {
		this.lastUsage = null;
		const liveIds = new Set(
			this.recentMessages
				.map((message) => message.id)
				.filter((id): id is string => Boolean(id)),
		);
		this.entries = this.entries.map((entry) =>
			entry.kind === "message" && entry.usage && liveIds.has(entry.id)
				? { ...entry, usage: undefined }
				: entry,
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

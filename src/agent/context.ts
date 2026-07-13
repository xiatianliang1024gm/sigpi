import { randomUUID } from "node:crypto";
import {
	estimateContextTokens,
	estimateMessageTokens,
} from "../context-window.js";
import {
	appendCompactionEntry,
	appendMessageEntries,
	buildEntriesFromContextState,
} from "../session/format.js";
import type {
	ContextManagerOptions,
	ContextUpdateResult,
	ConversationContextState,
	ExplorationLedger,
	Message,
	ModelProvider,
	ModelUsage,
	SessionEntry,
	ToolCall,
	ToolExecutionResult,
	ToolMessage,
	ToolSchema,
} from "../types.js";
import { CompactionFailedError } from "./compaction-error.js";
import type { CompactionHookRegistry } from "./compaction-hook.js";
import {
	createEmptyExplorationLedger,
	normalizeExplorationLedger,
	renderExplorationState,
	updateLedgerFromMessages,
	updateLedgerFromToolExecution,
} from "./exploration-ledger.js";
import { createSystemMessage, createUserMessage } from "./messages.js";
import { summarize } from "./summarizer.js";

const DEFAULT_CONTEXT_OPTIONS: ContextManagerOptions = {
	contextWindow: 200_000,
	summaryEnabled: true,
	reserveTokens: 16_384,
	keepRecentTokens: 20_000,
	keepRecentMessagesFloor: 4,
};

const DEFAULT_KEEP_RECENT_MESSAGES_FLOOR = 4;

function defaultLedgerRecorder(
	_toolCall: ToolCall,
	_result: ToolExecutionResult,
	ledger: ExplorationLedger,
): ExplorationLedger {
	return ledger;
}

export class ConversationContext {
	private readonly options: ContextManagerOptions;
	private readonly logger;
	private readonly runId;
	private readonly compactionHooks: CompactionHookRegistry | null;
	private readonly ledgerRecorder: (
		toolCall: ToolCall,
		result: ToolExecutionResult,
		ledger: ExplorationLedger,
	) => ExplorationLedger;
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
	private explorationLedger: ExplorationLedger = createEmptyExplorationLedger();
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
		this.compactionHooks = this.options.compactionHooks ?? null;
		this.ledgerRecorder = this.options.ledgerRecorder ?? defaultLedgerRecorder;
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
			const activeGoal = extractSection(this.summary, "Goal");
			if (activeGoal) {
				messages.push(
					createSystemMessage(
						[
							`Active user task from the conversation summary: ${activeGoal}`,
							"If the user asks whether you remember your goal, purpose, objective, or task, answer with this active user task.",
							"Do not answer that question with your model identity, product identity, or general system role unless the user explicitly asks about your identity.",
						].join("\n"),
					),
				);
			}
		}

		const explorationState = renderExplorationState(this.explorationLedger);
		if (explorationState) {
			messages.push(
				createSystemMessage(
					`<exploration_ledger>\n${explorationState}\n</exploration_ledger>`,
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

	getExplorationLedger(): ExplorationLedger {
		return normalizeExplorationLedger(this.explorationLedger);
	}

	recordToolExecution(toolCall: ToolCall, result: ToolExecutionResult): void {
		let ledger = this.explorationLedger;
		if (this.ledgerRecorder) {
			ledger = this.ledgerRecorder(toolCall, result, ledger) ?? ledger;
		}
		this.explorationLedger = updateLedgerFromToolExecution(
			ledger,
			toolCall,
			result,
		);
	}

	getContextWindow(): number {
		return this.options.contextWindow;
	}

	getReserveTokens(): number {
		return this.options.reserveTokens ?? 16_384;
	}

	getLastUsage(): { usage: ModelUsage; messageIndex: number } | null {
		return this.lastUsage ? { ...this.lastUsage } : null;
	}

	exportState(): ConversationContextState {
		return {
			summary: this.summary,
			recentMessages: [...this.recentMessages],
			entries: this.entries.map((entry) => ({ ...entry })),
			explorationLedger: this.getExplorationLedger(),
		};
	}

	hydrateState(state: ConversationContextState): void {
		this.summary = state.summary;
		this.recentMessages = [...state.recentMessages];
		this.explorationLedger = normalizeExplorationLedger(
			state.explorationLedger,
		);
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
		// Hydrated sessions have no provider usage info available; fall back
		// to the chars/4 heuristic until the first model response reports it.
		this.lastUsage = null;
	}

	reset(): void {
		this.summary = null;
		this.recentMessages = [];
		this.entries = [];
		this.explorationLedger = createEmptyExplorationLedger();
		this.lastUsage = null;
	}

	private recordMessages(messages: readonly Message[]): void {
		this.explorationLedger = updateLedgerFromMessages(
			this.explorationLedger,
			messages,
		);
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

		let threshold: number | undefined;
		if (
			typeof this.options.contextWindow === "number" &&
			typeof this.options.reserveTokens === "number"
		) {
			threshold = Math.max(
				0,
				this.options.contextWindow - this.options.reserveTokens,
			);
		}

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
		const previousRecentMessageCount = this.recentMessages.length;
		const previousSummaryChars = this.summary?.length ?? 0;
		const estimatedBefore = this.estimateRequest(systemPrompt, toolSchemas);
		const tokensBefore = estimatedBefore.totalTokens;
		let summarized = false;
		let trimmed = false;
		let trigger: ContextUpdateResult["trigger"] = null;

		const tokenTriggered =
			typeof estimatedBefore.threshold === "number" &&
			estimatedBefore.totalTokens > estimatedBefore.threshold;
		const floor =
			this.options.keepRecentMessagesFloor ??
			DEFAULT_KEEP_RECENT_MESSAGES_FLOOR;
		// Force-driven compaction (e.g. `/compact` slash command) bypasses the
		// message-count floor so users can always shrink a chat on demand.
		const summarizable =
			this.options.summaryEnabled &&
			(options?.force || this.recentMessages.length > floor);

		if (summarizable && (options?.force || tokenTriggered)) {
			trigger = options?.force ? "force" : "token";
			const splitIndex = this.findCompactSplitIndex({
				trigger,
			});
			// Bridge the caller's AbortSignal (e.g. a /compact command
			// triggered with Ctrl-C in flight) into a single internal
			// AbortController so both the hook phase and the summary
			// provider call observe the same abort state. The signal is
			// created outside the `if (splitIndex > 0)` branch so it is
			// always available for downstream code paths.
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
			if (splitIndex > 0) {
				const messagesToSummarize = this.recentMessages.slice(0, splitIndex);
				if (messagesToSummarize.length > 0) {
					this.logger?.info("context_summarization_started", {
						runId: this.runId,
						sessionId: this.sessionId,
						turnId: requestContext?.turnId,
						trigger,
						messageCount: messagesToSummarize.length,
						estimatedTokens: estimatedBefore.totalTokens,
						tokenThreshold: estimatedBefore.threshold,
					});
					let hookOverride:
						| import("./compaction-hook.js").CompactionHookOverride
						| null = null;
					if (this.compactionHooks && this.compactionHooks.size > 0) {
						const preparation = {
							trigger: trigger ?? "force",
							tokensBefore,
							summarizedMessages: messagesToSummarize,
							keptMessages: this.recentMessages.slice(splitIndex),
							recentMessages: [...this.recentMessages],
							previousSummary: this.summary,
						};
						hookOverride = await this.compactionHooks.runHooks(
							preparation,
							compactAbortController.signal,
							(message, meta) =>
								this.logger?.warn(
									message,
									meta as Record<
										string,
										import("../types.js").JsonValue | undefined
									>,
								),
						);
						if (hookOverride === null) {
							this.logger?.info("context_summarization_cancelled_by_hook", {
								runId: this.runId,
								sessionId: this.sessionId,
								turnId: requestContext?.turnId,
								trigger,
							});
							return {
								summarized: false,
								trimmed: false,
								summary: this.summary,
								recentMessageCount: this.recentMessages.length,
								previousRecentMessageCount,
								summaryChars: previousSummaryChars,
								previousSummaryChars,
								tokensBefore,
								tokensAfter: estimatedBefore.totalTokens,
								trigger,
							};
						}
					}
					try {
						this.summary =
							hookOverride?.summary ??
							(await summarize(provider, {
								systemPrompt,
								messages: microCompactMessages(messagesToSummarize),
								previousSummary: this.summary,
								ledger: this.explorationLedger,
								instructions: options?.instructions,
								requestContext,
								reserveTokens: this.options.reserveTokens ?? 16_384,
								runId: this.runId,
								sessionId: this.sessionId ?? undefined,
								abortSignal: compactAbortController.signal,
							}));
						this.recentMessages = this.recentMessages.slice(splitIndex);
						this.recordCompaction({
							summarizedCount: messagesToSummarize.length,
							trigger,
							tokensBefore,
							customInstructions: options?.instructions?.trim() || undefined,
						});
						summarized = true;
						this.invalidateLastUsageAfterTrim();
						this.logger?.info("context_summarization_finished", {
							runId: this.runId,
							sessionId: this.sessionId,
							turnId: requestContext?.turnId,
							trigger,
							summaryChars: this.summary.length,
							remainingMessages: this.recentMessages.length,
						});
					} catch (error) {
						this.logger?.error("context_summarization_failed", {
							runId: this.runId,
							sessionId: this.sessionId,
							turnId: requestContext?.turnId,
							trigger,
							error: error instanceof Error ? error.message : String(error),
							messageCount: messagesToSummarize.length,
							estimatedTokens: estimatedBefore.totalTokens,
						});
						// No deterministic fallback (matches pi / Claude Code): the
						// caller decides how to degrade. Bound tokens first so a
						// summary outage can't grow the context unbounded, then
						// propagate a typed error for the runner / command to handle.
						this.trimToHardLimit(systemPrompt, toolSchemas, requestContext);
						this.invalidateLastUsageAfterTrim();
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
				}
			}
		}

		trimmed = this.trimToHardLimit(systemPrompt, toolSchemas, requestContext);

		const estimatedAfter = this.estimateRequest(systemPrompt, toolSchemas);

		return {
			summarized,
			trimmed,
			summary: this.summary,
			recentMessageCount: this.recentMessages.length,
			previousRecentMessageCount,
			summaryChars: this.summary?.length ?? 0,
			previousSummaryChars,
			tokensBefore,
			tokensAfter: estimatedAfter.totalTokens,
			trigger,
		};
	}

	private findCompactSplitIndex(args: {
		trigger: ContextUpdateResult["trigger"];
	}): number {
		const floor =
			this.options.keepRecentMessagesFloor ??
			DEFAULT_KEEP_RECENT_MESSAGES_FLOOR;
		const keepRecentTokens = this.options.keepRecentTokens ?? 20_000;
		const messageFloorIndex = alignSplitIndex(
			this.recentMessages,
			Math.max(1, this.recentMessages.length - floor),
		);

		// Token-based cut-point: walk backwards from the newest message,
		// accumulating tokens until `keepRecentTokens` is reached. Cut at
		// the nearest user / assistant boundary. This mirrors the algorithm
		// used by pi and avoids summarizing tokens that we explicitly want
		// to keep un-summarized.
		let tokenCutIndex = this.recentMessages.length;
		let accumulated = 0;
		for (let i = this.recentMessages.length - 1; i >= 0; i -= 1) {
			accumulated += estimateMessageTokens(this.recentMessages[i]);
			if (accumulated >= keepRecentTokens) {
				tokenCutIndex = alignSplitIndex(this.recentMessages, i);
				break;
			}
		}
		// When the budget can fit every message (e.g. very fresh
		// conversation or generous budget) only the pure-token trigger
		// may return 0 to signal "nothing to summarize yet". Forced
		// compaction is the user explicitly asking for it, so we cut at
		// the last user / assistant boundary and keep just the most recent
		// message group.
		if (tokenCutIndex >= this.recentMessages.length) {
			if (args.trigger === "token") {
				return 0;
			}
			return alignSplitIndex(
				this.recentMessages,
				Math.max(1, this.recentMessages.length - 1),
			);
		}
		// Always honor the message-count safety floor: never cut more
		// aggressively than the floor allows.
		return Math.min(tokenCutIndex, messageFloorIndex);
	}

	private invalidateLastUsageAfterTrim(): void {
		if (!this.lastUsage) {
			return;
		}
		if (this.lastUsage.messageIndex >= this.recentMessages.length) {
			this.lastUsage = null;
		}
	}

	private trimToHardLimit(
		systemPrompt: string,
		toolSchemas: readonly ToolSchema[],
		requestContext?: {
			turnId?: string;
		},
	): boolean {
		let trimmed = false;
		const floor =
			this.options.keepRecentMessagesFloor ??
			DEFAULT_KEEP_RECENT_MESSAGES_FLOOR;
		const hardLimitTokens =
			this.options.contextWindow - (this.options.reserveTokens ?? 16_384);

		while (
			this.estimateRequest(systemPrompt, toolSchemas).totalTokens >
				hardLimitTokens &&
			this.recentMessages.length > floor
		) {
			this.recentMessages = trimOldestMessageGroup(this.recentMessages);
			trimmed = true;
		}

		if (trimmed) {
			this.invalidateLastUsageAfterTrim();
			this.logger?.warn("context_trimmed", {
				runId: this.runId,
				sessionId: this.sessionId,
				turnId: requestContext?.turnId,
				remainingMessages: this.recentMessages.length,
				estimatedTokens: this.estimateRequest(systemPrompt, toolSchemas)
					.totalTokens,
			});
		}

		return trimmed;
	}
}

function extractSection(
	summary: string | null,
	heading: string,
): string | null {
	if (!summary) {
		return null;
	}
	const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = summary.match(
		new RegExp(
			`## ${escapedHeading}\\s*\\n(?<body>[\\s\\S]*?)(?:\\n## |$)`,
			"i",
		),
	);
	const body = match?.groups?.body
		?.split("\n")
		.map((line) => line.replace(/^[-*\d.\s[\]x]+/i, "").trim())
		.filter(Boolean)
		.join(" ")
		.trim();
	return body || null;
}

const MICRO_COMPACT_KEEP_TOOL_TOKENS = 8_000;
const MICRO_COMPACT_FLOOR_TOOL_RESULTS = 3;

/**
 * Derived, non-mutating view used to shrink working-context noise without a
 * model call and without touching the append-only entry stream. Old tool
 * results are replaced by a placeholder that preserves `name` + `toolCallId`
 * (so tool_use/tool_result pairing stays intact); the most-recent tool results
 * up to a token budget, with a small floor, are kept intact so the summary
 * prompt and the model can still see recent tool output.
 */
export function microCompactMessages(
	messages: Message[],
	options: {
		keepToolTokens?: number;
		floorToolResults?: number;
	} = {},
): Message[] {
	const keepToolTokens =
		options.keepToolTokens ?? MICRO_COMPACT_KEEP_TOOL_TOKENS;
	const floor = options.floorToolResults ?? MICRO_COMPACT_FLOOR_TOOL_RESULTS;
	let keptTokens = 0;
	let keptCount = 0;
	const keep = new Array<boolean>(messages.length).fill(false);
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message.role !== "tool") {
			continue;
		}
		if (keptCount < floor || keptTokens < keepToolTokens) {
			keep[i] = true;
			keptCount += 1;
			keptTokens += estimateMessageTokens(message);
		}
	}
	return messages.map((message, i) => {
		if (message.role === "tool" && !keep[i]) {
			return makeOmittedToolMessage(message);
		}
		return message;
	});
}

function makeOmittedToolMessage(message: ToolMessage): ToolMessage {
	const failed = /STATUS:\s*error|ERROR:/i.test(message.content);
	const placeholder = failed
		? `[tool result omitted: ${message.name} failed: ${firstErrorLine(message.content)}]`
		: `[tool result omitted: ${message.name} ok, ${message.content.length} chars]`;
	return { ...message, content: placeholder };
}

function firstErrorLine(content: string): string {
	const match = content.match(/ERROR:\s*(.+)/);
	const line = match?.[1]?.trim() ?? "unknown error";
	return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/**
 * Extract the final <summary> block from a summarization response. If the model
 * omitted the tags, fall back to the whole text (after stripping a single
 * leading <analysis> scratch block) so a good summary is never discarded over
 * a formatting miss. Returns null only when there is genuinely no text.
 */

function trimOldestMessageGroup(messages: Message[]): Message[] {
	if (messages.length === 0) {
		return messages;
	}

	let dropCount = 1;

	while (dropCount < messages.length && messages[dropCount]?.role === "tool") {
		dropCount += 1;
	}

	return messages.slice(dropCount);
}

function alignSplitIndex(messages: Message[], splitIndex: number): number {
	let index = Math.min(splitIndex, messages.length);

	while (index < messages.length && messages[index]?.role === "tool") {
		index += 1;
	}

	return index;
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

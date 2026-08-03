import { estimateMessageTokens } from "../context-window.js";
import type {
	ContextBudget,
	ContextUpdateResult,
	JsonValue,
	Message,
	ModelProvider,
	ModelUsage,
	RuntimeLogger,
	SessionEntry,
	ToolMessage,
	ToolSchema,
} from "../types.js";
import { CompactionFailedError } from "./compaction-error.js";
import type {
	CompactionHookOverride,
	CompactionHookRegistry,
} from "./compaction-hook.js";
import { summarize } from "./summarizer.js";

const MICRO_COMPACT_KEEP_TOOL_TOKENS = 8_000;
const MICRO_COMPACT_FLOOR_TOOL_RESULTS = 3;

// ---------------------------------------------------------------------------
// CompactorDeps – bag of closures that capture ConversationalContext private
// state so the Compactor stays self-contained without the host exposing its
// internals as public properties.
// ---------------------------------------------------------------------------

export interface CompactorDeps {
	// state getters / setters
	getSummary: () => string | null;
	setSummary: (value: string | null) => void;
	getRecentMessages: () => Message[];
	setRecentMessages: (value: Message[]) => void;
	getEntries: () => SessionEntry[];
	setEntries: (value: SessionEntry[]) => void;
	getLastUsage: () => { usage: ModelUsage; messageIndex: number } | null;
	setLastUsage: (
		value: { usage: ModelUsage; messageIndex: number } | null,
	) => void;

	// config accessors
	getKeepRecentMessagesFloor: () => number;
	isSummaryEnabled: () => boolean;
	getCompactionHooks: () => CompactionHookRegistry | null;
	getRunId: () => string | undefined;
	getSessionId: () => string | null;
	getLogger: () => RuntimeLogger | undefined;

	// delegating methods
	getBudget: () => ContextBudget;
	estimateRequest: (
		systemPrompt: string,
		toolSchemas: readonly ToolSchema[],
		pendingUserInput?: string,
	) => {
		totalTokens: number;
		usedUsage: boolean;
		threshold?: number;
	};
	recordCompactionEntry: (args: {
		summarizedCount: number;
		trigger: ContextUpdateResult["trigger"];
		tokensBefore: number;
		tokensAfter?: number;
		customInstructions?: string;
	}) => void;
}

// ---------------------------------------------------------------------------
// Compactor
// ---------------------------------------------------------------------------

export class Compactor {
	static readonly DEFAULT_KEEP_RECENT_MESSAGES_FLOOR = 4;

	constructor(private readonly d: CompactorDeps) {}

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
		const previousRecentMessageCount = this.d.getRecentMessages().length;
		const previousSummaryChars = this.d.getSummary()?.length ?? 0;
		const estimatedBefore = this.d.estimateRequest(systemPrompt, toolSchemas);
		const tokensBefore = estimatedBefore.totalTokens;
		let summarized = false;
		let summarizedCount = 0;
		let compactionInstructions: string | undefined;
		let trimmed = false;
		let trigger: ContextUpdateResult["trigger"] = null;

		const tokenTriggered =
			typeof estimatedBefore.threshold === "number" &&
			estimatedBefore.totalTokens > estimatedBefore.threshold;
		const floor = this.d.getKeepRecentMessagesFloor();
		const summarizable =
			this.d.isSummaryEnabled() &&
			(options?.force || this.d.getRecentMessages().length > floor);

		if (summarizable && (options?.force || tokenTriggered)) {
			trigger = options?.force ? "force" : "token";
			const splitIndex = this.findCompactSplitIndex({
				trigger,
			});
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
				const messages = this.d.getRecentMessages();
				const messagesToSummarize = messages.slice(0, splitIndex);
				if (messagesToSummarize.length > 0) {
					this.d.getLogger()?.info("context_summarization_started", {
						runId: this.d.getRunId(),
						sessionId: this.d.getSessionId(),
						turnId: requestContext?.turnId,
						trigger,
						messageCount: messagesToSummarize.length,
						estimatedTokens: estimatedBefore.totalTokens,
						tokenThreshold: estimatedBefore.threshold,
					});
					let hookOverride: CompactionHookOverride | null = null;
					const hooks = this.d.getCompactionHooks();
					if (hooks && hooks.size > 0) {
						const preparation = {
							trigger: trigger ?? "force",
							tokensBefore,
							summarizedMessages: messagesToSummarize,
							keptMessages: messages.slice(splitIndex),
							recentMessages: [...messages],
							previousSummary: this.d.getSummary(),
						};
						hookOverride = await hooks.runHooks(
							preparation,
							compactAbortController.signal,
							(message, meta) =>
								this.d
									.getLogger()
									?.warn(
										message,
										meta as Record<string, JsonValue | undefined>,
									),
						);
						if (hookOverride === null) {
							this.d
								.getLogger()
								?.info("context_summarization_cancelled_by_hook", {
									runId: this.d.getRunId(),
									sessionId: this.d.getSessionId(),
									turnId: requestContext?.turnId,
									trigger,
								});
							return {
								summarized: false,
								trimmed: false,
								summary: this.d.getSummary(),
								recentMessageCount: messages.length,
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
						this.d.setSummary(
							hookOverride?.summary ??
								(await summarize(provider, {
									systemPrompt,
									messages: microCompactMessages(messagesToSummarize),
									previousSummary: this.d.getSummary(),
									instructions: options?.instructions,
									requestContext,
									reserveTokens: this.d.getBudget().reserveTokens,
									runId: this.d.getRunId(),
									sessionId: this.d.getSessionId() ?? undefined,
									abortSignal: compactAbortController.signal,
								})),
						);
						this.d.setRecentMessages(messages.slice(splitIndex));
						summarized = true;
						summarizedCount = messagesToSummarize.length;
						compactionInstructions = options?.instructions?.trim() || undefined;
						this.invalidateLastUsage();
						this.d.getLogger()?.info("context_summarization_finished", {
							runId: this.d.getRunId(),
							sessionId: this.d.getSessionId(),
							turnId: requestContext?.turnId,
							trigger,
							summaryChars: this.d.getSummary()?.length ?? 0,
							remainingMessages: this.d.getRecentMessages().length,
						});
					} catch (error) {
						this.d.getLogger()?.error("context_summarization_failed", {
							runId: this.d.getRunId(),
							sessionId: this.d.getSessionId(),
							turnId: requestContext?.turnId,
							trigger,
							error: error instanceof Error ? error.message : String(error),
							messageCount: messagesToSummarize.length,
							estimatedTokens: estimatedBefore.totalTokens,
						});
						this.trimToHardLimit(systemPrompt, toolSchemas, requestContext);
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

		const estimatedAfter = this.d.estimateRequest(systemPrompt, toolSchemas);

		if (summarized) {
			// Record the compaction entry after the final post-compaction
			// estimate (and any hard-limit trim) so the persisted
			// `tokensAfter` matches the `context_compacted` event the live
			// status line displays.
			this.d.recordCompactionEntry({
				summarizedCount,
				trigger,
				tokensBefore,
				tokensAfter: estimatedAfter.totalTokens,
				customInstructions: compactionInstructions,
			});
		}

		return {
			summarized,
			trimmed,
			summary: this.d.getSummary(),
			recentMessageCount: this.d.getRecentMessages().length,
			previousRecentMessageCount,
			summaryChars: this.d.getSummary()?.length ?? 0,
			previousSummaryChars,
			tokensBefore,
			tokensAfter: estimatedAfter.totalTokens,
			trigger,
		};
	}

	// -----------------------------------------------------------------------
	// Public helpers (also used by the context for recovery messages)
	// -----------------------------------------------------------------------

	trimToHardLimit(
		systemPrompt: string,
		toolSchemas: readonly ToolSchema[],
		requestContext?: {
			turnId?: string;
		},
	): boolean {
		let trimmed = false;
		const floor = this.d.getKeepRecentMessagesFloor();
		const budget = this.d.getBudget();
		const hardLimitTokens = budget.hardContextLimit - budget.reserveTokens;

		while (
			this.d.estimateRequest(systemPrompt, toolSchemas).totalTokens >
				hardLimitTokens &&
			this.d.getRecentMessages().length > floor
		) {
			this.d.setRecentMessages(
				trimOldestMessageGroup(this.d.getRecentMessages()),
			);
			trimmed = true;
		}

		if (trimmed) {
			this.invalidateLastUsage();
			this.d.getLogger()?.warn("context_trimmed", {
				runId: this.d.getRunId(),
				sessionId: this.d.getSessionId(),
				turnId: requestContext?.turnId,
				remainingMessages: this.d.getRecentMessages().length,
				estimatedTokens: this.d.estimateRequest(systemPrompt, toolSchemas)
					.totalTokens,
			});
		}

		return trimmed;
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	private findCompactSplitIndex(args: {
		trigger: ContextUpdateResult["trigger"];
	}): number {
		const messages = this.d.getRecentMessages();
		const floor = this.d.getKeepRecentMessagesFloor();
		const keepRecentTokens = this.d.getBudget().keepRecentTokens;
		const messageFloorIndex = alignSplitIndex(
			messages,
			Math.max(1, messages.length - floor),
		);

		let tokenCutIndex = messages.length;
		let accumulated = 0;
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			const msg = messages[i];
			if (!msg) continue;
			accumulated += estimateMessageTokens(msg);
			if (accumulated >= keepRecentTokens) {
				tokenCutIndex = alignSplitIndex(messages, i);
				break;
			}
		}
		if (tokenCutIndex >= messages.length) {
			if (args.trigger === "token") {
				return 0;
			}
			return alignSplitIndex(messages, Math.max(1, messages.length - 1));
		}
		// For force trigger the user explicitly asked to compact, so we must
		// always summarize at least `floor` messages worth — even when the
		// recent window already exceeds `keepRecentTokens` (in which case
		// `tokenCutIndex` collapses to 0 and `Math.min` would skip the
		// summary entirely). For token trigger we keep the conservative
		// `Math.min` so we never summarize more than either limit demands.
		if (args.trigger === "force") {
			return messageFloorIndex;
		}
		return Math.min(tokenCutIndex, messageFloorIndex);
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
		this.d.setLastUsage(null);
		const liveIds = new Set(
			this.d
				.getRecentMessages()
				.map((message) => message.id)
				.filter((id): id is string => Boolean(id)),
		);
		this.d.setEntries(
			this.d
				.getEntries()
				.map((entry) =>
					entry.kind === "message" && entry.usage && liveIds.has(entry.id)
						? { ...entry, usage: undefined }
						: entry,
				),
		);
	}
}

// ---------------------------------------------------------------------------
// Micro-compact: stateless, non-mutating view for shrinking tool-result noise
// ---------------------------------------------------------------------------

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
		if (message?.role !== "tool") {
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
			return makeOmittedToolMessage(message as ToolMessage);
		}
		return message;
	});
}

function makeOmittedToolMessage(message: ToolMessage): ToolMessage {
	return { ...message, content: "" };
}

// ---------------------------------------------------------------------------
// Trim / alignment helpers
// ---------------------------------------------------------------------------

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

import type { Message } from "../types.js";

/**
 * Snapshot of what a compact is about to do, exposed to user-supplied
 * hooks so they can decide whether to cancel, override, or let the
 * default summarization proceed.
 */
export type CompactionPreparation = {
	/**
	 * Why compact was triggered:
	 * - `"token"`  — provider-reported usage exceeded context window minus reserve
	 * - `"force"`  — caller passed `options.force = true`
	 */
	trigger: "token" | "force";
	tokensBefore: number;
	summarizedMessages: Message[];
	keptMessages: Message[];
	recentMessages: Message[];
	previousSummary: string | null;
};

/**
 * Optional fields a hook can override on the would-be compaction entry.
 * Any field left undefined inherits the value the default summarization
 * would have produced.
 */
export type CompactionHookOverride = {
	summary?: string;
	firstKeptEntryId?: string | null;
	tokensBefore?: number;
	details?: {
		trigger?: "token" | "force" | null;
		keptMessages?: number;
		summarizedMessages?: number;
		triggeredBy?: "soft_limit" | "hard_limit" | "token_estimate" | "manual";
	};
};

export type CompactionHookEvent = {
	preparation: CompactionPreparation;
	signal: AbortSignal;
};

export type CompactionHookResult =
	| { cancel: true }
	| { compaction: CompactionHookOverride }
	| undefined;

export type CompactionHookFn = (
	event: CompactionHookEvent,
) => Promise<CompactionHookResult> | CompactionHookResult;

/**
 * Minimal registry that lets users register "session_before_compact"
 * hooks (one per registration) and lets the compact orchestrator run
 * them in registration order before applying the default summary.
 *
 * Hook results are merged: any hook returning `{ cancel: true }` wins
 * outright; otherwise the most-recent non-undefined `compaction` override
 * wins (field-by-field). A hook that throws is logged via the supplied
 * logger and otherwise ignored so one bad extension cannot break the
 * the agent loop.
 */
export interface CompactionHookRegistry {
	register(fn: CompactionHookFn): () => void;
	/**
	 * Run every registered hook. Returns `null` when any hook asked to
	 * cancel, otherwise the merged override (or `{}` when no hook
	 * returned anything actionable).
	 */
	runHooks(
		preparation: CompactionPreparation,
		signal: AbortSignal,
		log?: (message: string, meta?: Record<string, unknown>) => void,
	): Promise<CompactionHookOverride | null>;
	readonly size: number;
}

export function createCompactionHookRegistry(): CompactionHookRegistry {
	const hooks: CompactionHookFn[] = [];

	const runHooks: CompactionHookRegistry["runHooks"] = async (
		preparation,
		signal,
		log,
	) => {
		let override: CompactionHookOverride = {};
		let overrideCount = 0;
		for (const fn of hooks) {
			if (signal.aborted) {
				return null;
			}
			let result: CompactionHookResult;
			try {
				result = await fn({ preparation, signal });
			} catch (error) {
				log?.("compaction_hook_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			if (!result) continue;
			if ("cancel" in result && result.cancel) {
				return null;
			}
			if ("compaction" in result) {
				override = mergeOverrides(override, result.compaction);
				overrideCount += 1;
			}
		}
		if (log && overrideCount > 0) {
			log("compaction_hook_overrides_applied", { count: overrideCount });
		}
		return override;
	};

	return {
		register(fn) {
			hooks.push(fn);
			return () => {
				const index = hooks.indexOf(fn);
				if (index >= 0) hooks.splice(index, 1);
			};
		},
		runHooks,
		get size() {
			return hooks.length;
		},
	};
}

function mergeOverrides(
	prev: CompactionHookOverride,
	next: CompactionHookOverride,
): CompactionHookOverride {
	return {
		summary: next.summary ?? prev.summary,
		firstKeptEntryId:
			next.firstKeptEntryId !== undefined
				? next.firstKeptEntryId
				: prev.firstKeptEntryId,
		tokensBefore: next.tokensBefore ?? prev.tokensBefore,
		details: mergeDetails(prev.details, next.details),
	};
}

function mergeDetails(
	prev: CompactionHookOverride["details"],
	next: CompactionHookOverride["details"],
): CompactionHookOverride["details"] {
	if (!prev && !next) return undefined;
	return {
		trigger: next?.trigger ?? prev?.trigger,
		keptMessages: next?.keptMessages ?? prev?.keptMessages,
		summarizedMessages: next?.summarizedMessages ?? prev?.summarizedMessages,
		triggeredBy: next?.triggeredBy ?? prev?.triggeredBy,
	};
}

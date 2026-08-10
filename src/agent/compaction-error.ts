import type { ContextUpdateResult } from "../types.js";

type CompactionFailureReason =
	| "truncated"
	| "empty"
	| "summarize_error"
	| "insufficient_compaction";

/**
 * Raised when conversation compaction cannot produce a summary: the model
 * output was truncated, the model returned nothing usable, the provider
 * errored, or the post-compaction window still overflows the soft limit (D6).
 *
 * sigpi intentionally has no deterministic fallback summary (matching pi and
 * Claude Code). Instead the failure is surfaced to the caller, which decides
 * how to degrade: the `/compact` command surfaces a clear message to the
 * user, and the runner lets the turn fail rather than silently dropping
 * messages (D4 — no silent trimming, ever).
 */
export class CompactionFailedError extends Error {
	readonly reason: CompactionFailureReason;
	trigger: ContextUpdateResult["trigger"];

	constructor(
		message: string,
		options: {
			reason: CompactionFailureReason;
			trigger?: ContextUpdateResult["trigger"];
		},
	) {
		super(message);
		this.name = "CompactionFailedError";
		this.reason = options.reason;
		this.trigger = options.trigger ?? null;
	}
}

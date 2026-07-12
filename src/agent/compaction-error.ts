import type { ContextUpdateResult } from "../types.js";

export type CompactionFailureReason = "truncated" | "empty" | "summarize_error";

/**
 * Raised when conversation compaction cannot produce a summary: the model
 * output was truncated, the model returned nothing usable, or the provider
 * errored.
 *
 * sigpi intentionally has no deterministic fallback summary (matching pi and
 * Claude Code). Instead the failure is surfaced to the caller, which decides
 * how to degrade: `runner.ts` catches it for automatic turns and continues
 * (tokens are already bounded by `trimToHardLimit`), while the `/compact`
 * command surfaces a clear message to the user.
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

export function isCompactionFailedError(
	error: unknown,
): error is CompactionFailedError {
	return error instanceof CompactionFailedError;
}

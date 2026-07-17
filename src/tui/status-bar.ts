import { homedir } from "node:os";
import type { Component } from "@earendil-works/pi-tui";
import type { ModelUsage, TurnProgressEvent } from "../types.js";

/**
 * Immutable view-model for the status bar (ADR 0022). The footer component
 * renders this into a single line; callers build it (including the async git
 * branch lookup) and hand it to {@link StatusBarComponent}.
 */
export interface StatusBarModel {
	/** Active model name — the first, unlabelled segment. */
	modelName: string;
	/** Usable context budget: hard context limit minus reserved tokens. */
	limit: number;
	/** Ground-truth used tokens from the last response, or `null` before any. */
	usedTokens: number | null;
	/** The last provider usage report, or `null` before any response. */
	usage: ModelUsage | null;
	/** Working directory shown in the cwd segment. */
	cwd: string;
	/** Git branch, `@<shortSha>` when detached, or `null` when not a repo / git fails. */
	branch: string | null;
	/** Optional progress label suffixed after the cwd segment (e.g. "working"). */
	eventLabel?: string | null;
}

/**
 * Compose the ADR 0022 status bar line from a {@link StatusBarModel}.
 *
 * Layout: `{model} | {used}/{limit} ({pct}%) Hit(x%) | {cwd} ({branch})`.
 * Before the first response (or after `recover()`) `usedTokens` is `null` and
 * we render an honest `?` instead of a drift-prone estimate. The cache hit
 * rate is appended only when there is real cacheable input to measure against.
 */
export function composeStatusBar(model: StatusBarModel): string {
	const cwdSegment = model.branch
		? `${shortenWorkingDirectory(model.cwd)} (${model.branch})`
		: shortenWorkingDirectory(model.cwd);

	const segments: string[] = [model.modelName];
	if (model.usedTokens === null) {
		// No provider-reported usage yet (fresh session, after /recover, or a
		// legacy resume with no `usage`). Honest `?` beats a wrong estimate.
		segments.push(`?/${formatCompactNumber(model.limit)}`);
	} else {
		const limitStr = formatCompactNumber(model.limit);
		const usedStr = formatCompactNumber(model.usedTokens);
		const percentUsed = Math.round((model.usedTokens / model.limit) * 100);
		const tokenSegment = `${usedStr}/${limitStr} (${percentUsed}%)`;
		const cacheHitRate = model.usage ? computeCacheHitRate(model.usage) : null;
		segments.push(
			cacheHitRate ? `${tokenSegment} Hit(${cacheHitRate}%)` : tokenSegment,
		);
	}
	segments.push(cwdSegment);

	let line = segments.join(" | ");
	if (model.eventLabel) {
		line = `${line} | ${model.eventLabel}`;
	}
	return line;
}

/**
 * Pi-tui footer / overlay component that renders the ADR 0022 status bar.
 *
 * It is a drop-in Pi-tui {@link Component}: `render(width)` returns the single
 * status line, and `invalidate()` lets a host TUI drop cached state on a full
 * redraw. The status line is rendered in full (no truncation); on a terminal
 * narrower than the line it will wrap or overflow rather than be clipped.
 */
export class StatusBarComponent implements Component {
	private model: StatusBarModel | null = null;

	constructor(initial: StatusBarModel | null = null) {
		this.model = initial;
	}

	/** Replace the rendered view-model. `null` disables the footer. */
	setModel(model: StatusBarModel | null): void {
		this.model = model;
	}

	getModel(): StatusBarModel | null {
		return this.model;
	}

	/** Render the composed status line in full (no truncation). */
	render(_width: number): string[] {
		if (!this.model) {
			return [];
		}
		return [composeStatusBar(this.model)];
	}

	invalidate(): void {
		// The component is stateless: the model is supplied on each update, so
		// there is no cached render to discard.
	}
}

/**
 * Compute the cache hit rate as a percentage of input tokens that came from
 * the prompt cache. Returns `null` when there is no input to measure against
 * (so we never render `Hit(NaN%)` or `Hit(0.0%)` for a fresh conversation).
 * The result is rounded to one decimal place and formatted as a string so the
 * status bar always renders a consistent `Hit(80.0%)` shape.
 */
export function computeCacheHitRate(usage: ModelUsage): string | null {
	const input = usage.input;
	const cacheRead = usage.cacheRead;
	const denominator = input + cacheRead;
	if (denominator <= 0) {
		return null;
	}
	const percent = Math.round((cacheRead / denominator) * 1000) / 10;
	return percent.toFixed(1);
}

/** Map a turn progress event to the short label suffixed on the status bar. */
export function getStatusEventLabel(
	event: TurnProgressEvent | null,
): string | null {
	if (!event) {
		return null;
	}

	switch (event.type) {
		case "turn_started":
			return "working";
		case "step_started":
			return null;
		case "interrupt_requested":
			return event.interruptStage === "model"
				? "cancelling"
				: "interrupt requested";
		case "model_request_started":
			return "thinking";
		case "model_delta":
			return null;
		case "model_request_finished":
			return null;
		case "assistant_message":
			return null;
		case "context_checkpoint":
			return "checkpoint";
		case "tool_calls_received":
			return null;
		case "tool_execution_started":
			return (
				event.message ?? (event.toolName ? `tool ${event.toolName}` : "tool")
			);
		case "tool_execution_finished":
			return event.toolOk
				? null
				: event.toolName
					? `failed ${event.toolName}`
					: "tool failed";
		case "turn_finished":
			return "done";
		case "turn_interrupted":
			return "interrupted";
		case "turn_max_steps_reached":
			return "max steps";
		case "turn_failed":
			return "failed";
	}
}

function formatCompactNumber(value: number): string {
	if (!Number.isFinite(value)) {
		return "0";
	}
	if (Math.abs(value) < 1000) {
		return String(Math.round(value));
	}
	const formatter = new Intl.NumberFormat("en", {
		notation: "compact",
		maximumFractionDigits: 1,
	});
	return formatter.format(value);
}

function shortenWorkingDirectory(value: string): string {
	const home = homedir();
	if (!home) {
		return value;
	}
	if (value === home) {
		return "~";
	}
	return value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
}

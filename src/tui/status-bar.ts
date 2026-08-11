import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import {
	type Component,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ModelUsage, TurnProgressEvent } from "../types.js";

/**
 * Immutable view-model for the status bar. The footer component
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
	/**
	 * Epoch ms when the current turn started (user submit). While set, the
	 * composed line renders a live elapsed clock next to the event label
	 * (e.g. `thinking · 4s`); the clock advances on every re-render without
	 * rebuilding the model.
	 */
	turnStartedAt?: number | null;
	/** Final stats of the most recently finished turn, rendered after it ends. */
	lastTurnStats?: LastTurnStats | null;
}

/**
 * Wall-clock and token accounting for a completed turn, kept on the bar
 * until the next turn starts so the user sees "this answer took 12s and
 * 8.2K billed" without re-querying anything.
 */
export interface LastTurnStats {
	/** Terminal event label of the finished turn ("done", "interrupted", ...). */
	label: string;
	/** Total elapsed time from user submit to the terminal event, in ms. */
	elapsedMs: number;
	/**
	 * Provider-reported usage accumulated across the turn's model requests,
	 * or `null` when no request reported usage (some providers omit usage on
	 * the streaming path). The bar renders it as `input + output`, i.e. the
	 * billing-relevant total (every tool step re-sends the whole context, so
	 * this is higher than the context-window figure on the left).
	 */
	tokens: ModelUsage | null;
}

/**
 * Compose the status bar line from a {@link StatusBarModel}.
 *
 * Layout: `{model} | {used}/{limit} ({pct}%) | {cwd} ({branch})`.
 * Before the first response (or after `recover()`) `usedTokens` is `null` and
 * we render an honest `?` instead of a drift-prone estimate.
 */
export function composeStatusBar(
	model: StatusBarModel,
	now: number = Date.now(),
): string {
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
		segments.push(`${usedStr}/${limitStr} (${percentUsed}%)`);
	}
	segments.push(cwdSegment);

	let line = segments.join(" | ");
	if (model.eventLabel) {
		line = `${line} | ${model.eventLabel}`;
	}
	if (model.turnStartedAt != null) {
		// Live turn clock: derived from the start timestamp on every render so
		// the ticking refresh only needs to re-render, not rebuild the model.
		line = `${line} · ${formatElapsed(Math.max(0, now - model.turnStartedAt))}`;
	} else if (model.lastTurnStats) {
		// Turn is over: freeze the final wall-clock and billed token total.
		line = `${line} · ${formatElapsed(model.lastTurnStats.elapsedMs)}`;
		const tokens = model.lastTurnStats.tokens;
		if (tokens) {
			line = `${line} · ${formatCompactNumber(tokens.input + tokens.output)} billed`;
		}
	}
	return line;
}

/**
 * Pi-tui footer / overlay component that renders the status bar.
 *
 * It is a drop-in Pi-tui {@link Component}: `render(width)` returns the single
 * status line, and `invalidate()` lets a host TUI drop cached state on a full
 * redraw. The status line is rendered in full (no truncation); on a terminal
 * narrower than the line it will wrap or overflow rather than be clipped.
 */
export class StatusBarComponent implements Component {
	private model: StatusBarModel | null;
	private readonly paddingX: number;
	private readonly paddingY: number;

	constructor(
		model: StatusBarModel | null = null,
		paddingX: number = 0,
		paddingY: number = 0,
	) {
		this.model = model;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	setModel(model: StatusBarModel | null) {
		this.model = model;
	}

	getModel(): StatusBarModel | null {
		return this.model;
	}

	render(width: number): string[] {
		if (!this.model) {
			return [];
		}

		const result: string[] = [];

		// Empty line padded to width
		const emptyLine = " ".repeat(width);

		// Add vertical padding above
		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		// Calculate available width after horizontal padding
		const availableWidth = Math.max(1, width - this.paddingX * 2);

		const text = composeStatusBar(this.model);

		// Take only the first line (stop at newline)
		let singleLineText = text;
		const newlineIndex = text.indexOf("\n");
		if (newlineIndex !== -1) {
			singleLineText = text.substring(0, newlineIndex);
		}

		// Truncate text if needed (accounting for ANSI codes)
		const displayText = truncateToWidth(singleLineText, availableWidth);

		// Add horizontal padding
		const leftPadding = " ".repeat(this.paddingX);
		const rightPadding = " ".repeat(this.paddingX);
		const lineWithPadding = leftPadding + displayText + rightPadding;

		// Pad line to exactly width characters
		const lineVisibleWidth = visibleWidth(lineWithPadding);
		const paddingNeeded = Math.max(0, width - lineVisibleWidth);
		const finalLine = lineWithPadding + " ".repeat(paddingNeeded);

		result.push(finalLine);

		// Add vertical padding below
		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		return result;
	}
}

/**
 * Map a turn progress event to the short label suffixed on the status bar.
 *
 * Every in-turn event resolves to a visible label so the bar always tells the
 * user the agent is still busy: "thinking" while the model is generating,
 * "working" in every other active phase (between steps, dispatching and
 * running tools), and a terminal label only when the turn has actually ended.
 * A missing label would leave the bar looking idle while the agent is working,
 * and reporting "done" on `tool_execution_*` made a running tool look finished.
 */
export function getStatusEventLabel(
	event: TurnProgressEvent | null,
): string | null {
	if (!event) {
		return null;
	}

	switch (event.type) {
		case "turn_started":
		case "step_started":
		case "model_request_finished":
		case "assistant_message":
		case "tool_calls_received":
		case "tool_execution_started":
		case "tool_execution_finished":
			return "working";
		case "interrupt_requested":
			return event.stage === "model" ? "cancelling" : "interrupt requested";
		case "model_request_started":
		case "model_delta":
			return "thinking";
		case "context_checkpoint":
			return "checkpoint";
		case "context_compacted":
			return "compacted";
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

export function formatCompactNumber(value: number): string {
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

/**
 * Format a duration for the status bar: whole seconds under a minute
 * (`12s`), minutes + seconds beyond (`1m 05s`). The live clock ticks once
 * per second, so sub-second precision would read as noise; exact ms is kept
 * in the turn log instead.
 */
export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0
		? `${minutes}m ${String(seconds).padStart(2, "0")}s`
		: `${seconds}s`;
}

/**
 * Shorten a path inside the user's home directory to `~...`, or return it
 * unchanged otherwise. Uses `node:path` so the comparison works on both
 * POSIX (`/`) and Windows (`\`) separators — a hard-coded `/` prefix test
 * never matched on Windows, so the cwd segment was never shortened there.
 */
function shortenWorkingDirectory(value: string): string {
	const home = homedir();
	if (!home) {
		return value;
	}
	const rel = relative(home, value);
	if (rel === "") {
		// `value` resolves to home itself (also covers drive-letter case
		// differences on Windows, which a string `===` comparison would miss).
		return "~";
	}
	const outside = rel === ".." || rel.startsWith(`..${sep}`);
	if (!outside && !isAbsolute(rel)) {
		return `~${sep}${rel}`;
	}
	return value;
}

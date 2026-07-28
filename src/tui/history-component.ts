import {
	type Component,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { PersistedSession, SessionTurnHistoryEntry } from "../types.js";

/**
 * TUI component that renders the saved turn history for a session as a
 * scrollable view. The view captures keyboard input and dismisses itself
 * when the user presses Esc or Ctrl+C, returning focus to the chat editor
 * underneath.
 */
class HistoryOverlayComponent implements Component {
	private readonly lines: string[];
	private offset = 0;

	constructor(
		session: PersistedSession,
		limit: number | "all",
		private readonly onDismiss: () => void,
	) {
		this.lines = buildHistoryOverlayLines(session, limit);
	}

	handleInput(data: string): void {
		// Esc / Ctrl+C dismiss the overlay and hand focus back to the chat
		// editor. Arrow keys scroll the history when it overflows the
		// viewport.
		if (data === "\x1B" || data === "\u0003") {
			this.onDismiss();
			return;
		}
		if (data === "\x1B[A" || data === "k") {
			this.offset = Math.max(0, this.offset - 1);
			return;
		}
		if (data === "\x1B[B" || data === "j") {
			this.offset = this.offset + 1;
			return;
		}
		if (data === "\x1B[5~") {
			this.offset = Math.max(0, this.offset - 5);
			return;
		}
		if (data === "\x1B[6~") {
			this.offset = this.offset + 5;
			return;
		}
		if (data === "g") {
			this.offset = 0;
			return;
		}
		if (data === "G") {
			this.offset = Number.MAX_SAFE_INTEGER;
			return;
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const viewportHeight = Math.max(3, Math.min(this.lines.length, 20));

		const maxOffset = Math.max(0, this.lines.length - viewportHeight);
		const clampedOffset = Math.min(this.offset, maxOffset);
		this.offset = clampedOffset;

		const visible = this.lines.slice(
			clampedOffset,
			clampedOffset + viewportHeight,
		);

		const header = `Session history (${this.lines.length} line${this.lines.length === 1 ? "" : "s"})`;
		const footer =
			this.lines.length > viewportHeight
				? `Showing ${clampedOffset + 1}-${clampedOffset + visible.length} of ${this.lines.length} — Esc to close`
				: "Esc to close";

		const padded = visible.map((line) => padToWidth(line, width));
		while (padded.length < viewportHeight) {
			padded.push("");
		}

		// Header and footer must also fit the terminal width — truncate them
		// defensively so a narrow terminal doesn't crash the renderer.
		return [
			truncateToWidth(header, width),
			...padded,
			truncateToWidth(footer, width),
		];
	}
}

/**
 * Show the session history as a TUI view. Resolves once the user dismisses
 * it (Esc / Ctrl+C). When no TUI is available, resolves immediately so
 * callers can fall back to plain output.
 *
 * Implementation note: rather than going through Pi-tui's overlay stack,
 * we temporarily swap the TUI's `children` for the history component. This
 * keeps the history view in the same render pass as the rest of the TUI
 * (no overlay compositing) and lets us restore the original children
 * verbatim — including the focused component — when the user dismisses.
 */
export async function showHistoryOverlay(
	tui: TUI,
	session: PersistedSession,
	limit: number | "all",
): Promise<void> {
	return new Promise<void>((resolve) => {
		let resolved = false;

		const finish = () => {
			if (resolved) return;
			resolved = true;
			// Restore the original children and focus, then re-render.
			tui.children = previousChildren;
			tui.setFocus(previousFocus);
			tui.requestRender();
			resolve();
		};

		const component = new HistoryOverlayComponent(session, limit, finish);

		// Stash the current children and focused component so we can put
		// them back exactly as they were when the user dismisses.
		const previousChildren = tui.children;
		// biome-ignore lint/complexity/useLiteralKeys: focusedComponent is private in pi-tui
		const previousFocus = tui["focusedComponent"] as Component | null;

		tui.children = [component];
		tui.setFocus(component);
		tui.requestRender();
	});
}

function buildHistoryOverlayLines(
	session: PersistedSession,
	limit: number | "all",
): string[] {
	if (session.turns.length === 0) {
		return ["(no saved turns)"];
	}

	const turns = limit === "all" ? session.turns : session.turns.slice(-limit);
	const lines: string[] = [];
	turns.forEach((turn, index) => {
		if (index > 0) {
			lines.push("─".repeat(40));
		}
		lines.push(...formatHistoryTurn(turn).split("\n"));
	});
	return lines;
}

function padToWidth(line: string, width: number): string {
	// Truncate first when the line is wider than the terminal — otherwise
	// Pi-tui's renderer throws because the line exceeds the terminal width.
	// truncateToWidth handles wide characters (CJK) and ANSI escapes correctly.
	if (visibleWidth(line) >= width) {
		return truncateToWidth(line, width);
	}
	return `${line}${" ".repeat(width - visibleWidth(line))}`;
}

export function formatHistoryTurn(turn: SessionTurnHistoryEntry): string {
	const lines = [
		`Turn ${turn.turnId} [${turn.status}] ${formatTurnTimeRange(turn)}`,
		`User: ${turn.userInput}`,
		`Assistant: ${turn.assistantOutput ?? "(no assistant output)"}`,
	];

	if (turn.errorMessage) {
		lines.push(`Error: ${turn.errorMessage}`);
	}

	if (turn.toolExecutions.length > 0) {
		lines.push(`Tools: ${turn.toolExecutions.length}`);
	}

	return lines.join("\n");
}

export function formatTurnTimeRange(turn: SessionTurnHistoryEntry): string {
	return turn.finishedAt
		? `${turn.startedAt} -> ${turn.finishedAt}`
		: turn.startedAt;
}

export function formatSessionHistory(
	session: PersistedSession,
	limit: number | "all",
): string {
	if (session.turns.length === 0) {
		return "(no saved turns)";
	}

	const turns = limit === "all" ? session.turns : session.turns.slice(-limit);
	return turns.map(formatHistoryTurn).join("\n\n");
}

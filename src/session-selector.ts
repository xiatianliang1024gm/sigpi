import { stdin as processInput, stdout as processOutput } from "node:process";
import type { ReadStream, WriteStream } from "node:tty";
import { compareTimestampDescending, formatRelativeTime } from "./time.js";
import {
	type Component,
	moveSelectedIndex,
	ProcessTerminal,
	Tui,
} from "./tui/index.js";
import type { SessionSummary } from "./types.js";

const DEFAULT_SESSION_SELECTOR_LIMIT = 20;

export interface SessionSelectorState {
	readonly sessions: SessionSummary[];
	readonly selectedIndex: number;
}

export type SessionSelectorAction =
	| { type: "up" }
	| { type: "down" }
	| { type: "confirm" }
	| { type: "cancel" };

export type SessionSelectorResolution =
	| { status: "selected"; sessionId: string }
	| { status: "cancelled" };

export function prepareSessionChoices(
	sessions: SessionSummary[],
	limit = DEFAULT_SESSION_SELECTOR_LIMIT,
): SessionSummary[] {
	return sessions
		.filter((session) => session.title !== null)
		.sort((left, right) =>
			compareTimestampDescending(left.updatedAt, right.updatedAt),
		)
		.slice(0, limit);
}

export function createSessionSelectorState(
	sessions: SessionSummary[],
): SessionSelectorState {
	return {
		sessions,
		selectedIndex: 0,
	};
}

export function reduceSessionSelector(
	state: SessionSelectorState,
	action: SessionSelectorAction,
): SessionSelectorState | SessionSelectorResolution {
	if (action.type === "confirm") {
		const selected = state.sessions[state.selectedIndex];
		if (!selected) {
			return { status: "cancelled" };
		}

		return { status: "selected", sessionId: selected.sessionId };
	}

	if (action.type === "cancel") {
		return { status: "cancelled" };
	}

	if (state.sessions.length === 0) {
		return state;
	}

	return {
		...state,
		selectedIndex: moveSelectedIndex(
			state.selectedIndex,
			state.sessions.length,
			action.type === "up" ? -1 : 1,
		),
	};
}

export function renderSessionSelectorWithWidth(
	state: SessionSelectorState,
	maxWidth = 100,
	now: Date = new Date(),
): string {
	const lines = ["Select a session to resume:", ""];

	for (const [index, session] of state.sessions.entries()) {
		lines.push(
			renderSessionLine(session, index === state.selectedIndex, maxWidth, now),
		);
	}

	lines.push("");
	lines.push(
		"Use ArrowUp/ArrowDown to move, Enter to confirm, Esc or Ctrl+C to cancel.",
	);
	return lines.join("\n");
}

function renderSessionLine(
	session: SessionSummary,
	selected: boolean,
	maxWidth: number,
	now: Date,
): string {
	const prefix = selected ? "> " : "  ";
	const relative = formatRelativeTime(session.updatedAt, now);
	const tokens = formatCompactTokens(session.estimatedTokens);

	// Reserve space for prefix, the two trailing columns, and gaps.
	const trailingWidth = relative.length + tokens.length + 4; // 2 gaps of 2 spaces
	const messageWidth = Math.max(0, maxWidth - prefix.length - trailingWidth);

	const message = session.title ?? "";
	const shownMessage = truncatePreview(message, messageWidth);

	if (messageWidth <= 0) {
		// Terminal too narrow for the message: shed the token column first,
		// then the relative time, to keep the message visible.
		const messageOnly = truncatePreview(
			message,
			Math.max(0, maxWidth - prefix.length),
		);
		if (maxWidth - prefix.length - messageOnly.length >= 2) {
			return `${prefix}${messageOnly}  ${relative}`;
		}
		return `${prefix}${messageOnly}`;
	}

	return `${prefix}${shownMessage.padEnd(messageWidth)}  ${relative}  ${tokens}`;
}

function formatCompactTokens(tokens: number | null): string {
	if (tokens === null) {
		return "—";
	}
	if (Math.abs(tokens) < 1000) {
		return String(tokens);
	}
	const formatter = new Intl.NumberFormat("en", {
		notation: "compact",
		maximumFractionDigits: 1,
	});
	return formatter.format(tokens);
}

class SessionSelectorComponent implements Component {
	public onResolve?: (result: string | null) => void;

	constructor(private state: SessionSelectorState) {}

	render(width: number): string[] {
		return renderSessionSelectorWithWidth(this.state, width).split("\n");
	}

	handleInput(data: string): void {
		const action = inputToSelectorAction(data);
		if (!action) {
			return;
		}

		const next = reduceSessionSelector(this.state, action);
		if ("status" in next) {
			this.onResolve?.(next.status === "selected" ? next.sessionId : null);
			return;
		}

		this.state = next;
	}
}

export async function selectSessionInteractive(
	sessions: SessionSummary[],
	args?: {
		input?: ReadStream;
		output?: WriteStream;
	},
): Promise<string | null> {
	if (sessions.length === 0) {
		return null;
	}

	const input = args?.input ?? processInput;
	const output = args?.output ?? processOutput;

	if (!input.isTTY || !output.isTTY) {
		return sessions[0]?.sessionId ?? null;
	}

	return new Promise<string | null>((resolve) => {
		const terminal = new ProcessTerminal(input, output);
		const tui = new Tui(terminal);
		const component = new SessionSelectorComponent(
			createSessionSelectorState(sessions),
		);

		component.onResolve = (result) => {
			tui.stop();
			output.write("\x1B[2J\x1B[H");
			resolve(result);
		};

		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
	});
}

function inputToSelectorAction(data: string): SessionSelectorAction | null {
	switch (data) {
		case "\x1B[A":
			return { type: "up" };
		case "\x1B[B":
			return { type: "down" };
		case "\r":
		case "\n":
			return { type: "confirm" };
		case "\x1B":
		case "\u0003":
			return { type: "cancel" };
		default:
			return null;
	}
}

function truncatePreview(value: string, maxChars = 72): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}

	return `${normalized.slice(0, maxChars - 3)}...`;
}

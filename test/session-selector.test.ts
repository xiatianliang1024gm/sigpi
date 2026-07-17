import assert from "node:assert/strict";
import test from "node:test";
import { type Component, type Terminal, TUI } from "@earendil-works/pi-tui";
import {
	createSessionSelectorState,
	prepareSessionChoices,
	reduceSessionSelector,
	renderSessionSelectorWithWidth,
	SessionSelectorComponent,
	selectSessionInteractive,
} from "../src/session-selector.js";
import type { SessionSummary } from "../src/types.js";

/**
 * Minimal Pi-tui Terminal that captures every write so a test can verify the
 * overlay composite through the Terminal seam. Input is dispatched by calling
 * `inputHandler` directly, mirroring how Pi-tui forwards key sequences.
 */
class FakeTerminal implements Terminal {
	public columns = 100;
	public rows = 24;
	public writes: string[] = [];
	public inputHandler: ((data: string) => void) | null = null;
	public resizeHandler: (() => void) | null = null;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = null;
		this.resizeHandler = null;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

/** A trivial base component for exercising overlay compositing. */
class BaseTextComponent implements Component {
	constructor(private readonly lines: string[]) {}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

/** Strip Pi-tui's reset/escape sequences so we can assert on visible text. */
function stripTerminalOutput(writes: string[]): string {
	return writes
		.join("")
		.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
		.replace(/\x1b\][^\x07]*\x07/g, "")
		.trim();
}

/** Split captured terminal output into per-line visible text. */
function renderedLines(writes: string[]): string[] {
	return stripTerminalOutput(writes)
		.split("\r\n")
		.map((line) => line.trimEnd());
}

function createSessionSummary(
	overrides?: Partial<SessionSummary> &
		Pick<SessionSummary, "sessionId" | "updatedAt">,
): SessionSummary {
	return {
		sessionId: overrides?.sessionId ?? "11111111-1111-4111-8111-111111111111",
		title: overrides?.title === undefined ? "session" : overrides.title,
		lastCompletedUserInput:
			overrides?.lastCompletedUserInput === undefined
				? "recent user input"
				: overrides.lastCompletedUserInput,
		updatedAt: overrides?.updatedAt ?? "2026-05-22T00:00:00.000Z",
		status: overrides?.status ?? "active",
		cwd: overrides?.cwd ?? "/tmp/project",
		turnCount: overrides?.turnCount ?? 0,
		lastTurnStatus: overrides?.lastTurnStatus ?? null,
		estimatedTokens: overrides?.estimatedTokens ?? null,
	};
}

test("prepareSessionChoices sorts by updatedAt and limits results", () => {
	const sessions = [
		createSessionSummary({
			sessionId: "11111111-1111-4111-8111-111111111111",
			updatedAt: "2026-05-20T00:00:00.000Z",
		}),
		createSessionSummary({
			sessionId: "22222222-2222-4222-8222-222222222222",
			updatedAt: "2026-05-22T00:00:00.000Z",
		}),
		createSessionSummary({
			sessionId: "33333333-3333-4333-8333-333333333333",
			updatedAt: "2026-05-21T00:00:00.000Z",
		}),
	];

	const selected = prepareSessionChoices(sessions, 2);

	assert.deepEqual(
		selected.map((session) => session.sessionId),
		[
			"22222222-2222-4222-8222-222222222222",
			"33333333-3333-4333-8333-333333333333",
		],
	);
});

test("prepareSessionChoices sorts by absolute time when offsets differ", () => {
	const sessions = [
		createSessionSummary({
			sessionId: "11111111-1111-4111-8111-111111111111",
			updatedAt: "2026-05-22T00:30:00.000+08:00",
		}),
		createSessionSummary({
			sessionId: "22222222-2222-4222-8222-222222222222",
			updatedAt: "2026-05-21T20:00:00.000+00:00",
		}),
	];

	const selected = prepareSessionChoices(sessions, 2);

	assert.deepEqual(
		selected.map((session) => session.sessionId),
		[
			"22222222-2222-4222-8222-222222222222",
			"11111111-1111-4111-8111-111111111111",
		],
	);
});

test("prepareSessionChoices excludes sessions without a title", () => {
	const sessions = [
		createSessionSummary({
			sessionId: "11111111-1111-4111-8111-111111111111",
			updatedAt: "2026-05-22T00:00:00.000Z",
			title: null,
		}),
		createSessionSummary({
			sessionId: "22222222-2222-4222-8222-222222222222",
			updatedAt: "2026-05-21T00:00:00.000Z",
			title: "real question",
		}),
	];

	const selected = prepareSessionChoices(sessions);

	assert.deepEqual(
		selected.map((session) => session.sessionId),
		["22222222-2222-4222-8222-222222222222"],
	);
});

test("selector arrows change highlighted session", () => {
	const state = createSessionSelectorState([
		createSessionSummary({
			sessionId: "11111111-1111-4111-8111-111111111111",
			updatedAt: "2026-05-22T00:00:00.000Z",
		}),
		createSessionSummary({
			sessionId: "22222222-2222-4222-8222-222222222222",
			updatedAt: "2026-05-21T00:00:00.000Z",
		}),
	]);

	const movedDown = reduceSessionSelector(state, { type: "down" });
	assert.equal("selectedIndex" in movedDown ? movedDown.selectedIndex : -1, 1);

	const movedUp = reduceSessionSelector(
		"selectedIndex" in movedDown ? movedDown : state,
		{ type: "up" },
	);
	assert.equal("selectedIndex" in movedUp ? movedUp.selectedIndex : -1, 0);
});

test("selector enter returns the selected session id", () => {
	const state = createSessionSelectorState([
		createSessionSummary({
			sessionId: "11111111-1111-4111-8111-111111111111",
			updatedAt: "2026-05-22T00:00:00.000Z",
		}),
		createSessionSummary({
			sessionId: "22222222-2222-4222-8222-222222222222",
			updatedAt: "2026-05-21T00:00:00.000Z",
		}),
	]);

	const movedDown = reduceSessionSelector(state, { type: "down" });
	const resolved = reduceSessionSelector(
		"selectedIndex" in movedDown ? movedDown : state,
		{ type: "confirm" },
	);

	assert.deepEqual(resolved, {
		status: "selected",
		sessionId: "22222222-2222-4222-8222-222222222222",
	});
});

test("selector escape and ctrl+c cancel", () => {
	const state = createSessionSelectorState([
		createSessionSummary({
			sessionId: "11111111-1111-4111-8111-111111111111",
			updatedAt: "2026-05-22T00:00:00.000Z",
		}),
	]);

	assert.deepEqual(reduceSessionSelector(state, { type: "cancel" }), {
		status: "cancelled",
	});
});

test("selector render shows one line per session with message, relative time, and tokens", () => {
	const now = new Date("2026-05-22T10:05:00.000Z");
	const rendered = renderSessionSelectorWithWidth(
		createSessionSelectorState([
			createSessionSummary({
				sessionId: "aaaaaaaa-1111-4111-8111-111111111111",
				title: "find why parser skips the final token",
				updatedAt: "2026-05-22T10:00:00.000Z",
				estimatedTokens: 1800,
			}),
		]),
		100,
		now,
	);

	const lines = rendered.split("\n").filter((line) => line.startsWith("> "));
	assert.equal(lines.length, 1);
	assert.match(lines[0], /find why parser skips the final token/);
	assert.match(lines[0], /5 minutes ago/);
	assert.match(lines[0], /1\.8K/);
});

test("selector render truncates long message and shows em dash for missing tokens", () => {
	const now = new Date("2026-05-22T10:05:00.000Z");
	const rendered = renderSessionSelectorWithWidth(
		createSessionSelectorState([
			createSessionSummary({
				sessionId: "bbbbbbbb-1111-4111-8111-111111111111",
				title:
					"find why the parser skips the final token after a multiline string with trailing whitespace and comments",
				updatedAt: "2026-05-22T10:00:00.000Z",
				estimatedTokens: null,
			}),
		]),
		60,
		now,
	);

	const line = rendered.split("\n").find((l) => l.startsWith("> ")) ?? "";
	assert.match(line, /> find why the parser skips/);
	assert.match(line, /\.\.\./);
	assert.match(line, /5 minutes ago/);
	assert.match(line, /—/);
});

test("interactive selector returns the confirmed session", async () => {
	const terminal = new FakeTerminal();
	const sessionId = "11111111-1111-4111-8111-111111111111";

	const selectionPromise = selectSessionInteractive(
		[
			createSessionSummary({
				sessionId,
				updatedAt: "2026-05-22T00:00:00.000Z",
			}),
		],
		{ terminal },
	);

	// Pi-tui registers its input handler synchronously on start().
	terminal.inputHandler?.("\r");

	assert.equal(await selectionPromise, sessionId);
});

test("interactive selector handles raw arrow navigation and cancel", async () => {
	const terminal = new FakeTerminal();
	const firstId = "11111111-1111-4111-8111-111111111111";
	const secondId = "22222222-2222-4222-8222-222222222222";

	const selectionPromise = selectSessionInteractive(
		[
			createSessionSummary({
				sessionId: firstId,
				updatedAt: "2026-05-22T00:00:00.000Z",
			}),
			createSessionSummary({
				sessionId: secondId,
				updatedAt: "2026-05-21T00:00:00.000Z",
			}),
		],
		{ terminal },
	);

	terminal.inputHandler?.("\x1B[B");
	terminal.inputHandler?.("\r");

	assert.equal(await selectionPromise, secondId);

	const cancelTerminal = new FakeTerminal();
	const cancelPromise = selectSessionInteractive(
		[
			createSessionSummary({
				sessionId: firstId,
				updatedAt: "2026-05-22T00:00:00.000Z",
			}),
		],
		{ terminal: cancelTerminal },
	);

	cancelTerminal.inputHandler?.("\x1B");

	assert.equal(await cancelPromise, null);
});

test("overlay composite preserves base content under the selector (Terminal seam)", async () => {
	const terminal = new FakeTerminal();
	terminal.columns = 60;
	terminal.rows = 24;

	const tui = new TUI(terminal);
	tui.addChild(new BaseTextComponent(["BASE_ONE", "BASE_TWO"]));
	const component = new SessionSelectorComponent(
		createSessionSelectorState([
			createSessionSummary({
				sessionId: "aaaaaaaa-1111-4111-8111-111111111111",
				title: "find why the parser skips the final token",
				updatedAt: "2026-05-22T10:00:00.000Z",
			}),
		]),
	);
	tui.showOverlay(component, {
		anchor: "center",
		width: "90%",
		maxHeight: "90%",
	});
	tui.start();

	// Let Pi-tui's debounced first render flush through the Terminal seam.
	await new Promise((resolve) => setTimeout(resolve, 50));

	const lines = renderedLines(terminal.writes);

	// Both the base content and the selector modal are present in the composite.
	assert.ok(
		lines.some((line) => line.includes("BASE_ONE")),
		"base content is preserved under the overlay",
	);
	assert.ok(
		lines.some((line) =>
			line.includes("find why the parser skips the final token"),
		),
		"session selector is rendered via the overlay",
	);

	// The base line sits above the centered modal, proving the overlay
	// composited on top of (not in place of) the base content.
	const baseIndex = lines.findIndex((line) => line.includes("BASE_ONE"));
	const selectorIndex = lines.findIndex((line) => line.includes("> "));
	assert.ok(baseIndex >= 0, "base line found");
	assert.ok(
		selectorIndex > baseIndex,
		"overlay is composited below the base line",
	);

	tui.stop();
});

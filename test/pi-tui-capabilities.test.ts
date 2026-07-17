import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	type Component,
	encodeITerm2,
	encodeKitty,
	Image,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	matchesKey,
	renderImage,
	StdinBuffer,
	setCapabilities,
	setKittyProtocolActive,
	type Terminal,
	Text,
	TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { stripAnsi } from "../src/tui/ansi.js";
import {
	StatusBarComponent,
	type StatusBarModel,
} from "../src/tui/status-bar.js";

const require = createRequire(import.meta.url);

// Pi-tui's TUI schedules every render through a real `setTimeout`
// (MIN_RENDER_INTERVAL_MS) and exposes no awaitable completion signal, so a
// genuine delay is the only way to flush the render in these integration-style
// verification tests. This matches the existing Pi-tui mount tests in
// test/tui.test.ts. (Deterministic fake timers cannot intercept the engine's
// internal scheduler cleanly.)
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Terminal seam ──────────────────────────────────────────────────────────
// A minimal Terminal that records every write and lets the test drive resize
// and input by hand. This is the single boundary the verification exercises.
class FakeTerminal implements Terminal {
	columns = 20;
	rows = 5;
	writes: string[] = [];
	inputHandler: ((data: string) => void) | null = null;
	resizeHandler: (() => void) | null = null;
	kittyActive = false;

	constructor(columns?: number, rows?: number) {
		if (columns !== undefined) this.columns = columns;
		if (rows !== undefined) this.rows = rows;
	}

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
		return this.kittyActive;
	}

	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

	/** Fork TUI extensions (no-op here; Pi-tui's TUI never calls them). */
	moveTo(_row: number, _column: number): void {}
	clearRenderedRows(_rows?: number): void {}

	/** Simulate a terminal resize, then trigger the engine's resize handler. */
	resize(columns?: number, rows?: number): void {
		if (columns !== undefined) this.columns = columns;
		if (rows !== undefined) this.rows = rows;
		this.resizeHandler?.();
	}
}

// ── Frame helpers ────────────────────────────────────────────────────────────
// Pi-tui wraps each render in a synchronized-output block. Capture the most
// recent one so resize assertions compare against a self-contained redraw.
function lastSyncBlock(term: FakeTerminal): string {
	const joined = term.writes.join("");
	const start = joined.lastIndexOf("\x1b[?2026h");
	const end = joined.lastIndexOf("\x1b[?2026l");
	assert.ok(start !== -1, "expected a synchronized output block");
	return joined.slice(
		start,
		end === -1 ? undefined : end + "\x1b[?2026l".length,
	);
}

// ── Status bar model helper ──────────────────────────────────────────────────
function makeStatus(overrides: Partial<StatusBarModel> = {}): StatusBarModel {
	return {
		modelName: "claude",
		limit: 200_000,
		usedTokens: null,
		usage: null,
		cwd: "/home/user/project",
		branch: "main",
		...overrides,
	};
}

const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_DIMS = { widthPx: 1, heightPx: 1 };

// Capability presets shared across the image tests (the engine reads these at
// render time via getCapabilities()).
type ImageCaps = {
	images: "kitty" | "iterm2" | null;
	trueColor: boolean;
	hyperlinks: boolean;
};
const KITTY_CAPS: ImageCaps = {
	images: "kitty",
	trueColor: true,
	hyperlinks: true,
};
const ITERM_CAPS: ImageCaps = {
	images: "iterm2",
	trueColor: true,
	hyperlinks: true,
};
const NO_IMAGE_CAPS: ImageCaps = {
	images: null,
	trueColor: true,
	hyperlinks: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Resize: layout + viewport/scroll (Pi-tui TUI engine)
// ─────────────────────────────────────────────────────────────────────────────
test("Pi-tui TUI re-renders on resize without losing content (viewport/scroll)", async () => {
	const term = new FakeTerminal(20, 5);
	const tui = new TUI(term);
	tui.addChild(new Text("L1\nL2\nL3\nL4\nL5\nL6\nL7"));
	tui.start();
	await sleep(50);

	// Baseline: a 7-line transcript longer than the 5-row viewport is rendered
	// in full (terminal scrollback handles the viewport; nothing is dropped).
	const first = lastSyncBlock(term);
	for (const i of [1, 2, 3, 4, 5, 6, 7]) {
		assert.ok(first.includes(`L${i}`), `L${i} present in initial frame`);
	}

	// Grow taller.
	const w1 = term.writes.length;
	term.resize(20, 10);
	await sleep(50);
	const taller = term.writes.slice(w1).join("");
	assert.ok(taller.includes("\x1b[2J"), "resize triggers a full redraw");
	for (const i of [1, 2, 3, 4, 5, 6, 7]) {
		assert.ok(taller.includes(`L${i}`), `L${i} intact after growing taller`);
	}

	// Narrow (width change): lines must be re-laid-out to the new width.
	const w2 = term.writes.length;
	term.resize(12, 10);
	await sleep(50);
	const narrower = term.writes.slice(w2).join("");
	assert.ok(
		narrower.includes("\x1b[2J"),
		"width change triggers a full redraw",
	);
	for (const i of [1, 2, 3, 4, 5, 6, 7]) {
		assert.ok(narrower.includes(`L${i}`), `L${i} intact after narrowing`);
	}
	// After narrowing, L1 must be re-laid-out to the new width-12 column
	// (not carry the old width-20 padding). A width-20 leak would exceed 12
	// visible cells; this catches any stale-padding regression.
	const l1 = stripAnsi(narrower)
		.split(/\r?\n/)
		.find((l) => l.includes("L1"));
	assert.ok(l1 !== undefined, "L1 line present after narrowing");
	assert.ok(
		visibleWidth(l1) <= 12,
		"L1 re-laid-out to the new width-12 column",
	);

	// Shrink shorter than the content: long transcript must not corrupt.
	const w3 = term.writes.length;
	term.resize(12, 4);
	await sleep(50);
	const shrink = term.writes.slice(w3).join("");
	assert.ok(shrink.includes("\x1b[2J"), "shrink triggers a full redraw");
	for (const i of [1, 2, 3, 4, 5, 6, 7]) {
		assert.ok(
			shrink.includes(`L${i}`),
			`L${i} intact after shrinking (scroll)`,
		);
	}

	tui.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// Resize: status bar stays correct (Pi-tui TUI + SigPi StatusBarComponent)
// ─────────────────────────────────────────────────────────────────────────────
test("Pi-tui TUI keeps a SigPi StatusBarComponent in the frame across resize", async () => {
	// Wide enough that the full status line fits, so the model name survives.
	const term = new FakeTerminal(80, 5);
	const tui = new TUI(term);
	tui.addChild(new Text("content line"));
	tui.addChild(new StatusBarComponent(makeStatus()));
	tui.start();
	await sleep(50);

	let block = lastSyncBlock(term);
	assert.ok(block.includes("claude"), "status bar model name present at start");
	assert.ok(block.includes("main"), "status bar branch present at start");

	const w1 = term.writes.length;
	term.resize(80, 10);
	await sleep(50);
	block = term.writes.slice(w1).join("");
	assert.ok(block.includes("\x1b[2J"), "resize triggers a full redraw");
	assert.ok(block.includes("claude"), "status bar still present after resize");
	assert.ok(
		block.includes("main"),
		"status bar branch still present after resize",
	);

	tui.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Kitty keyboard-protocol negotiation
//
// The real negotiation runs inside ProcessTerminal.start(): it writes a Kitty
// capability query to the actual process.stdout and flips the global flag from
// the parsed terminal response. That path binds process.stdin/stdout, so it
// cannot be driven through the FakeTerminal seam here. Instead we verify the
// OBSERVABLE OUTCOME of negotiation: the negotiated state is exposed via the
// global flag, and — with the flag set — raw Kitty CSI-u bytes reach the
// focused component unmodified (see the forwarding test below).
test("Kitty protocol negotiation toggles the global active flag", () => {
	setKittyProtocolActive(true);
	try {
		assert.equal(isKittyProtocolActive(), true);
	} finally {
		setKittyProtocolActive(false);
	}
	assert.equal(isKittyProtocolActive(), false);
});

test("Kitty protocol disambiguates Tab from Shift+Tab (CSI-u + legacy)", () => {
	setKittyProtocolActive(true);
	try {
		// Plain Tab arrives as a raw tab or Kitty CSI-u (codepoint 9).
		assert.equal(matchesKey("\t", "tab"), true);
		assert.equal(matchesKey("\x1b[9u", "tab"), true);
		// Shift+Tab arrives as Kitty CSI-u (9;2) or legacy CSI Z.
		assert.equal(matchesKey("\x1b[9;2u", "shift+tab"), true);
		assert.equal(matchesKey("\x1b[Z", "shift+tab"), true);
		// The two must not cross-match.
		assert.equal(matchesKey("\x1b[9;2u", "tab"), false);
		assert.equal(matchesKey("\x1b[9u", "shift+tab"), false);
		assert.equal(matchesKey("\x1b[Z", "tab"), false);
		assert.equal(matchesKey("\t", "shift+tab"), false);
	} finally {
		setKittyProtocolActive(false);
	}
});

test("Kitty protocol reports key event types (press/repeat/release)", () => {
	// flag 2: <codepoint>;<mod>:3u is a release, :2u is a repeat. A plain
	// press (no :n suffix) is verified implicitly: \x1b[9;2u below is neither
	// a release nor a repeat, so it must be a press.
	assert.equal(isKeyRelease("\x1b[9;2:3u"), true);
	assert.equal(isKeyRepeat("\x1b[9;2:2u"), true);
	assert.equal(isKeyRelease("\x1b[9;2u"), false);
	assert.equal(isKeyRepeat("\x1b[9;2u"), false);
});

test("Kitty protocol disambiguates ctrl+letter via CSI-u (flag 1)", () => {
	assert.equal(matchesKey("\x1b[99;5u", "ctrl+c"), true);
	assert.equal(matchesKey("\x1b[99;5u", "ctrl+v"), false);
});

test("Pi-tui TUI forwards Kitty CSI-u sequences to the focused component", async () => {
	const term = new FakeTerminal(40, 10);
	term.kittyActive = true;
	const received: string[] = [];
	const capture: Component & { focused: boolean } = {
		focused: false,
		render: () => [],
		handleInput: (data) => received.push(data),
		invalidate: () => {},
	};
	const tui = new TUI(term);
	tui.addChild(capture);
	tui.start();
	await sleep(30);
	tui.setFocus(capture);
	term.inputHandler?.("\x1b[9;2u"); // Kitty Shift+Tab
	tui.stop();
	assert.deepEqual(
		received,
		["\x1b[9;2u"],
		"Kitty CSI-u reaches the focused component unmodified",
	);
});

// ─────────────────────────────────────────────────────────────────────────────
// Inline images (Kitty / iTerm2) on capable terminals
// ─────────────────────────────────────────────────────────────────────────────
test("encodeKitty / encodeITerm2 emit the right protocol bytes", () => {
	assert.ok(encodeKitty(PNG_B64).startsWith("\x1b_G"), "Kitty prefix");
	assert.ok(
		encodeKitty(PNG_B64).includes(PNG_B64),
		"Kitty embeds base64 payload",
	);
	assert.ok(
		encodeITerm2(PNG_B64).startsWith("\x1b]1337;File="),
		"iTerm2 inline-image prefix",
	);
});

test("renderImage emits Kitty or iTerm2 bytes per detected capability", () => {
	setCapabilities(KITTY_CAPS);
	const kitty = renderImage(PNG_B64, PNG_DIMS);
	assert.ok(
		kitty?.sequence?.startsWith("\x1b_G"),
		"kitty capability -> Kitty bytes",
	);

	setCapabilities(ITERM_CAPS);
	const iterm = renderImage(PNG_B64, PNG_DIMS);
	assert.ok(
		iterm?.sequence?.startsWith("\x1b]1337;File="),
		"iterm2 capability -> iTerm2 bytes",
	);

	setCapabilities(NO_IMAGE_CAPS);
	assert.equal(
		renderImage(PNG_B64, PNG_DIMS),
		null,
		"no image capability -> null",
	);
});

test("Pi-tui Image component renders inline image bytes through the Terminal seam", async () => {
	// Kitty-capable terminal.
	setCapabilities(KITTY_CAPS);
	const term = new FakeTerminal(40, 10);
	term.kittyActive = true;
	const tui = new TUI(term);
	tui.addChild(
		new Image(PNG_B64, "image/png", { fallbackColor: (s) => s }, {}, PNG_DIMS),
	);
	tui.start();
	await sleep(50);
	tui.stop();
	const outKitty = term.writes.join("");
	assert.ok(
		outKitty.includes("\x1b_G"),
		"Kitty image protocol emitted on capable terminal",
	);
	assert.ok(
		!outKitty.includes("\x1b]1337"),
		"no iTerm2 bytes when Kitty is preferred",
	);

	// iTerm2-capable terminal.
	setCapabilities(ITERM_CAPS);
	const term2 = new FakeTerminal(40, 10);
	term2.kittyActive = false; // iTerm2 terminal, not Kitty
	const tui2 = new TUI(term2);
	tui2.addChild(
		new Image(PNG_B64, "image/png", { fallbackColor: (s) => s }, {}, PNG_DIMS),
	);
	tui2.start();
	await sleep(50);
	tui2.stop();
	const outIterm = term2.writes.join("");
	assert.ok(
		outIterm.includes("\x1b]1337"),
		"iTerm2 image protocol emitted on capable terminal",
	);
	assert.ok(
		!outIterm.includes("\x1b_G"),
		"no Kitty bytes when iTerm2 is preferred",
	);
});

// ─────────────────────────────────────────────────────────────────────────────
// Windows Shift+Tab via the native module
// ─────────────────────────────────────────────────────────────────────────────
test("native modifier modules ship for win32 and darwin", () => {
	const pkgRoot = dirname(
		require.resolve("@earendil-works/pi-tui/package.json"),
	);
	assert.ok(
		existsSync(
			join(pkgRoot, "native/win32/prebuilds/win32-x64/win32-console-mode.node"),
		),
		"win32 x64 native module ships",
	);
	assert.ok(
		existsSync(
			join(
				pkgRoot,
				"native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node",
			),
		),
		"darwin arm64 native module ships",
	);
});

test("Windows Shift+Tab (native VT input) is distinguished from Tab", () => {
	// enableWindowsVTInput (win32-console-mode native module) re-encodes the
	// Shift+Tab key event as CSI Z on Windows so it is distinguishable from a
	// plain Tab. The native module only loads on win32/darwin, so on this
	// platform we cannot execute it; instead we verify the OBSERVABLE behavior
	// it enables — the CSI-Z key still resolves to shift+tab and not tab.
	assert.equal(matchesKey("\x1b[Z", "shift+tab"), true);
	assert.equal(matchesKey("\x1b[Z", "tab"), false);
	// And a plain Tab must not be read as Shift+Tab.
	assert.equal(matchesKey("\t", "shift+tab"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bracketed paste
// ─────────────────────────────────────────────────────────────────────────────
test("StdinBuffer delivers a complete bracketed paste as one chunk", () => {
	const buf = new StdinBuffer({ timeout: 10 });
	const pastes: string[] = [];
	buf.on("paste", (c) => pastes.push(c));
	buf.process("\x1b[200~line1\nline2\x1b[201~");
	assert.deepEqual(
		pastes,
		["line1\nline2"],
		"multi-line paste lands as one input",
	);
});

test("StdinBuffer reassembles a split bracketed paste before emitting", () => {
	const buf = new StdinBuffer({ timeout: 10 });
	const pastes: string[] = [];
	buf.on("paste", (c) => pastes.push(c));
	buf.process("\x1b[200~par");
	buf.process("tial");
	buf.process(" chunk\x1b[201~tail");
	assert.deepEqual(
		pastes,
		["partial chunk"],
		"split paste emitted once, only after the closing marker",
	);
});

test("bracketed paste content is never treated as a key release/repeat", () => {
	// isKeyRelease/isKeyRepeat must ignore content that merely contains ":3F"
	// (e.g. a Bluetooth MAC inside a paste), because pastes carry \x1b[200~.
	assert.equal(isKeyRelease("\x1b[200~90:62:3F:ab\x1b[201~"), false);
	assert.equal(isKeyRepeat("\x1b[200~90:62:2F:ab\x1b[201~"), false);
});

test("Pi-tui TUI forwards a bracketed paste to the focused component intact", async () => {
	const term = new FakeTerminal(40, 10);
	const received: string[] = [];
	const capture: Component & { focused: boolean } = {
		focused: false,
		render: () => [],
		handleInput: (data) => received.push(data),
		invalidate: () => {},
	};
	const tui = new TUI(term);
	tui.addChild(capture);
	tui.start();
	await sleep(30);
	tui.setFocus(capture);
	term.inputHandler?.("\x1b[200~multi\nline\x1b[201~");
	tui.stop();
	assert.deepEqual(
		received,
		["\x1b[200~multi\nline\x1b[201~"],
		"bracketed paste reaches the focused component intact",
	);
});

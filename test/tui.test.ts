import assert from "node:assert/strict";
import test from "node:test";
import {
	matchesKey,
	Text as PiText,
	TUI as PiTui,
	parseKey,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	createEditSummary,
	createWriteSummary,
} from "../src/tools/edit-summary.js";
import { stripAnsi } from "../src/tui/ansi.js";
import {
	FileEditComponent,
	formatFileEditResultData,
	formatFileEditSummaries,
	formatFileEditSummary,
} from "../src/tui/file-edit-renderer.js";
import {
	AssistantMessageComponent,
	SystemMessageComponent,
	ToolResultMessageComponent,
	UserMessageComponent,
} from "../src/tui/messages.js";
import { moveSelectedIndex } from "../src/tui/move-selected-index.js";
import {
	composeStatusBar as renderStatus,
	StatusBarComponent,
	type StatusBarModel,
} from "../src/tui/status-bar.js";
import {VirtualTerminal} from "../src/tui/virtual-terminal.js";

class FakeTerminal {
	public columns = 20;
	public rows = 5;
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

	moveBy(lines: number): void {
		this.write(`<moveBy:${lines}>`);
	}

	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {
		this.write("<clear-line>");
	}
	clearScreen(): void {
		this.write("<clear>");
	}
	clearFromCursor(): void {
		this.write("<clear-rest>");
	}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	moveTo(row: number, column: number): void {
		this.write(`<${row},${column}>`);
	}

	clearRenderedRows(rows = 0): void {
		this.write(`<clear-rows:${rows}>`);
	}
}

function cleanRenderedLine(line: string): string {
	return stripAnsi(line.replaceAll("\x1B_sigpi:c\x07", "")).trimEnd();
}

test("visibleWidth treats Chinese characters as double width", () => {
	assert.equal(visibleWidth("ab你好"), 6);
});

test("parseKey recognizes core terminal sequences", () => {
	assert.equal(parseKey("\x1B[A"), "up");
	assert.equal(parseKey("\x1B[B"), "down");
	assert.equal(parseKey("\r"), "enter");
	assert.equal(matchesKey("\u0003", "ctrl+c"), true);
});

test("moveSelectedIndex preserves empty lists and wraps bounded lists", () => {
	assert.equal(moveSelectedIndex(3, 0, 1), 3);
	assert.equal(moveSelectedIndex(0, 3, -1), 2);
	assert.equal(moveSelectedIndex(2, 3, 1), 0);
});

test("AssistantMessageComponent renders streamed reasoning then content (ADR 0025 A1)", () => {
	const component = new AssistantMessageComponent();
	// Empty message shows a placeholder until content arrives.
	assert.deepEqual(component.render(40).map(cleanRenderedLine), ["…"]);

	component.appendReasoning("let me think");
	component.appendContent("hello");
	const lines = component.render(40).map(cleanRenderedLine);
	assert.equal(lines[0], "▸ reasoning");
	assert.equal(lines[1], "  let me think");
	assert.equal(lines[2], "hello");

	// Unlike the retired ReasoningStreamComponent, the assistant message is a
	// permanent transcript entry — it is never cleared, only finalized.
	component.finalize();
	const after = component.render(40).map(cleanRenderedLine);
	assert.deepEqual(after, lines);
});

test("AssistantMessageComponent scrolls internally when capped (ADR 0025 A1)", () => {
	const component = new AssistantMessageComponent();
	// Each fragment is wide enough to occupy its own wrapped line; together they
	// far exceed the cap so the component must scroll internally.
	for (let i = 0; i < 10; i += 1) {
		component.appendReasoning(`${"a".repeat(50)} `);
	}
	const full = component.render(40).map(cleanRenderedLine);
	const capped = component.render(40, 5).map(cleanRenderedLine);
	// Capped render never exceeds the requested height.
	assert.equal(capped.length, 5);
	// The full (uncapped) render is taller than the cap, so scrolling happened.
	assert.ok(full.length > 5);
	// An overflow marker is shown when content was scrolled away.
	assert.match(capped[0], /more lines/);
	// The most recent content is preserved at the tail.
	assert.match(capped[capped.length - 1], /a/);
});

test("FileEditComponent output matches formatFileEditSummary exactly", () => {
	const edit = createEditSummary(
		"src/foo.ts",
		"const a = 1;\n",
		"const a = 1;",
		"const a = 2;",
		false,
	);
	const write = createWriteSummary("README.md", null, "# Title\nBody\n");

	assert.deepEqual(
		new FileEditComponent({ color: true }).setSummary(edit).render(80),
		formatFileEditSummary(edit, { color: true }),
	);
	assert.deepEqual(
		new FileEditComponent({ color: false }).setSummary(write).render(80),
		formatFileEditSummary(write, { color: false }),
	);
});

test("FileEditComponent renders an empty frame when no summary is set", () => {
	assert.deepEqual(new FileEditComponent().render(80), []);
	assert.deepEqual(new FileEditComponent().setSummary(null).render(80), []);
});

test("FileEditComponent renders a write summary (all additions, no deletions)", () => {
	const summary = createWriteSummary("README.md", null, "# Title\n");
	const lines = new FileEditComponent({ color: false })
		.setSummary(summary)
		.render(80);
	assert.equal(lines[0], "- Edited README.md (+1 -0)");
	assert.match(lines.at(-1) ?? "", /1 \+ # Title$/);
});

test("FileEditComponent mounts under Pi-tui's TUI and renders the diff", async () => {
	const terminal = new FakeTerminal();
	const tui = new PiTui(terminal);
	tui.addChild(
		new FileEditComponent({ color: false }).setSummary(
			createWriteSummary("README.md", null, "# Title\n"),
		),
	);
	tui.start();
	// Pi-tui schedules its first render on a timer; let it flush.
	await new Promise((resolve) => setTimeout(resolve, 50));
	tui.stop();

	assert.ok(
		terminal.writes.some((w) => w.includes("- Edited README.md")),
		"expected the diff header to be rendered by Pi-tui's TUI",
	);
});

test("formatFileEditSummaries/ResultData now render through FileEditComponent", () => {
	const summary = createEditSummary(
		"src/foo.ts",
		"const a = 1;\n",
		"const a = 1;",
		"const a = 2;",
		false,
	);
	// The standalone helpers must still produce identical output now that they
	// delegate to the Pi-tui Component.
	assert.deepEqual(formatFileEditSummaries([], { color: false }), []);
	assert.deepEqual(
		formatFileEditResultData({ editSummary: summary }, { color: false }),
		new FileEditComponent({ color: false }).setSummary(summary).render(0),
	);
});


test("Pi-tui TUI mounts on FakeTerminal and renders a Text component", async () => {
	const terminal = new FakeTerminal();
	const tui = new PiTui(terminal);
	tui.addChild(new PiText("hello world"));
	tui.start();
	// Pi-tui schedules its first render on a timer; let it flush.
	await new Promise((resolve) => setTimeout(resolve, 50));
	tui.stop();

	assert.ok(terminal.writes.length > 0, "expected Pi-tui TUI to write output");
	assert.ok(
		terminal.writes.some((w) => w.includes("hello world")),
		"expected the rendered Text to appear in terminal output",
	);
});

const STATUS_WIDTH = 240;

function makeModel(overrides: Partial<StatusBarModel> = {}): StatusBarModel {
	return {
		modelName: "test-model",
		limit: 183_600,
		usedTokens: null,
		usage: null,
		cwd: "/home/user/repo",
		branch: null,
		...overrides,
	};
}

test("renders the model name and a token estimate", () => {
	const line = renderStatus(makeModel({ usedTokens: 12_345 }));
	assert.match(line, /^test-model /);
	assert.match(line, /12\.3K\/183\.6K/);
});

test("omits the token estimate when usage is unknown", () => {
	const line = renderStatus(makeModel({ usedTokens: null }));
	assert.match(line, /^test-model /);
	assert.match(line, /\?\/183\.6K/);
	assert.doesNotMatch(line, /Hit/);
});

test("shows the provider's totalTokens after a response, with cache hit rate", () => {
	const line = renderStatus(
		makeModel({
			usedTokens: 1_050,
			usage: {
				input: 200,
				output: 50,
				cacheRead: 800,
				cacheWrite: 0,
				totalTokens: 1_050,
			},
		}),
	);
	// 1_050 -> 1.1K; 800 / (800 + 200) = 80.0%.
	assert.match(line, /1\.1K\/183\.6K \(1%\) Hit\(80\.0%\)/);
});

test("keeps the last response's count and does not re-estimate after a follow-up", () => {
	const line = renderStatus(
		makeModel({
			usedTokens: 1_050,
			usage: {
				input: 200,
				output: 50,
				cacheRead: 800,
				cacheWrite: 0,
				totalTokens: 1_050,
			},
		}),
	);
	assert.match(line, /1\.1K\/183\.6K/);
});

test("hides the cache hit rate when there is no cacheable input", () => {
	const line = renderStatus(
		makeModel({
			usedTokens: 50,
			usage: {
				input: 0,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 50,
			},
		}),
	);
	assert.doesNotMatch(line, /Hit/);
	assert.match(line, /50\/183\.6K \(0%\)/);
});

test("shows Hit(0.0%) for a cold cache with real input", () => {
	const line = renderStatus(
		makeModel({
			usedTokens: 1_050,
			usage: {
				input: 1_000,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_050,
			},
		}),
	);
	assert.match(line, /Hit\(0\.0%\)/);
});

test("appends the git branch when cwd is a repo", () => {
	const line = renderStatus(makeModel({ branch: "main" }));
	assert.match(line, /\/repo \(main\)$/);
});

test("shows @shortSha for a detached HEAD", () => {
	const line = renderStatus(makeModel({ branch: "@a1b2c3d" }));
	assert.match(line, /\/repo \(@a1b2c3d\)$/);
});

test("silently omits the branch segment when git lookup fails", () => {
	const line = renderStatus(makeModel({ branch: null }));
	assert.doesNotMatch(line, /\(/);
	assert.match(line, /\/home\/user\/repo$/);
});

test("includes the model name at the start with no `model ` prefix", () => {
	const line = renderStatus(
		makeModel({
			usedTokens: 1_050,
			usage: {
				input: 200,
				output: 50,
				cacheRead: 800,
				cacheWrite: 0,
				totalTokens: 1_050,
			},
		}),
	);
	assert.match(line, /^test-model /);
	assert.doesNotMatch(line, /^model /);
});

test("StatusBarComponent renders the composed status line in full (no truncation)", () => {
	const component = new StatusBarComponent(
		makeModel({ branch: "main", cwd: "/home/user/repo" }),
	);
	const lines = component.render(STATUS_WIDTH);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /test-model/);
	assert.match(lines[0], /\/repo \(main\)/);
});
test("message components never emit a line wider than the terminal (ADR 0025 render safety)", () => {
	const width = 40;
	const longToken = "x".repeat(200);

	// System message — the writeLine/writeError -> appendSystem path that
	// previously crashed the renderer with "Rendered line exceeds terminal
	// width" on long tool output / errors.
	const sys = new SystemMessageComponent(longToken, "error");
	for (const line of sys.render(width)) {
		assert.ok(
			visibleWidth(line) <= width,
			`system line exceeds width: ${visibleWidth(line)} > ${width}`,
		);
	}

	// Status bar with an over-long model/cwd/branch.
	const model: StatusBarModel = {
		modelName: "x".repeat(200),
		limit: 100000,
		usedTokens: 12345,
		usage: null,
		cwd: `/very/long/path/${"y".repeat(200)}`,
		branch: `feature/${"z".repeat(200)}`,
		eventLabel: "working on something long",
	};
	const status = new StatusBarComponent(model);
	const statusLines = status.render(width);
	assert.equal(statusLines.length, 1, "status bar stays a single line");
	for (const line of statusLines) {
		assert.ok(
			visibleWidth(line) <= width,
			`status line exceeds width: ${visibleWidth(line)} > ${width}`,
		);
	}

	// The already-wrapping components must also stay within width on a single
	// unbreakable token.
	for (const component of [
		new UserMessageComponent(longToken),
		new ToolResultMessageComponent(longToken),
		new AssistantMessageComponent(),
	]) {
		if (component instanceof AssistantMessageComponent) {
			component.appendContent(longToken);
		}
		for (const line of component.render(width)) {
			assert.ok(
				visibleWidth(line) <= width,
				`line exceeds width: ${visibleWidth(line)} > ${width}`,
			);
		}
	}
});

import assert from "node:assert/strict";
import test from "node:test";
import { Text as PiText, TUI as PiTui } from "@earendil-works/pi-tui";
import {
	type Component,
	Editor,
	matchesKey,
	moveSelectedIndex,
	parseKey,
	ReasoningStreamComponent,
	SelectList,
	StatusBarComponent,
	type StatusBarModel,
	stripAnsi,
	type Terminal,
	Tui,
	visibleWidth,
} from "../src/tui/index.js";
import { SigPiTerminal } from "../src/tui/terminal.js";

class FakeTerminal implements Terminal {
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

class TextComponent implements Component {
	constructor(private readonly lines: string[]) {}

	render(): string[] {
		return this.lines;
	}
}

test("Tui reserves the last row for a status bar", () => {
	const terminal = new FakeTerminal();
	const tui = new Tui(terminal);
	tui.addChild(new TextComponent(["row1", "row2", "row3", "row4", "row5"]));
	tui.setStatusBar("model test | chars 10/100 (10%) | /tmp/project");

	const frame = tui.renderToFrame();

	assert.equal(frame.length, 5);
	assert.equal(frame[0], "row1                ");
	assert.equal(frame[3], "row4                ");
	assert.match(frame[4] ?? "", /\/tmp\/project\s*$/);
	assert.doesNotMatch(frame[4] ?? "", /row5/);
});

test("Tui leaves rendering unchanged without a status bar", () => {
	const terminal = new FakeTerminal();
	const tui = new Tui(terminal);
	tui.addChild(new TextComponent(["row1", "row2", "row3", "row4", "row5"]));

	const frame = tui.renderToFrame();

	assert.equal(frame.length, 5);
	assert.equal(frame[4], "row5                ");
});

test("Tui truncates long status text from the left", () => {
	const terminal = new FakeTerminal();
	terminal.columns = 18;
	const tui = new Tui(terminal);
	tui.setStatusBar(
		"model opus | chars 12.3K/200K (6%) | ~/repos/claudeprojects/sigpi",
	);

	const frame = tui.renderToFrame();

	assert.equal(frame.length, 5);
	assert.match(frame[4] ?? "", /^…/);
	assert.match(frame[4] ?? "", /sigpi\s*$/);
});

test("Tui overlays stay within the content area above the status bar", () => {
	const terminal = new FakeTerminal();
	const tui = new Tui(terminal);
	tui.addChild(new TextComponent(["base"]));
	tui.setStatusBar("model test | chars 10/100 (10%) | /tmp/project");
	tui.showOverlay(new TextComponent(["overlay"]), {
		width: 7,
		anchor: "bottom-right",
	});

	const frame = tui.renderToFrame();

	assert.equal(frame[3], "             overlay");
	assert.match(frame[4] ?? "", /\/tmp\/project\s*$/);
});

test("Tui updates only the footer row when status text changes", async () => {
	const terminal = new FakeTerminal();
	const tui = new Tui(terminal);
	tui.addChild(new TextComponent(["hello"]));
	tui.setStatusBar("model test | chars 10/100 (10%) | /tmp/one");
	tui.start();
	terminal.writes = [];

	tui.setStatusBar("model test | chars 20/100 (20%) | /tmp/two");
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(terminal.writes, ["<5,1>", "…00 (20%) | /tmp/two"]);
});

test("visibleWidth treats Chinese characters as double width", () => {
	assert.equal(visibleWidth("ab你好"), 6);
});

test("parseKey recognizes core terminal sequences", () => {
	assert.equal(parseKey("\x1B[A"), "up");
	assert.equal(parseKey("\x1B[B"), "down");
	assert.equal(parseKey("\r"), "enter");
	assert.equal(matchesKey("\u0003", "ctrl+c"), true);
});

test("Tui renders children into a fixed-height frame", () => {
	const terminal = new FakeTerminal();
	const tui = new Tui(terminal);
	tui.addChild(new TextComponent(["hello", "你好"]));

	const frame = tui.renderToFrame();

	assert.equal(frame.length, 5);
	assert.equal(frame[0], "hello               ");
	assert.equal(frame[1], "你好                ");
});

test("Tui writes only changed lines after initial render", async () => {
	const terminal = new FakeTerminal();
	const line = new MutableLine("one");
	const tui = new Tui(terminal);
	tui.addChild(line);

	tui.start();
	terminal.writes = [];
	line.value = "two";
	tui.requestRender();
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(terminal.writes, ["<1,1>", "two                 "]);
});

test("focused component receives raw input", () => {
	const terminal = new FakeTerminal();
	const input = new InputRecorder();
	const tui = new Tui(terminal);
	tui.addChild(input);
	tui.setFocus(input);
	tui.start();

	terminal.inputHandler?.("abc");

	assert.equal(input.received, "abc");
});

test("Tui positions hardware cursor at editor marker", () => {
	const terminal = new FakeTerminal();
	const editor = new Editor({ prompt: "> " });
	const tui = new Tui(terminal);
	tui.addChild(editor);
	tui.setFocus(editor);
	tui.start();
	terminal.writes = [];

	terminal.inputHandler?.("你好");

	assert.equal(terminal.writes.at(-3), "<1,1>");
	assert.equal(terminal.writes.at(-2), `> 你好${" ".repeat(14)}`);
	assert.equal(terminal.writes.at(-1), "<1,7>");
});

test("overlay composes over base frame and captures focus", () => {
	const terminal = new FakeTerminal();
	const input = new InputRecorder();
	const tui = new Tui(terminal);
	tui.addChild(new TextComponent(["base"]));
	const handle = tui.showOverlay(input, {
		width: 8,
		anchor: "top-right",
	});

	const frame = tui.renderToFrame();
	tui.start();
	terminal.inputHandler?.("x");

	assert.equal(frame[0], "base        input   ");
	assert.equal(input.received, "x");
	assert.equal(handle.isFocused(), true);
});

test("Editor edits around cursor by code point and submits", () => {
	const editor = new Editor({ prompt: "> " });
	let submitted = "";
	editor.onSubmit = (text) => {
		submitted = text;
	};

	editor.handleInput("你好");
	editor.handleInput("\x1B[D");
	editor.handleInput("吗");
	editor.handleInput("\u007F");
	editor.handleInput("\r");

	assert.equal(editor.getText(), "你好");
	assert.equal(submitted, "你好");
});

test("Editor accepts bracketed paste at cursor", () => {
	const editor = new Editor();

	editor.handleInput("ab");
	editor.handleInput("\x1B[D");
	editor.handleInput("\x1B[200~x\ny\x1B[201~");

	assert.equal(editor.getText(), "ax\nyb");
});

test("Editor buffers split bracketed paste markers", () => {
	const editor = new Editor();

	editor.handleInput("ab");
	editor.handleInput("\x1B[D");
	editor.handleInput("\x1B[200~x");
	editor.handleInput("\ny\x1B[20");
	editor.handleInput("1~");

	assert.equal(editor.getText(), "ax\nyb");
});

test("Editor wraps long input and renders visible cursor", () => {
	const editor = new Editor({ prompt: "> " });
	editor.focused = true;
	editor.handleInput("abcdefghijk");

	assert.deepEqual(editor.render(10).map(cleanRenderedLine), [
		"> abcdefgh",
		"ijk",
	]);
});

test("Editor keeps cursor at Chinese insertion point", () => {
	const editor = new Editor({ prompt: "> " });
	editor.focused = true;
	editor.handleInput("你好世界");
	editor.handleInput("\x1B[D");
	editor.handleInput("\x1B[D");
	editor.handleInput("啊");

	assert.deepEqual(editor.render(20).map(cleanRenderedLine), ["> 你好啊世界"]);
});

test("Editor wraps Chinese input by display width", () => {
	const editor = new Editor({ prompt: "> " });
	editor.focused = true;
	editor.handleInput("你好世界再见");

	assert.deepEqual(editor.render(10).map(cleanRenderedLine), [
		"> 你好世界",
		"再见",
	]);
});

test("Editor cancel fires on empty ctrl+d", () => {
	const editor = new Editor();
	let cancelled = false;
	editor.onCancel = () => {
		cancelled = true;
	};

	editor.handleInput("\u0004");

	assert.equal(cancelled, true);
});

test("SelectList wraps movement and selects item", () => {
	const list = new SelectList([
		{ label: "one", value: 1 },
		{ label: "two", value: 2 },
	]);
	let selected = 0;
	list.onSelect = (item) => {
		selected = item.value;
	};

	list.handleInput("\x1B[A");
	assert.equal(list.getSelectedIndex(), 1);
	list.handleInput("\r");

	assert.equal(selected, 2);
});

test("moveSelectedIndex preserves empty lists and wraps bounded lists", () => {
	assert.equal(moveSelectedIndex(3, 0, 1), 3);
	assert.equal(moveSelectedIndex(0, 3, -1), 2);
	assert.equal(moveSelectedIndex(2, 3, 1), 0);
});

class MutableLine implements Component {
	constructor(public value: string) {}

	render(): string[] {
		return [this.value];
	}
}

class InputRecorder implements Component {
	public received = "";
	public focused = false;

	render(): string[] {
		return ["input"];
	}

	handleInput(data: string): void {
		this.received += data;
	}
}

function cleanRenderedLine(line: string): string {
	return stripAnsi(line.replaceAll("\x1B_sigpi:c\x07", "")).trimEnd();
}

test("ReasoningStreamComponent renders streamed reasoning then content (spec-0020)", () => {
	const component = new ReasoningStreamComponent();
	assert.deepEqual(component.render(40), []);

	component.appendReasoning("let me think");
	component.appendContent("hello");
	const lines = component.render(40).map(cleanRenderedLine);
	assert.equal(lines[0], "▸ reasoning");
	assert.equal(lines[1], "  let me think");
	assert.equal(lines[2], "hello");

	component.clear();
	assert.deepEqual(component.render(40), []);
});

test("ReasoningStreamComponent scrolls internally when capped (spec-0020)", () => {
	const component = new ReasoningStreamComponent();
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

test("streaming deltas repaint via diff, not a full-screen wipe (spec-0020 flicker fix)", async () => {
	const terminal = new FakeTerminal();
	const component = new ReasoningStreamComponent();
	const tui = new Tui(terminal, { clearOnStart: false, fillHeight: false });
	tui.addChild(component);
	tui.setStatusBar("model test | chars 10/100 (10%) | /tmp/project");
	tui.start();
	// Initial render establishes the previous frame.
	await new Promise((resolve) => setImmediate(resolve));
	terminal.writes = [];

	// A delta that only extends the reasoning text should rewrite only the
	// affected lines, not the whole screen (which would flicker).
	component.appendReasoning("thinking");
	tui.requestRender();
	await new Promise((resolve) => setImmediate(resolve));

	const fullWipe = terminal.writes.some((w) => w === "<clear>");
	assert.equal(fullWipe, false);
	// The status bar row (row 5) is untouched, so it must not be rewritten.
	assert.ok(!terminal.writes.includes("<5,1>"));
});

test("SigPiTerminal adapts a Pi-tui Terminal and exposes moveTo/clearRenderedRows", () => {
	const inner = new FakeTerminal();
	const terminal = new SigPiTerminal(inner);

	// Delegated Pi-tui surface.
	terminal.write("hello");
	assert.equal(inner.writes.at(-1), "hello");
	assert.equal(terminal.columns, inner.columns);
	assert.equal(terminal.rows, inner.rows);
	assert.equal(terminal.kittyProtocolActive, false);
	terminal.moveBy(2);
	assert.equal(inner.writes.at(-1), "<moveBy:2>");
	terminal.clearLine();
	assert.equal(inner.writes.at(-1), "<clear-line>");

	// SigPi-specific additions emit real escape sequences through the inner
	// terminal (they are not part of Pi-tui's Terminal interface).
	terminal.moveTo(3, 4);
	assert.ok(
		inner.writes.some((w) => w.includes("\x1B[3;4H")),
		"moveTo should emit absolute cursor positioning",
	);
	terminal.clearRenderedRows(2);
	assert.ok(
		inner.writes.some((w) => w.includes("\x1B[2A")),
		"clearRenderedRows should move the cursor back to the start row",
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

test("src/tui/index exposes Pi-tui's TUI and supporting symbols (expand phase)", async () => {
	// Import the Pi-tui surface the way a consumer would, via the fork's barrel.
	const {
		TUI: IndexTui,
		PiTui: PiTuiApi,
		PiUtils,
	} = await import("../src/tui/index.js");

	// `TUI` must resolve to Pi-tui's root class, distinct from the fork's `Tui`.
	assert.equal(IndexTui, PiTui, "TUI should be Pi-tui's class");
	assert.notEqual(IndexTui, Tui, "TUI must not be the fork's Tui");

	// Supporting Pi-tui symbols are reachable through the `PiTui` namespace.
	assert.equal(typeof PiTuiApi.Container, "function");
	assert.equal(typeof PiTuiApi.Editor, "function");
	assert.equal(typeof PiTuiApi.SelectList, "function");
	assert.equal(typeof PiTuiApi.ProcessTerminal, "function");
	assert.equal(typeof PiTuiApi.Markdown, "function");
	assert.equal(typeof PiTuiApi.CURSOR_MARKER, "string");
	assert.ok(PiTuiApi.CURSOR_MARKER.startsWith("\x1B_pi:"));

	// `showOverlay` is exposed as the Pi-tui TUI method.
	assert.equal(typeof IndexTui.prototype.showOverlay, "function");

	// Text utilities live under `PiUtils`.
	assert.equal(typeof PiUtils.visibleWidth, "function");
	assert.equal(PiUtils.visibleWidth("ab你好"), 6);
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

function renderStatus(model: StatusBarModel, width = STATUS_WIDTH): string {
	return new StatusBarComponent(model).render(width)[0] ?? "";
}

test("shows ? before the first model response (honest, not an estimate)", () => {
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

test("suffixes a progress label during a turn", () => {
	const line = renderStatus(
		makeModel({ usedTokens: 12_345, eventLabel: "thinking" }),
	);
	assert.match(line, /12\.3K\/183\.6K/);
	assert.match(line, /thinking$/);
});

test("Tui renders a StatusBarComponent as the bottom footer row", () => {
	const terminal = new FakeTerminal();
	terminal.columns = 60;
	const tui = new Tui(terminal);
	tui.addChild(new TextComponent(["row1", "row2", "row3", "row4", "row5"]));
	tui.setStatusBarComponent(
		new StatusBarComponent(makeModel({ branch: "main" })),
	);

	const frame = tui.renderToFrame();

	assert.equal(frame.length, 5);
	assert.match(frame[4] ?? "", /repo \(main\)\s*$/);
	assert.doesNotMatch(frame[4] ?? "", /row5/);
});

test("Tui truncates a long status component line from the left", () => {
	const terminal = new FakeTerminal();
	terminal.columns = 18;
	const tui = new Tui(terminal);
	tui.setStatusBarComponent(
		new StatusBarComponent(
			makeModel({ cwd: "/home/user/repos/claudeprojects/sigpi" }),
		),
	);

	const frame = tui.renderToFrame();

	assert.equal(frame.length, 5);
	assert.match(frame[4] ?? "", /^…/);
	assert.match(frame[4] ?? "", /sigpi\s*$/);
});

test("Tui updates only the footer row when the status component changes", async () => {
	const terminal = new FakeTerminal();
	const tui = new Tui(terminal);
	tui.addChild(new TextComponent(["hello"]));
	tui.setStatusBarComponent(
		new StatusBarComponent(
			makeModel({ modelName: "m", limit: 100, cwd: "/tmp/one" }),
		),
	);
	tui.start();
	terminal.writes = [];

	tui.setStatusBarComponent(
		new StatusBarComponent(
			makeModel({ modelName: "m", limit: 100, cwd: "/tmp/two" }),
		),
	);
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(terminal.writes, ["<5,1>", "m | ?/100 | /tmp/two"]);
});

test("Tui overlays stay within the content area above the status component", () => {
	const terminal = new FakeTerminal();
	terminal.columns = 40;
	const tui = new Tui(terminal);
	tui.addChild(new TextComponent(["base"]));
	tui.setStatusBarComponent(
		new StatusBarComponent(makeModel({ cwd: "/tmp/project" })),
	);
	tui.showOverlay(new TextComponent(["overlay"]), {
		width: 7,
		anchor: "bottom-right",
	});

	const frame = tui.renderToFrame();

	assert.equal(frame[3]?.trim(), "overlay");
	assert.match(frame[4] ?? "", /\/tmp\/project\s*$/);
});

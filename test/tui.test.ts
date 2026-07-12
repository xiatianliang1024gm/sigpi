import assert from "node:assert/strict";
import test from "node:test";
import {
	type Component,
	Editor,
	matchesKey,
	moveSelectedIndex,
	parseKey,
	SelectList,
	stripAnsi,
	type Terminal,
	Tui,
	visibleWidth,
} from "../src/tui/index.js";

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

	write(data: string): void {
		this.writes.push(data);
	}

	hideCursor(): void {}
	showCursor(): void {}
	clearScreen(): void {
		this.write("<clear>");
	}
	clearFromCursor(): void {
		this.write("<clear-rest>");
	}
	moveTo(row: number, column: number): void {
		this.write(`<${row},${column}>`);
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

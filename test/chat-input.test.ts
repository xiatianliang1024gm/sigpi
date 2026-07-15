import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createChatCommandDefinitions } from "../src/chat-commands.js";
import {
	readChatInput,
	startRunningTurnInputListener,
} from "../src/chat-input.js";
import { stripAnsi } from "../src/tui/index.js";

class FakeInput extends PassThrough {
	public isTTY = true;
	public isRaw = false;
	public paused = false;

	setRawMode(value: boolean): this {
		this.isRaw = value;
		return this;
	}

	override pause(): this {
		this.paused = true;
		return super.pause() as this;
	}

	override resume(): this {
		this.paused = false;
		return super.resume() as this;
	}
}

class FakeOutput extends PassThrough {
	public isTTY = true;
	public columns = 80;
	public rows = 24;
}

function collectOutput(stream: PassThrough): Promise<string> {
	return new Promise((resolve) => {
		let data = "";
		stream.on("data", (chunk) => {
			data += chunk.toString("utf8");
		});
		stream.on("end", () => resolve(data));
	});
}

function getVisibleOutput(output: string): string {
	return stripAnsi(
		output.replace(/\x1B_sigpi:c\x07|\x1B\[\?2004[hl]|\x1B\[\?25h|\n/gu, ""),
	);
}

test("readChatInput submits a normal single-line entry on Enter", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
	});

	process.nextTick(() => {
		input.write("hello");
		input.write("\r");
	});

	assert.equal(await resultPromise, "hello");
	assert.equal(input.isRaw, false);
	assert.equal(input.paused, true);
});

test("readChatInput does not clear existing chat transcript", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	output.write("assistant answer stays visible\n");
	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
	});

	process.nextTick(() => {
		input.write("next");
		input.write("\r");
		output.end();
	});

	assert.equal(await resultPromise, "next");
	const rendered = await outputText;
	assert.equal(rendered.includes("\x1B[2J"), false);
	assert.match(getVisibleOutput(rendered), /assistant answer stays visible/);
});

test("readChatInput buffers bracketed multiline paste until a final Enter", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
	});

	process.nextTick(() => {
		input.write("\x1B[200~first line\nsecond line\nthird line\x1B[201~");
		input.write("\r");
	});

	assert.equal(await resultPromise, "first line\nsecond line\nthird line");
	assert.equal(input.isRaw, false);
	assert.equal(input.paused, true);
});

test("readChatInput redraws multiline bracketed paste without stale text", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
	});

	process.nextTick(() => {
		input.write("\x1B[200~first line\nsecond line\nthird line\x1B[201~");
		input.write("\u007F");
		input.write("\r");
		output.end();
	});

	assert.equal(await resultPromise, "first line\nsecond line\nthird lin");
	const rendered = await outputText;
	const visible = getVisibleOutput(rendered);
	assert.match(visible, /> first line/);
	assert.match(visible, /second line/);
	assert.match(visible, /third lin/);
});

test("readChatInput inserts bracketed paste at the cursor position", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
	});

	process.nextTick(() => {
		input.write("ab");
		input.write("\x1B[D");
		input.write("\x1B[200~xxx\nyyy\x1B[201~");
		input.write("\r");
	});

	assert.equal(await resultPromise, "axxx\nyyyb");
});

test("readChatInput buffers split bracketed paste markers", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
	});

	process.nextTick(() => {
		input.write("\x1B[200~✅");
		input.write(" done\x1B[20");
		input.write("1~");
		input.write("\r");
		output.end();
	});

	assert.equal(await resultPromise, "✅ done");
	const rendered = await outputText;
	assert.doesNotMatch(getVisibleOutput(rendered), /\[200~|\[201~/);
});

test("readChatInput inserts typed characters at the cursor position", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
	});

	process.nextTick(() => {
		input.write("abcd");
		input.write("\x1B[D");
		input.write("\x1B[D");
		input.write("X");
		input.write("\x1B[C");
		input.write("Y");
		input.write("\r");
	});

	assert.equal(await resultPromise, "abXcYd");
});

test("readChatInput positions the cursor by display width for Chinese input", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
	});

	process.nextTick(() => {
		input.write("你好");
		input.write("\r");
		output.end();
	});

	assert.equal(await resultPromise, "你好");
	const rendered = await outputText;
	assert.match(getVisibleOutput(rendered), /> 你好/);
});

test("readChatInput moves and deletes Chinese input by code point", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
	});

	process.nextTick(() => {
		input.write("你好");
		input.write("\x1B[D");
		input.write("吗");
		input.write("\u007F");
		input.write("\u007F");
		input.write("\r");
	});

	assert.equal(await resultPromise, "好");
});

test("readChatInput backspaces before the moved cursor", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
	});

	process.nextTick(() => {
		input.write("abcd");
		input.write("\x1B[D");
		input.write("\x1B[D");
		input.write("\u007F");
		input.write("\r");
	});

	assert.equal(await resultPromise, "acd");
});

test("readChatInput treats Ctrl+C as chat exit", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
	});

	process.nextTick(() => {
		input.write("\u0003");
	});

	assert.equal(await resultPromise, null);
	assert.equal(input.isRaw, false);
	assert.equal(input.paused, true);
});

test("readChatInput renders slash command suggestions and narrows them", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
		commands: createChatCommandDefinitions(),
	});

	process.nextTick(() => {
		input.write("/");
		input.write("s");
		input.write("\r");
		output.end();
	});

	assert.equal(await resultPromise, "/s");
	const rendered = await outputText;
	assert.match(getVisibleOutput(rendered), /> \/s/);
	assert.match(rendered, /\/summary - Show context window summary/);
	assert.match(rendered, /\/session - Show current session JSON/);
	const finalPromptIndex = rendered.lastIndexOf("> /s");
	assert.notEqual(finalPromptIndex, -1);
	const finalFrame = rendered.slice(finalPromptIndex);
	assert.equal(
		finalFrame.includes("/model - Show or switch the active model"),
		false,
	);
});

test("readChatInput clears the live input and status bar before final echo", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
		statusBarText: "model test | chars 10/100 (10%) | /tmp/project",
	});

	process.nextTick(() => {
		input.write("你是谁");
		input.write("\r");
		output.end();
	});

	assert.equal(await resultPromise, "你是谁");
	const rendered = await outputText;
	assert.ok(rendered.includes("\r\x1B[J\x1B[?2004l\x1B[?25h> 你是谁\n"));
	assert.equal(
		rendered.slice(rendered.lastIndexOf("> 你是谁\n")).includes("model test"),
		false,
	);
});

test("readChatInput uses arrows and Enter to select a slash suggestion", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
		commands: createChatCommandDefinitions(),
	});

	process.nextTick(() => {
		input.write("/");
		input.write("\x1B[B");
		input.write("\x1B[B");
		input.write("\r");
		output.end();
	});

	assert.equal(await resultPromise, "/model");
	assert.match(getVisibleOutput(await outputText), /> \/model/);
});

test("readChatInput completes a unique slash suggestion on Enter", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
		commands: createChatCommandDefinitions(),
	});

	process.nextTick(() => {
		input.write("/");
		input.write("m");
		input.write("\r");
		output.end();
	});

	assert.equal(await resultPromise, "/model");
	assert.match(getVisibleOutput(await outputText), /> \/model/);
});

test("readChatInput fills the selected slash suggestion into the input on Tab", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
		commands: createChatCommandDefinitions(),
	});

	process.nextTick(() => {
		input.write("/");
		input.write("m");
		input.write("\t");
		input.write("\r");
		output.end();
	});

	// Tab fills the buffer (with trailing space) but does not submit; Enter does.
	assert.equal(await resultPromise, "/model ");
	assert.match(getVisibleOutput(await outputText), /> \/model /);
});

test("readChatInput fills the navigated suggestion on Tab", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
		commands: createChatCommandDefinitions(),
	});

	process.nextTick(() => {
		input.write("/");
		input.write("\x1B[B"); // move selection down
		input.write("\t"); // complete the now-selected suggestion
		input.write("\r");
		output.end();
	});

	// After "/", suggestions start at "/clear"; one Down selects "/compact".
	assert.equal(await resultPromise, "/compact ");
	assert.match(getVisibleOutput(await outputText), /> \/compact /);
});

test("readChatInput swallows Tab when there are no suggestions", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
		commands: createChatCommandDefinitions(),
	});

	process.nextTick(() => {
		input.write("/zzz");
		input.write("\t"); // no matching suggestion -> no-op, no literal tab
		input.write("\r");
	});

	assert.equal(await resultPromise, "/zzz");
});

test("readChatInput consumes unhandled arrow keys instead of inserting escape fragments", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
	});

	process.nextTick(() => {
		input.write("\x1B[B");
		input.write("\x1B[A");
		input.write("hello");
		input.write("\r");
	});

	assert.equal(await resultPromise, "hello");
});

test("readChatInput clears stale suggestions after deleting slash input", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
		commands: createChatCommandDefinitions(),
	});

	process.nextTick(() => {
		input.write("/");
		input.write("\u007F");
		input.write("h");
		input.write("i");
		input.write("\r");
		output.end();
	});

	assert.equal(await resultPromise, "hi");
	const rendered = await outputText;
	assert.match(rendered, /\/summary - Show context window summary/);
	const lastPromptIndex = rendered.lastIndexOf("> hi");
	assert.notEqual(lastPromptIndex, -1);
	assert.equal(rendered.slice(lastPromptIndex).includes("/summary -"), false);
});

test("readChatInput ignores empty Enter after clearing slash input", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
		commands: createChatCommandDefinitions(),
	});

	process.nextTick(() => {
		input.write("/");
		input.write("\u007F");
		input.write("\r");
		input.write("h");
		input.write("i");
		input.write("\r");
		output.end();
	});

	assert.equal(await resultPromise, "hi");
	const rendered = await outputText;
	const visible = getVisibleOutput(rendered);
	assert.match(visible, /> hi/);
	const finalPromptIndex = rendered.lastIndexOf("> hi");
	assert.notEqual(finalPromptIndex, -1);
	assert.equal(rendered.slice(finalPromptIndex).includes("/summary -"), false);
});

test("readChatInput clears whitespace-only input and waits for content", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
	});

	process.nextTick(() => {
		input.write("   ");
		input.write("\r");
		input.write("hello");
		input.write("\r");
		output.end();
	});

	assert.equal(await resultPromise, "hello");
	const rendered = await outputText;
	assert.equal(rendered.includes(">    \n"), false);
	assert.match(getVisibleOutput(rendered), /> hello/);
});

test("readChatInput keeps bracketed paste behavior without showing slash suggestions for multiline input", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
		commands: createChatCommandDefinitions(),
	});

	process.nextTick(() => {
		input.write("\x1B[200~/resume\nwith note\x1B[201~");
		input.write("\r");
		output.end();
	});

	assert.equal(await resultPromise, "/resume\nwith note");
	const rendered = await outputText;
	assert.equal(
		rendered.includes("/resume - Switch to another saved session"),
		false,
	);
});

test("running turn input listener renders and submits typed input", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);
	const submitted: string[] = [];

	const handle = startRunningTurnInputListener({
		prompt: "> ",
		input: input as never,
		output: output as never,
		onEscape: () => {
			throw new Error("should not interrupt");
		},
		onSubmit: (text) => submitted.push(text),
	});

	input.write("next question");
	input.write("\r");
	handle?.stop();
	output.end();

	assert.deepEqual(submitted, ["next question"]);
	assert.equal(input.isRaw, false);
	assert.equal(input.paused, true);
	assert.match(getVisibleOutput(await outputText), /> next question/);
});

test("running turn input listener keeps Esc as interrupt", () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	let interrupted = false;
	const submitted: string[] = [];

	const handle = startRunningTurnInputListener({
		input: input as never,
		output: output as never,
		onEscape: () => {
			interrupted = true;
		},
		onSubmit: (text) => submitted.push(text),
	});

	input.write("\x1B");
	handle?.stop();

	assert.equal(interrupted, true);
	assert.deepEqual(submitted, []);
});

test("running turn input listener prints submitted input after suspended output", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);
	const submitted: string[] = [];

	const handle = startRunningTurnInputListener({
		prompt: "> ",
		input: input as never,
		output: output as never,
		onEscape: () => {
			throw new Error("should not interrupt");
		},
		onSubmit: (text) => submitted.push(text),
	});

	input.write("queued");
	handle?.withSuspendedRendering(() => {
		output.write("[agent] still running\n");
	});
	input.write("\r");
	handle?.stop();
	output.end();

	const visible = getVisibleOutput(await outputText);
	assert.deepEqual(submitted, ["queued"]);
	assert.match(visible, /\[agent\] still running/);
	assert.match(visible, /> queued/);
	assert.ok(
		visible.indexOf("[agent] still running") < visible.lastIndexOf("> queued"),
	);
});

test("running turn input listener allocates new rows with newline at terminal bottom", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	const handle = startRunningTurnInputListener({
		prompt: "> ",
		input: input as never,
		output: output as never,
		statusBarText: "model test | chars 10/100 (10%) | /tmp/project",
		onEscape: () => {
			throw new Error("should not interrupt");
		},
		onSubmit: () => {},
	});

	input.write("你是谁");
	handle?.stop();
	output.end();

	const rendered = await outputText;
	assert.ok(rendered.includes("> 你是谁"));
	assert.ok(rendered.includes("\r\nmodel test | chars"));
});

test("running turn input listener clears its status bar on stop", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	const handle = startRunningTurnInputListener({
		prompt: "> ",
		input: input as never,
		output: output as never,
		statusBarText: "model test | chars 10/100 (10%) | /tmp/project | failed",
		onEscape: () => {
			throw new Error("should not interrupt");
		},
		onSubmit: () => {},
	});

	handle?.stop();
	output.end();

	const rendered = await outputText;
	assert.ok(rendered.includes("model test | chars"));
	assert.match(rendered, /\r\x1B\[J\x1B\[\?2004l/);
	assert.doesNotMatch(rendered, /\r\n\x1B\[J\x1B\[\?2004l/);
});

test("readChatInput wraps long input and keeps prompt on the first line", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	output.columns = 10;
	const outputText = collectOutput(output);

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
	});

	process.nextTick(() => {
		input.write("abcdefghijk");
		input.write("\r");
		output.end();
	});

	assert.equal(await resultPromise, "abcdefghijk");
	const rendered = await outputText;
	const visible = getVisibleOutput(rendered);
	assert.match(visible, /> abcdefgh/);
	assert.match(visible, /ijk/);
});

test("readChatInput shows cursor at edited Chinese insertion point", async () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const outputText = collectOutput(output);

	const resultPromise = readChatInput({
		prompt: "> ",
		input: input as never,
		output: output as never,
	});

	process.nextTick(() => {
		input.write("你好世界");
		input.write("\x1B[D");
		input.write("\x1B[D");
		input.write("啊");
		input.write("\r");
		output.end();
	});

	assert.equal(await resultPromise, "你好啊世界");
	const rendered = await outputText;
	assert.match(getVisibleOutput(rendered), /> 你好啊世界/);
});

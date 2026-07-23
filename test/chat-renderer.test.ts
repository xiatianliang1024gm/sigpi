import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ChatRenderer, TranscriptViewport } from "../src/tui/chat-renderer.js";
import { UserMessageComponent } from "../src/tui/messages.js";

// TTY-shaped fakes so `runChatReplLoop`'s `useTui` would be true; we drive
// `ChatRenderer` directly here. We deliberately do NOT call `start()` — that
// would spin Pi-tui's render loop and keep the test process alive. The view
// methods (`beginAssistantMessage`, `addToolResult`, …) work on the persistent
// `TUI` without starting its loop.
class FakeInput extends PassThrough {
	public isTTY = true;
	public isRaw = false;
	setRawMode(): this {
		return this;
	}
	override pause(): this {
		return this;
	}
	override resume(): this {
		return this;
	}
}

class FakeOutput extends PassThrough {
	public isTTY = true;
	public columns = 80;
	public rows = 24;
}

test("ChatRenderer streams reasoning then content into one transcript component (ADR 0025 A1)", () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const renderer = new ChatRenderer({
		input: input as never,
		output: output as never,
		prompt: "> ",
	});

	const originalLog = console.log;
	let logCalls = 0;
	console.log = () => {
		logCalls += 1;
	};
	try {
		const view = renderer.beginAssistantMessage();
		assert.equal(typeof view.appendReasoning, "function");
		assert.equal(typeof view.appendContent, "function");
		assert.equal(typeof view.finalize, "function");

		// Reasoning folds into the message's thinking block; content renders live.
		view.appendReasoning("let me think");
		view.appendContent("the answer");
		view.finalize();

		const visible = view.render(80).join("\n");
		assert.ok(
			visible.includes("let me think"),
			"reasoning folded into the thinking block",
		);
		assert.ok(visible.includes("the answer"), "content rendered live");

		// Tool results, system lines, and user messages are appended as
		// transcript components — never via console.log while the TUI owns
		// rendering (the ADR 0025 invariant).
		renderer.addToolResult("• read: src/cli.ts");
		renderer.appendSystem("note", "info");
		renderer.addUserMessage("hi");
	} finally {
		console.log = originalLog;
	}

	assert.equal(
		logCalls,
		0,
		"ChatRenderer must never console.log while the TUI is alive",
	);
});
test("TranscriptViewport keeps constant height so the footer line never shifts (render bug fix)", () => {
	const getRows = () => 24;
	const getFooter = () => 2; // status bar (1) + editor (1)
	const vp = new TranscriptViewport(getRows, getFooter);
	const width = 80;

	// Short transcript: top is padded with blanks, newest content anchored
	// to the bottom, and the total height is exactly rows - footerHeight.
	vp.addChild(new UserMessageComponent("hi"));
	const short = vp.render(width);
	assert.equal(short.length, 22, "constant height = rows - footer");
	assert.equal(short[21], "hi", "newest content anchored to bottom");
	assert.equal(short[0], "", "top padded with blank line");

	// Long, overflowing transcript: height MUST stay constant so the footer
	// (a sibling child below this viewport) keeps the same absolute line
	// number. If it grew, Pi-tui's differential redraw would misplace the
	// streamed answer and drop the footer repaint — the reported bug.
	for (let i = 0; i < 50; i++) {
		vp.addChild(new UserMessageComponent(`msg ${i}`));
	}
	const long = vp.render(width);
	assert.equal(long.length, 22, "height constant even when overflowing");
	assert.equal(long[21], "msg 49", "newest message still at the bottom");
});
test("TranscriptViewport scrolls up to review history and back to live tail", () => {
	const vp = new TranscriptViewport(
		() => 24,
		() => 2,
	);
	const width = 80;
	for (let i = 0; i < 60; i++) {
		vp.addChild(new UserMessageComponent(`msg ${i}`));
	}

	// Following the tail shows the newest message at the bottom.
	const tail = vp.render(width);
	assert.equal(tail.length, 22, "constant height");
	assert.equal(tail[21], "msg 59", "live tail shows newest");

	// Scroll up enough to reach the oldest message; the view anchors to
	// historical content instead of being dropped.
	vp.scrollUp();
	vp.scrollUp();
	vp.scrollUp();
	vp.scrollUp();
	vp.scrollUp();
	vp.scrollUp();
	vp.scrollUp();
	vp.scrollUp();
	vp.scrollUp();
	vp.scrollUp();
	const scrolled = vp.render(width);
	assert.notEqual(
		scrolled[21],
		"msg 59",
		"scrolling up moves off the live tail",
	);
	assert.ok(
		scrolled[0]?.includes("PgDn"),
		"scrolled view shows a keybinding hint on the top line",
	);
	assert.ok(
		scrolled.some((l) => l === "msg 0"),
		"oldest message is now reachable",
	);

	// Returning to the tail shows the newest message again.
	vp.scrollToBottom();
	const back = vp.render(width);
	assert.equal(
		back[21],
		"msg 59",
		"returning to tail shows the newest message",
	);
});
test("ChatRenderer enters and leaves the alternate screen so PageUp/PageDown reach the app", () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const written: string[] = [];
	output.write = ((s: string) => {
		written.push(s);
		return true;
	}) as never;
	const renderer = new ChatRenderer({
		input: input as never,
		output: output as never,
		prompt: "> ",
	});
	(renderer as unknown as { enterAltScreen(): void }).enterAltScreen();
	(renderer as unknown as { leaveAltScreen(): void }).leaveAltScreen();
	assert.ok(
		written.some((w) => w.includes("\x1b[?1049h")),
		"enters the alternate screen",
	);
	assert.ok(
		written.some((w) => w.includes("\x1b[?1049l")),
		"leaves the alternate screen on stop",
	);
});

// // Drives the real ChatRenderer through `start()` so the wheel input listener is
// // actually registered, then fires SGR 1006 mouse-wheel sequences through the TUI
// // input path. This is the regression test for the "can't scroll up to see
// // previous content" bug: the app lives on the alternate screen (no OS
// // scrollback), so scrolling must be owned by the in-app viewport, and the mouse
// // wheel is the gesture users expect.
// test("Mouse wheel (SGR 1006) scrolls the transcript up to older content and back down", () => {
// 	class WheelInput extends EventEmitter {
// 		public isRaw = false;
// 		setRawMode(): this {
// 			return this;
// 		}
// 		setEncoding(): void {}
// 		resume(): this {
// 			return this;
// 		}
// 		pause(): this {
// 			return this;
// 		}
// 	}
// 	class WheelOutput {
// 		public columns = 80;
// 		public rows = 30;
// 		public buf = "";
// 		write(s: string): boolean {
// 			this.buf += s;
// 			return true;
// 		}
// 		on(): void {}
// 		off(): void {}
// 		setEncoding(): void {}
// 	}
// 	const input = new WheelInput();
// 	const output = new WheelOutput();
// 	const renderer = new ChatRenderer({
// 		input: input as never,
// 		output: output as never,
// 		prompt: "> ",
// 	});
// 	renderer.start();
// 	try {
// 		assert.ok(
// 			output.buf.includes("\x1b[?1006h"),
// 			"enables SGR mouse encoding on start",
// 		);
// 		assert.ok(
// 			output.buf.includes("\x1b[?1000h"),
// 			"enables a mouse tracking mode (1000) so the wheel emits SGR button events instead of arrow keys",
// 		);
// 		output.buf = "";
//
// 		for (let i = 0; i < 60; i++) {
// 			renderer.addUserMessage(`msg ${i}`);
// 		}
// 		const tui = renderer.getTuiInstance();
// 		const render = (): void => {
// 			output.buf = "";
// 			(tui as unknown as { doRender(): void }).doRender();
// 		};
// 		const visible = (s: string): number[] => {
// 			const set = new Set<number>();
// 			for (const m of s.matchAll(/msg (\d+)/g)) set.add(Number(m[1]));
// 			return [...set].sort((a, b) => a - b);
// 		};
//
// 		render();
// 		const tail = visible(output.buf);
// 		assert.ok(tail.includes(59), "tail shows newest before wheel");
//
// 		// Wheel up from the live tail should reveal older content.
// 		input.emit("data", "\x1b[<64;1;1M");
// 		render();
// 		const afterUp = visible(output.buf);
// 		assert.ok(
// 			!output.buf.includes("msg 59"),
// 			"wheel up scrolled the newest message out of the view",
// 		);
// 		assert.ok(
// 			afterUp[0] < tail[0],
// 			"wheel up moved the view to older messages",
// 		);
//
// 		// Wheel down should move the view back toward the live tail.
// 		input.emit("data", "\x1b[<65;1;1M");
// 		render();
// 		const afterDown = visible(output.buf);
// 		assert.ok(
// 			afterDown[0] > afterUp[0],
// 			"wheel down moved the view toward newer messages",
// 		);
//
// 		// A wheel event carrying modifier bits must still scroll: some
// 		// terminals OR shift/meta/control into the SGR button code (e.g. 69 =
// 		// wheel down + shift, 68 = wheel up + shift), which the bare 64/65
// 		// check used to drop. Bit 6 (0x40) marks a wheel, bit 0 the direction.
// 		input.emit("data", "\x1b[<68;1;1M"); // wheel up + shift
// 		render();
// 		const afterShiftUp = visible(output.buf);
// 		assert.ok(
// 			afterShiftUp[0] < afterDown[0],
// 			"wheel up with modifier bits scrolls toward older content",
// 		);
// 		input.emit("data", "\x1b[<69;1;1M"); // wheel down + shift
// 		render();
// 		const afterShiftDown = visible(output.buf);
// 		assert.ok(
// 			afterShiftDown[0] > afterShiftUp[0],
// 			"wheel down with modifier bits scrolls toward newer content",
// 		);
// 	} finally {
// 		renderer.stop();
// 	}
// 	assert.ok(
// 		output.buf.includes("\x1b[?1006l"),
// 		"disables SGR mouse encoding on stop",
// 	);
// 	assert.ok(
// 		output.buf.includes("\x1b[?1000l"),
// 		"disables the mouse tracking mode on stop",
// 	);
// });

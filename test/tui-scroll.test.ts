import assert from "node:assert/strict";
import test from "node:test";
import {
	type Component,
	Container,
	matchesKey,
	TUI,
} from "@earendil-works/pi-tui";
import { TranscriptViewport } from "../src/tui/chat-renderer.js";
import { UserMessageComponent } from "../src/tui/messages.js";

// Minimal terminal that records everything written and stores the input
// callback so we can fire real key sequences through the TUI's handleInput.
class FakeTerminal {
	public columns = 80;
	public rows = 30;
	public written = "";
	private onInput?: (data: string) => void;
	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
	stop(): void {}
	write(data: string): void {
		this.written += data;
	}
	hideCursor(): void {}
	showCursor(): void {}
	moveBy(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	get kittyProtocolActive(): boolean {
		return false;
	}
	drainInput(): Promise<void> {
		return Promise.resolve();
	}
	fire(data: string): void {
		this.onInput?.(data);
	}
}

test("PageUp through the real TUI input path scrolls the transcript to older content", () => {
	const term = new FakeTerminal();
	const tui = new TUI(term as never, true);
	const vp = new TranscriptViewport(
		() => term.rows,
		() => 2,
	);
	for (let i = 0; i < 60; i++) {
		vp.addChild(new UserMessageComponent(`msg ${i}`));
	}
	tui.addChild(vp as unknown as Component);
	// Footer exactly 2 lines so available height math matches getFooterHeight.
	const footer = new Container();
	footer.addChild(new UserMessageComponent("STATUS"));
	tui.addChild(footer as unknown as Component);

	tui.addInputListener((data) => {
		if (matchesKey(data, "pageUp")) {
			vp.scrollUp();
			tui.requestRender();
			return { consume: true };
		}
		return undefined;
	});

	const render = (): void => {
		(tui as unknown as { doRender(): void }).doRender();
	};

	tui.start();
	try {
		render();
		// Initial frame shows the live tail (newest messages).
		assert.ok(
			term.written.includes("msg 59"),
			"tail shows newest before scroll",
		);

		// Fire several real PageUp keypresses through handleInput.
		term.written = "";
		for (let i = 0; i < 5; i++) {
			term.fire("\x1b[5~");
		}
		render();

		assert.ok(
			term.written.includes("msg 0") || term.written.includes("msg 1"),
			"PageUp revealed older transcript content in the rendered output",
		);
	} finally {
		tui.stop();
	}
});

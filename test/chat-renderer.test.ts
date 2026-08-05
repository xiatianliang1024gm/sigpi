import assert from "node:assert/strict";
import test from "node:test";
import { isInterruptKey } from "../src/tui/chat-renderer.js";

test("isInterruptKey matches the raw Esc and Ctrl+C bytes", () => {
	assert.equal(isInterruptKey("\x1b"), true);
	assert.equal(isInterruptKey("\x03"), true);
});

test("isInterruptKey matches Esc/Ctrl+C reported as Kitty CSI-u sequences", () => {
	// With the Kitty keyboard protocol's disambiguate-escape-codes flag, the
	// terminal reports the Escape key as `CSI 27 u` instead of a bare `\x1b`.
	// iTerm2 / Ghostty / kitty negotiate this at startup, so an exact-byte
	// check makes Esc interrupt dead on those terminals (the original bug).
	assert.equal(isInterruptKey("\x1b[27u"), true);
	// Key release events (flag 2) match too; the interrupt handler is
	// idempotent, so a trailing release is harmless.
	assert.equal(isInterruptKey("\x1b[27:3u"), true);
	// Ctrl+C reported as a CSI-u sequence with the ctrl modifier.
	assert.equal(isInterruptKey("\x1b[99;5u"), true);
});

test("isInterruptKey matches modifyOtherKeys-encoded Esc", () => {
	// xterm modifyOtherKeys format: CSI 27 ; modifiers ; keycode ~
	assert.equal(isInterruptKey("\x1b[27;1;27~"), true);
});

test("isInterruptKey rejects non-interrupt input", () => {
	assert.equal(isInterruptKey("a"), false);
	assert.equal(isInterruptKey("\x1b[A"), false); // Up arrow
	assert.equal(isInterruptKey("\x1b[9;2u"), false); // Kitty Shift+Tab
	assert.equal(isInterruptKey("\r"), false);
	// Two Escs merged inside the stdin buffer's 10ms window arrive as a
	// meta-key sequence, which is not an interrupt keypress.
	assert.equal(isInterruptKey("\x1b\x1b"), false);
});

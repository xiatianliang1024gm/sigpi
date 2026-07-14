import assert from "node:assert/strict";
import test from "node:test";
import { InputHistory } from "../src/input-history.js";

test("push records submitted lines and sits on the draft slot", () => {
	const history = new InputHistory();
	history.push("first");
	history.push("second");

	assert.equal(history.size, 2);
	assert.equal(history.isAtDraft, true);
	assert.equal(history.current(), null);
});

test("push ignores empty lines", () => {
	const history = new InputHistory();
	history.push("");

	assert.equal(history.size, 0);
});

test("push suppresses consecutive duplicates but keeps non-consecutive ones", () => {
	const history = new InputHistory();
	history.push("a");
	history.push("a");
	history.push("b");
	history.push("a");

	assert.deepEqual(["a", "b", "a"], collect(history));
});

test("prev walks toward older entries and stops at the oldest (no wrap)", () => {
	const history = new InputHistory();
	history.push("first");
	history.push("second");
	history.push("third");

	assert.equal(history.prev(), "third");
	assert.equal(history.prev(), "second");
	assert.equal(history.prev(), "first");
	assert.equal(history.prev(), null);
	assert.equal(history.prev(), null);
});

test("next walks toward newer entries and returns to the draft slot", () => {
	const history = new InputHistory();
	history.push("first");
	history.push("second");
	history.push("third");

	history.prev(); // third
	history.prev(); // second
	history.prev(); // first
	assert.equal(history.prev(), null); // at oldest

	assert.equal(history.next(), "second");
	assert.equal(history.next(), "third");
	assert.equal(history.next(), null); // back on the draft slot
	assert.equal(history.isAtDraft, true);
});

test("down from the draft slot returns null (no wrap to oldest)", () => {
	const history = new InputHistory();
	history.push("only");

	assert.equal(history.next(), null);
	assert.equal(history.isAtDraft, true);
});

test("current reflects the active entry or null on the draft slot", () => {
	const history = new InputHistory();
	history.push("first");
	history.push("second");

	assert.equal(history.current(), null);
	assert.equal(history.prev(), "second");
	assert.equal(history.current(), "second");
	assert.equal(history.prev(), "first");
	assert.equal(history.current(), "first");
});

test("resetToDraft returns to the draft slot after navigation", () => {
	const history = new InputHistory();
	history.push("first");
	history.push("second");

	history.prev();
	history.prev();
	assert.equal(history.isAtDraft, false);

	history.resetToDraft();
	assert.equal(history.isAtDraft, true);
	assert.equal(history.current(), null);
});

test("multiline entries are preserved whole", () => {
	const history = new InputHistory();
	const multiline = "line one\nline two\nline three";
	history.push(multiline);

	assert.equal(history.prev(), multiline);
	assert.equal(history.current(), multiline);
});

test("push after navigation resets position to the draft slot", () => {
	const history = new InputHistory();
	history.push("first");
	history.push("second");

	history.prev(); // second
	history.push("third");

	assert.equal(history.size, 3);
	assert.equal(history.isAtDraft, true);
	assert.equal(history.prev(), "third");
});

function collect(history: InputHistory): string[] {
	const entries: string[] = [];
	let guard = 0;
	let entry = history.prev();
	while (entry !== null && guard < 1000) {
		entries.push(entry);
		entry = history.prev();
		guard++;
	}
	return entries.reverse();
}

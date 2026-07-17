import assert from "node:assert/strict";
import test from "node:test";
import { stripThinking, ThinkingSplitter } from "../src/model/thinking.js";

test("stripThinking removes a closed <mm:think> block", () => {
	assert.equal(
		stripThinking("<mm:think>let me think</mm:think>the answer"),
		"the answer",
	);
});

test("stripThinking removes a closed <think> block", () => {
	assert.equal(stripThinking("<think>hmm</think>done"), "done");
});

test("stripThinking removes content before and after the thinking block", () => {
	assert.equal(
		stripThinking("preamble<mm:think>hidden</mm:think>postamble"),
		"preamblepostamble",
	);
});

test("stripThinking drops an unterminated thinking block to end of text", () => {
	assert.equal(stripThinking("answer<mm:think>leaked"), "answer");
});

test("stripThinking leaves plain text unchanged", () => {
	assert.equal(stripThinking("just an answer"), "just an answer");
});

test("stripThinking passes through null/undefined as null", () => {
	assert.equal(stripThinking(null), null);
	assert.equal(stripThinking(undefined), null);
});

test("ThinkingSplitter separates tagged thinking from content in one chunk", () => {
	const splitter = new ThinkingSplitter();
	const { reasoning, content } = splitter.push(
		"<mm:think>reason here</mm:think>final answer",
	);
	assert.equal(reasoning, "reason here");
	assert.equal(content, "final answer");
});

test("ThinkingSplitter handles a tag split across chunks", () => {
	const splitter = new ThinkingSplitter();
	let r = "";
	let c = "";
	for (const chunk of ["<mm:th", "ink>rea", "son</mm:think>ans", "wer"]) {
		const part = splitter.push(chunk);
		r += part.reasoning;
		c += part.content;
	}
	assert.equal(r, "reason");
	assert.equal(c, "answer");
});

test("ThinkingSplitter keeps a stray '<' that is not a tag prefix", () => {
	const splitter = new ThinkingSplitter();
	const { reasoning, content } = splitter.push("a < b and c < d");
	assert.equal(reasoning, "");
	assert.equal(content, "a < b and c < d");
});

test("ThinkingSplitter routes multiple tagged thinking blocks to reasoning", () => {
	const splitter = new ThinkingSplitter();
	const first = splitter.push("<mm:think>A</mm:think>hello");
	const second = splitter.push("<mm:think>B</mm:think>world");
	assert.equal(first.reasoning, "A");
	assert.equal(first.content, "hello");
	assert.equal(second.reasoning, "B");
	assert.equal(second.content, "world");
});

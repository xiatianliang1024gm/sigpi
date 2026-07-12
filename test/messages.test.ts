import assert from "node:assert/strict";
import test from "node:test";
import { createToolMessage } from "../src/agent/messages.js";

test("createToolMessage formats read content as raw text", () => {
	const content = [
		'const payload = "{\\"path\\":\\"C:\\\\temp\\\\file.json\\"}";',
		"const done = true;",
		"",
	].join("\n");

	const message = createToolMessage("call_1", "read", {
		ok: true,
		data: {
			path: "tmp/demo.txt",
			totalLines: 3,
			totalChars: content.length,
			returnedLineStart: 1,
			returnedLineEnd: 3,
			returnedChars: 77,
			truncated: false,
			continuation: null,
			content,
			rendered: [
				"[Read tmp/demo.txt lines 1-3 of 3 (77 chars)]",
				"=== CONTENT START ===",
				'const payload = "{\\"path\\":\\"C:\\\\temp\\\\file.json\\"}";',
				"const done = true;",
				"=== CONTENT END ===",
			].join("\n"),
		},
	});

	assert.equal(
		message.content,
		[
			"TOOL: read",
			"STATUS: ok",
			"RESULT:",
			"[Read tmp/demo.txt lines 1-3 of 3 (77 chars)]",
			"=== CONTENT START ===",
			'const payload = "{\\"path\\":\\"C:\\\\temp\\\\file.json\\"}";',
			"const done = true;",
			"=== CONTENT END ===",
		].join("\n"),
	);
});

test("createToolMessage formats read metadata and raw content", () => {
	const message = createToolMessage("call_2", "read", {
		ok: true,
		data: {
			path: "src/example.ts",
			totalLines: 20,
			totalChars: 10,
			returnedLineStart: 4,
			returnedLineEnd: 5,
			returnedChars: 10,
			truncated: false,
			continuation: null,
			content: "4 │ alpha\n5 │ beta",
			rendered: [
				"[Read src/example.ts lines 4-5 of 20 (10 chars)]",
				"=== CONTENT START ===",
				"4 │ alpha",
				"5 │ beta",
				"=== CONTENT END ===",
			].join("\n"),
		},
	});

	assert.equal(
		message.content,
		[
			"TOOL: read",
			"STATUS: ok",
			"RESULT:",
			"[Read src/example.ts lines 4-5 of 20 (10 chars)]",
			"=== CONTENT START ===",
			"4 │ alpha",
			"5 │ beta",
			"=== CONTENT END ===",
		].join("\n"),
	);
});

test("createToolMessage formats tool errors with explicit details", () => {
	const message = createToolMessage("call_3", "edit", {
		ok: false,
		error: "Exact old block not found.",
		details: {
			block: 2,
			reason: "no_match",
		},
	});

	assert.equal(
		message.content,
		[
			"TOOL: edit",
			"STATUS: error",
			"ERROR: Exact old block not found.",
			"DETAILS:",
			"block: 2",
			"reason: no_match",
		].join("\n"),
	);
});

test("createToolMessage picks a non-conflicting raw-content end marker", () => {
	const content = ["alpha", "=== CONTENT END ===", "omega"].join("\n");

	const message = createToolMessage("call_4", "read", {
		ok: true,
		data: {
			path: "tmp/marker.txt",
			truncated: false,
			content,
			rendered: [
				"[Read tmp/marker.txt (24 chars total)]",
				"=== CONTENT START ===",
				"alpha",
				"=== CONTENT END ===",
				"omega",
				"=== CONTENT END ===_1",
			].join("\n"),
		},
	});

	assert.match(message.content, /=== CONTENT END ===_1$/);
	assert.match(
		message.content,
		/=== CONTENT START ===\nalpha\n=== CONTENT END ===\nomega\n=== CONTENT END ===_1$/u,
	);
});

test("createToolMessage preserves truncation guidance outside raw file content", () => {
	const message = createToolMessage("call_5", "read", {
		ok: true,
		data: {
			path: "tmp/demo.txt",
			totalLines: 10,
			totalChars: 10,
			returnedLineStart: 1,
			returnedLineEnd: 1,
			returnedChars: 10,
			truncated: true,
			continuation: {
				path: "tmp/demo.txt",
				nextOffset: 1,
				suggestedLimit: 100,
			},
			content: "1 │ abcdefghij",
			rendered: [
				"[Read tmp/demo.txt lines 1-1 of 10 (10 chars)]",
				"=== CONTENT START ===",
				"1 │ abcdefghij",
				"=== CONTENT END ===",
				'[PARTIAL view – received lines 1-1 of 10 (10 of 51200 chars used). Use read({"file_path":"tmp/demo.txt","offset":1,"limit":100}) to continue reading from line 2.]',
			].join("\n"),
		},
	});

	assert.match(message.content, /PARTIAL view/);
	assert.equal(message.content.includes("guess offsets\nabcd"), false);
	assert.equal(message.content.includes("1 │ abcdefghij"), true);
});

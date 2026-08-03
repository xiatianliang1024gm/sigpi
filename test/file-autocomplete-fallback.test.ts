import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { withAtFileFallback } from "../src/file-autocomplete-fallback.js";

// `@`-file completion in pi-tui@0.80.3 only works when the `fd` binary is
// installed. SigPi's runtime shim (withAtFileFallback) restores it by asking
// the provider's native synchronous file listing when the provider itself
// returns nothing for an `@`-prefix. These tests pin that behaviour so the
// Windows/no-fd case keeps working without any postinstall patch.

function makeProvider(files: Record<string, string>): {
	provider: CombinedAutocompleteProvider;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "sigpi-autocomplete-"));
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	const provider = withAtFileFallback(
		new CombinedAutocompleteProvider([], dir),
	);
	return {
		provider,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function lineWithCursor(text: string): { lines: string[]; col: number } {
	return { lines: [text], col: text.length };
}

test("at-file fallback completes a file for an @-prefix when fd is missing", async () => {
	const { provider, cleanup } = makeProvider({ "notes.txt": "hello" });
	try {
		const { lines, col } = lineWithCursor("cat @notes");
		const result = await provider.getSuggestions(lines, 0, col, {
			signal: new AbortController().signal,
		});
		assert.ok(result, "expected a completion result");
		assert.equal(result.prefix, "@notes");
		assert.ok(
			result.items.some((item) => item.value.includes("notes.txt")),
			`expected notes.txt in ${JSON.stringify(result.items)}`,
		);
	} finally {
		cleanup();
	}
});

test("at-file fallback returns null when no file matches the @-prefix", async () => {
	const { provider, cleanup } = makeProvider({ "notes.txt": "hello" });
	try {
		const { lines, col } = lineWithCursor("cat @missing");
		const result = await provider.getSuggestions(lines, 0, col, {
			signal: new AbortController().signal,
		});
		assert.equal(result, null);
	} finally {
		cleanup();
	}
});

test("at-file fallback does not disturb slash-command completions", async () => {
	const { provider, cleanup } = makeProvider({ "notes.txt": "hello" });
	try {
		const { lines, col } = lineWithCursor("/model");
		const result = await provider.getSuggestions(lines, 0, col, {
			signal: new AbortController().signal,
		});
		assert.equal(result, null); // no commands registered -> no suggestion
	} finally {
		cleanup();
	}
});

test("at-file fallback completes directory contents for a trailing slash", async () => {
	const { provider, cleanup } = makeProvider({
		"docs/a.md": "a",
		"docs/b.md": "b",
	});
	try {
		const { lines, col } = lineWithCursor("cat @docs/");
		const result = await provider.getSuggestions(lines, 0, col, {
			signal: new AbortController().signal,
		});
		assert.ok(result, "expected a completion result for directory listing");
		assert.ok(
			result.items.some((item) => item.value.includes("a.md")),
			`expected docs/a.md in ${JSON.stringify(result.items)}`,
		);
	} finally {
		cleanup();
	}
});

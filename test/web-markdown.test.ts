import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

/**
 * Unit tests for the browser client's dependency-free Markdown renderer
 * (`src/server/web/markdown.js`). It produces DOM nodes, so it runs against a
 * jsdom document; the module never captures `document` at import time (only on
 * each call), so installing the global here is sufficient.
 */
const markdownUrl = new URL("../src/server/web/markdown.js", import.meta.url);

interface Renderer {
	renderMarkdown: (text: string) => DocumentFragment;
}

let cached: Renderer | null = null;

async function loadRenderer(): Promise<Renderer> {
	if (!cached) {
		const dom = new JSDOM("<!doctype html><body></body>");
		(globalThis as { document?: Document }).document = dom.window.document;
		cached = (await import(markdownUrl.href)) as Renderer;
	}
	return cached;
}

/** Render `text` and return a detached container holding the result. */
async function render(text: string): Promise<HTMLElement> {
	const { renderMarkdown } = await loadRenderer();
	const container = document.createElement("div");
	container.append(renderMarkdown(text));
	return container;
}

test("renders headings, paragraphs, and unordered lists", async () => {
	const el = await render("# Title\n\nHello **world**\n\n- one\n- two");
	assert.equal(el.querySelector("h1")?.textContent, "Title");
	assert.equal(el.querySelector("p")?.textContent, "Hello world");
	assert.equal(el.querySelector("strong")?.textContent, "world");
	assert.deepEqual(
		Array.from(el.querySelectorAll("ul li")).map((li) => li.textContent),
		["one", "two"],
	);
});

test("renders ordered lists and blockquotes", async () => {
	const el = await render("1. first\n2. second\n\n> quoted line");
	assert.deepEqual(
		Array.from(el.querySelectorAll("ol li")).map((li) => li.textContent),
		["first", "second"],
	);
	assert.equal(el.querySelector("blockquote")?.textContent, "quoted line");
});

test("preserves fenced code blocks verbatim with their language", async () => {
	const el = await render("```ts\nconst x = 1 < 2;\n```");
	const pre = el.querySelector("pre");
	assert.ok(pre, "a fenced block becomes a <pre>");
	assert.equal(pre.querySelector("code")?.textContent, "const x = 1 < 2;");
	assert.equal(pre.querySelector("code")?.className, "language-ts");
});

test("renders inline code without interpreting embedded HTML", async () => {
	const el = await render("Use `<b>raw</b>` here");
	assert.equal(el.querySelector("code")?.textContent, "<b>raw</b>");
	assert.equal(el.querySelector("b"), null, "HTML is never injected");
	assert.match(el.textContent ?? "", /<b>raw<\/b>/);
});

test("only linkifies safe hrefs", async () => {
	const el = await render(
		"[ok](https://example.com) and [bad](javascript:alert(1))",
	);
	const links = Array.from(el.querySelectorAll("a"));
	assert.equal(links.length, 2);
	assert.equal(links[0]?.getAttribute("href"), "https://example.com");
	assert.equal(links[0]?.getAttribute("rel"), "noopener noreferrer");
	assert.equal(
		links[1]?.getAttribute("href"),
		null,
		"an unsafe scheme is rendered as plain text",
	);
});

test("parses several emphasis spans without losing its place", async () => {
	// Regression guard: recursion during **bold** must not clobber the outer
	// scan position (a shared-regex bug would drop or loop on later spans).
	const el = await render("**bold** then *italic* and **again**");
	assert.deepEqual(
		Array.from(el.querySelectorAll("strong")).map((s) => s.textContent),
		["bold", "again"],
	);
	assert.equal(el.querySelector("em")?.textContent, "italic");
});

test("renders horizontal rules and a trailing paragraph", async () => {
	const el = await render("intro\n\n---\n\npartial");
	assert.notEqual(el.querySelector("hr"), null);
	assert.deepEqual(
		Array.from(el.querySelectorAll("p")).map((p) => p.textContent),
		["intro", "partial"],
	);
});

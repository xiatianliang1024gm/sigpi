import assert from "node:assert/strict";
import test from "node:test";
import { CompactionFailedError } from "../src/agent/compaction-error.js";
import {
	extractSummaryFromResponse,
	SUMMARIZATION_PROMPT,
	summarize,
	UPDATE_SUMMARIZATION_PROMPT,
} from "../src/agent/summarizer.js";
import type { Message } from "../src/types.js";
import { MockProvider } from "./helpers.js";

function transcriptMessage(content: string): Message {
	return { role: "user", content };
}

test("summarize assembles the prompt from transcript and previous summary", async () => {
	const provider = new MockProvider(
		() => ({
			assistantText: "<summary>summarized</summary>",
			toolCalls: [],
			finishReason: "stop",
		}),
		{ maxTokens: 4096 },
	);

	await summarize(provider, {
		systemPrompt: "You are a test agent.",
		messages: [
			transcriptMessage("There is a regression in export."),
			{ role: "assistant", content: "Investigating." },
		],
		previousSummary: "Prior summary.",
		reserveTokens: 16_384,
	});

	const request = provider.requests[0];
	const userPrompt = request.messages[2].content as string;
	assert.match(userPrompt, /There is a regression in export\./);
	assert.match(userPrompt, /Prior summary\./);
	// previous summary present → uses the update (not create) prompt
	assert.match(userPrompt, /incorporate into the existing summary/);
	// token budget: min(0.8 * 16384, providerMax 4096) = 4096
	assert.equal(request.maxTokens, 4096);
});

test("summarize falls back to an 8192 budget when the provider exposes no max_tokens", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "<summary>summarized</summary>",
		toolCalls: [],
		finishReason: "stop",
	}));
	await summarize(provider, {
		systemPrompt: "You are a test agent.",
		messages: [transcriptMessage("hi")],
		previousSummary: null,
		reserveTokens: 16_384,
	});
	// min(0.8 * 16384 ≈ 13107, fallback 8192) = 8192 — large enough for the
	// <analysis> + 8-section <summary> structure on a full-size compaction.
	assert.equal(provider.requests[0].maxTokens, 8192);
});

test("summarize uses the create prompt when there is no previous summary", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "<summary>first</summary>",
		toolCalls: [],
		finishReason: "stop",
	}));
	await summarize(provider, {
		systemPrompt: "You are a test agent.",
		messages: [transcriptMessage("hi")],
		previousSummary: null,
		reserveTokens: 16_384,
	});
	const userPrompt = provider.requests[0].messages[2].content as string;
	assert.match(userPrompt, /conversation history to summarize/);
	assert.doesNotMatch(userPrompt, /incorporate into the existing summary/);
});

test("summarize throws CompactionFailedError when output is truncated", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "<summary>partial</summary>",
		toolCalls: [],
		finishReason: "length",
	}));
	await assert.rejects(
		summarize(provider, {
			systemPrompt: "s",
			messages: [transcriptMessage("x")],
			previousSummary: null,
			reserveTokens: 16_384,
		}),
		(err) => err instanceof CompactionFailedError && err.reason === "truncated",
	);
});

test("summarize throws CompactionFailedError when no usable summary is returned", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "<analysis>thinking only</analysis>",
		toolCalls: [],
		finishReason: "stop",
	}));
	await assert.rejects(
		summarize(provider, {
			systemPrompt: "s",
			messages: [transcriptMessage("x")],
			previousSummary: null,
			reserveTokens: 16_384,
		}),
		(err) => err instanceof CompactionFailedError && err.reason === "empty",
	);
});

test("summarize throws CompactionFailedError when the provider content-filters the summary", async () => {
	const provider = new MockProvider(() => ({
		assistantText: "",
		toolCalls: [],
		finishReason: "content_filter",
	}));
	await assert.rejects(
		summarize(provider, {
			systemPrompt: "s",
			messages: [transcriptMessage("x")],
			previousSummary: null,
			reserveTokens: 16_384,
		}),
		(err) =>
			err instanceof CompactionFailedError &&
			err.reason === "summarize_error" &&
			/content filter/i.test(err.message),
	);
});

test("extractSummaryFromResponse keeps only the <summary> block", () => {
	assert.equal(
		extractSummaryFromResponse(
			"<analysis>scratch</analysis>\n<summary>final</summary>",
		),
		"final",
	);
});

test("extractSummaryFromResponse prefers the last <summary> block over a sketch in <analysis>", () => {
	assert.equal(
		extractSummaryFromResponse(
			"<analysis>format sketch: <summary>draft</summary></analysis>\n<summary>final</summary>",
		),
		"final",
	);
});

test("extractSummaryFromResponse returns null for an empty <summary> block", () => {
	assert.equal(
		extractSummaryFromResponse(
			"<analysis>scratch</analysis>\n<summary>   </summary>",
		),
		null,
	);
});

test("extractSummaryFromResponse returns null for an unterminated <summary> block", () => {
	// The model started the block and was cut off; the raw "<summary>…" tag
	// text must not be returned as the summary.
	assert.equal(
		extractSummaryFromResponse(
			"<analysis>scratch</analysis>\n<summary>Primary",
		),
		null,
	);
});

test("extractSummaryFromResponse falls back to the full response without tags", () => {
	assert.equal(
		extractSummaryFromResponse(
			"## Goal\nKeep the export command working\n## Next Steps\nInvestigate",
		),
		"## Goal\nKeep the export command working\n## Next Steps\nInvestigate",
	);
});

test("extractSummaryFromResponse strips a leading <analysis> block as fallback", () => {
	assert.equal(
		extractSummaryFromResponse("<analysis>scratch</analysis>\nreal content"),
		"real content",
	);
});

test("summarization prompts instruct analysis, summary, and verbatim user messages", () => {
	assert.match(SUMMARIZATION_PROMPT, /<analysis>/);
	assert.match(SUMMARIZATION_PROMPT, /<\/analysis>/);
	assert.match(SUMMARIZATION_PROMPT, /<summary>/);
	assert.match(SUMMARIZATION_PROMPT, /<\/summary>/);
	assert.match(SUMMARIZATION_PROMPT, /verbatim/i);
	assert.match(SUMMARIZATION_PROMPT, /non-tool user message/i);

	assert.match(UPDATE_SUMMARIZATION_PROMPT, /<analysis>/);
	assert.match(UPDATE_SUMMARIZATION_PROMPT, /<summary>/);
	assert.match(UPDATE_SUMMARIZATION_PROMPT, /verbatim/i);
});

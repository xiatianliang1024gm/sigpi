import type { Message, ModelProvider } from "../types.js";
import { CompactionFailedError } from "./compaction-error.js";
import {
	createSystemMessage,
	createUserMessage,
	renderMessagesForSummary,
} from "./messages.js";

const SUMMARIZATION_SYSTEM_PROMPT = [
	"You are a context summarization assistant.",
	"Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.",
	"Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.",
	"Structure your response as two parts: first a brief <analysis>...</analysis> block where you reason about what must be preserved (this is scratch space and is discarded), then a <summary>...</summary> block containing the final summary that enters the working context. Only the <summary> block is kept; the <analysis> block is stripped.",
].join(" ");

export const SUMMARIZATION_PROMPT = `The transcript above is conversation history to summarize. Create a structured checkpoint that another LLM will use to continue the work without re-reading files. Write for an audience with zero prior context.

If a <custom-instructions> block is present, treat its contents as additional user-provided instructions for THIS compaction only — they override the structure below where they conflict.

Preserve EVERY non-tool user message verbatim in the ## User Messages section. Quote them exactly — do not paraphrase or drop any.

Structure your response as: an <analysis>...</analysis> block where you reason about what must be preserved (scratch space, discarded), followed by a <summary>...</summary> block with the final summary. Inside the <summary> block, use this EXACT format:

## Primary Request
[One sentence stating what the user wants to accomplish, plus any hard constraints.]

## Key Concepts
- [Technical terminology, design patterns, architectural decisions the agent reasoned about]
- [Include function names, type names, config keys, and their roles — verbatim, not paraphrased]
- [Or "(none)" if the session had no technical depth]

## Files & Code
- [Every file path the agent read, with line/byte range if partial]
- [Every file path the agent modified, with a one-sentence description of what changed]
- [Include critical code snippets (function signatures, key logic) so the next turn doesn't need to re-read]
- [List rejected paths and searches that turned up nothing, to avoid repeating them]

## User Messages
[Every non-tool user message, quoted verbatim. Preserve the original wording — these are instructions, preferences, and decisions that constrain future work.]

## Errors & Diagnostics
- **Introduced**: [Errors caused by our changes — include exact messages, file paths, and line numbers]
- **Pre-existing**: [Errors confirmed to exist before our changes, e.g. via git stash or main-branch check]
- [Or "(none)" if no errors were encountered]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Ongoing work]

### Blocked
- [Blockers, if any]

## Current Work
[The exact action or task in flight when compaction hit. Include what was just done and the immediate next action. Be specific: what function was being edited, what test was being fixed, what commit was being prepared.]

## Next Steps
1. [Ordered list of concrete next actions — commands, edits, commits]

Keep every section concise but precise. Quote identifiers, file paths, and error messages verbatim. The next turn depends on your summary to resume without re-reading files — missing details cause wasted work.`;

export const UPDATE_SUMMARIZATION_PROMPT = `The transcript above contains NEW conversation history to incorporate into the existing summary provided in <previous-summary> tags.

If a <custom-instructions> block is present, treat its contents as additional user-provided instructions for THIS compaction only — they override the structure below where they conflict.

Preserve EVERY non-tool user message verbatim in the ## User Messages section. Quote them exactly — do not paraphrase or drop any.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing Primary Requests unless the user explicitly changed or cancelled them
- PRESERVE all existing Key Concepts, constraints, preferences, unresolved tasks, blockers, and file lists
- ADD new files, code snippets, commands, concepts, errors, and user messages from the new transcript
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Current Work" to reflect what was happening right before this compaction
- UPDATE "Next Steps" based on what was accomplished and what remains
- In "Errors & Diagnostics", keep the introduced/pre-existing distinction. If a previously-listed error turns out to be pre-existing, reclassify it.
- If something is no longer relevant, you may remove it

Structure your response as: an <analysis>...</analysis> block where you reason about what must be preserved (scratch space, discarded), followed by a <summary>...</summary> block with the updated summary. Inside the <summary> block, use this EXACT format:

## Primary Request
[Preserve existing, add new if the task expanded]

## Key Concepts
[Preserve existing, add new terminology/decisions]

## Files & Code
[Preserve existing paths and snippets, add newly read/modified files]

## User Messages
[Preserve existing verbatim quotes, append new ones]

## Errors & Diagnostics
[Preserve existing, add new — maintain introduced vs pre-existing distinction]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Update based on current state]

### Blocked
- [Update — remove if resolved, add new if discovered]

## Current Work
[Replace with the exact action in flight when this compaction hit]

## Next Steps
1. [Update based on current state]

Keep every section concise but precise. Quote identifiers, file paths, and error messages verbatim. The next turn depends on your summary to resume without re-reading files — missing details cause wasted work.`;

interface SummarizeArgs {
	systemPrompt: string;
	/** Messages to summarize. The caller is responsible for micro-compacting tool results first. */
	messages: Message[];
	previousSummary: string | null;
	instructions?: string;
	requestContext?: { turnId?: string };
	reserveTokens: number;
	runId?: string;
	sessionId?: string;
	abortSignal?: AbortSignal;
}

/**
 * Turn a window of conversation into a structured summary via the model.
 *
 * Owns the summarization-specific concerns only: assembling the prompt
 * (transcript + previous summary + exploration details + custom instructions,
 * choosing the create-vs-update prompt), sizing the summary budget from the
 * reserve tokens and the provider's `maxTokens`, calling the model, and
 * extracting/validating the result. Compaction *triggering* (split index,
 * token thresholds, hard-limit trim) stays in `ConversationContext`.
 *
 * Throws `CompactionFailedError` with `reason: "truncated"` when the model
 * hits its output limit, `reason: "empty"` when no usable summary is
 * returned, or `reason: "summarize_error"` when the provider blocks the
 * output (content filter).
 */
export async function summarize(
	provider: ModelProvider,
	args: SummarizeArgs,
): Promise<string> {
	if (args.abortSignal?.aborted) {
		throw args.abortSignal.reason instanceof Error
			? args.abortSignal.reason
			: new DOMException("Aborted", "AbortError");
	}
	const transcript = renderMessagesForSummary(args.messages);
	const customInstructions = args.instructions?.trim();
	const prompt = args.previousSummary
		? [
				`<conversation>\n${transcript}\n</conversation>`,
				`<previous-summary>\n${args.previousSummary}\n</previous-summary>`,
				customInstructions
					? `<custom-instructions>\n${customInstructions}\n</custom-instructions>`
					: null,
				UPDATE_SUMMARIZATION_PROMPT,
			]
				.filter(Boolean)
				.join("\n\n")
		: [
				`<conversation>\n${transcript}\n</conversation>`,
				customInstructions
					? `<custom-instructions>\n${customInstructions}\n</custom-instructions>`
					: null,
				SUMMARIZATION_PROMPT,
			]
				.filter(Boolean)
				.join("\n\n");

	// Size the summary output against the model's reserve budget, capped at
	// the model's `max_tokens` when the provider exposes one. Falls back to
	// 8192 when neither is known: 2048 proved too small for the mandated
	// <analysis> + 8-section <summary> structure on real sessions — with a
	// reasoning model the analysis block alone consumed most of the budget
	// and the summary request truncated before finishing the verbatim user
	// messages. 8192 sits inside the reserve-derived ceiling (0.8 × 16384 ≈
	// 13107 with defaults) and matches common provider output caps (e.g.
	// DeepSeek's 8k). A 256 floor protects against degenerate micro-budgets
	// when `reserveTokens` is unusually low.
	const providerMaxTokens = provider.maxTokens ?? 8192;
	const summaryMaxTokens = Math.max(
		256,
		Math.min(Math.floor(0.8 * args.reserveTokens), providerMaxTokens),
	);

	const response = await provider.generate({
		messages: [
			createSystemMessage(args.systemPrompt),
			createSystemMessage(SUMMARIZATION_SYSTEM_PROMPT),
			createUserMessage(prompt),
		],
		tools: [],
		temperature: 0,
		maxTokens: summaryMaxTokens,
		context: {
			runId: args.runId,
			sessionId: args.sessionId,
			turnId: args.requestContext?.turnId,
			purpose: "summary",
		},
		abortSignal: args.abortSignal,
	});

	const rawSummaryText = response.assistantText?.trim() ?? "";
	const summaryText = extractSummaryFromResponse(rawSummaryText);
	if (response.finishReason === "length") {
		throw new CompactionFailedError("Summary model output was truncated.", {
			reason: "truncated",
		});
	}
	// The transport deliberately lets content-filtered responses through for
	// purpose "summary" (see transport.ts), so classify the refusal here
	// instead of misreporting it as an empty model response.
	if (response.finishReason === "content_filter") {
		throw new CompactionFailedError(
			"Summary model output was blocked by the provider's content filter.",
			{ reason: "summarize_error" },
		);
	}

	if (!summaryText) {
		const detail = rawSummaryText
			? `response contained no complete <summary> block; preview: ${JSON.stringify(rawSummaryText.slice(0, 200))}`
			: "response was empty";
		throw new CompactionFailedError(
			`Summary model returned no usable summary (finishReason=${response.finishReason ?? "none"}, ${detail}).`,
			{
				reason: "empty",
			},
		);
	}

	return summaryText;
}

/**
 * Extract the final <summary> block from a summarization response. If the model
 * omitted the tags, fall back to the whole text (after stripping a single
 * leading <analysis> scratch block) so a good summary is never discarded over
 * a formatting miss. Returns null only when there is genuinely no usable
 * summary text: an empty response, an <analysis>-only response, an empty
 * <summary></summary> block, or an unterminated <summary> block (the model
 * started the block and was cut off — the raw tag text must not be injected
 * into the working context).
 */
export function extractSummaryFromResponse(text: string): string | null {
	// Prefer the LAST complete <summary> block: the prompt's <analysis> is
	// scratch space and may sketch the format, so the first match is not
	// necessarily the final summary.
	const matches = [...text.matchAll(/<summary>([\s\S]*?)<\/summary>/gi)];
	if (matches.length > 0) {
		const content = matches[matches.length - 1]?.[1]?.trim() ?? "";
		return content || null;
	}
	// An opening <summary> tag with no closing tag means the model began the
	// block and was cut off. The no-tags fallback below would otherwise
	// return the raw "<summary>…" text as the "summary".
	if (/<summary>/i.test(text)) {
		return null;
	}
	const stripped = text
		.replace(/^\s*<analysis>[\s\S]*?<\/analysis>\s*/i, "")
		.trim();
	return stripped || null;
}

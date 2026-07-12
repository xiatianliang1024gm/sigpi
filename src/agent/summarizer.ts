import type { ExplorationLedger, Message, ModelProvider } from "../types.js";
import { CompactionFailedError } from "./compaction-error.js";
import { renderExplorationDetails } from "./exploration-ledger.js";
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

export const SUMMARIZATION_PROMPT = `The transcript above is conversation history to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

If a <custom-instructions> block is present, treat its contents as additional user-provided instructions for THIS compaction only — they override the structure below where they conflict (e.g. "summarize as bullet list", "focus on the database schema").

Preserve EVERY non-tool user message verbatim. Quote user instructions, preferences, and requests exactly so the next phase can honor them; do not paraphrase or drop any user message.

Structure your response as: an <analysis>...</analysis> block where you reason about what must be preserved (scratch space, discarded), followed by a <summary>...</summary> block with the final summary. Inside the <summary> block, use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, exact file paths, function names, commands, tool results, or error messages needed to continue]
- [Include important facts from <exploration-ledger>: searched queries, candidate files, read ranges, modified files, and rejected paths]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve the current user goal, unresolved work, constraints, exact file paths, function names, commands, and error messages.

## REQUIRED FACTS (HARD CONSTRAINTS)
Your summary MUST include every one of these when present in the transcript. Omitting any of them will cause a re-read loop. If a category does not apply, write "(none)".
1. **Files read** — every file path the agent read, with the byte range or line range if the read was partial.
2. **Files written / patched** — every path that was modified, plus a one-sentence description of what changed.
3. **Commands run** — every shell command the agent executed and its exit status / key output line.
4. **Errors and diagnostics** — exact error messages, stack traces, file paths, and line numbers from tool failures.
5. **Symbols and identifiers** — exact function names, class names, type names, variable names, and config keys the agent is reasoning about.
6. **User-visible decisions and preferences** — choices the user stated (style, library, naming) that constrain future work.

Do NOT paraphrase identifiers or error messages. Quote them verbatim so the next turn can resume without re-reading the same files.`;

export const UPDATE_SUMMARIZATION_PROMPT = `The transcript above contains NEW conversation history to incorporate into the existing summary provided in <previous-summary> tags.

If a <custom-instructions> block is present, treat its contents as additional user-provided instructions for THIS compaction only — they override the structure below where they conflict.

Preserve EVERY non-tool user message verbatim. Quote user instructions, preferences, and requests exactly so the next phase can honor them; do not paraphrase or drop any user message.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing goals unless the user explicitly changed or cancelled them
- PRESERVE all existing constraints, preferences, unresolved tasks, blockers, and critical context
- ADD new progress, decisions, files, commands, errors, and context from the new transcript
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished and what remains
- If something is no longer relevant, you may remove it

Structure your response as: an <analysis>...</analysis> block where you reason about what must be preserved (scratch space, discarded), followed by a <summary>...</summary> block with the updated summary. Inside the <summary> block, use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]
- [Preserve important facts from <exploration-ledger>: searched queries, candidate files, read ranges, modified files, and rejected paths]

Keep each section concise. Preserve the current user goal, unresolved work, constraints, exact file paths, function names, commands, and error messages.

## REQUIRED FACTS (HARD CONSTRAINTS)
Carry forward AND extend the required-fact list. If a previously-listed file, command, or error is still relevant, keep it verbatim. When new entries appear, append them. Quote identifiers and error messages verbatim rather than paraphrasing. If a category becomes empty, write "(none)".`;

export interface SummarizeArgs {
	systemPrompt: string;
	/** Messages to summarize. The caller is responsible for micro-compacting tool results first. */
	messages: Message[];
	previousSummary: string | null;
	ledger: ExplorationLedger;
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
 * hits its output limit, or `reason: "empty"` when no usable summary is
 * returned.
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
	const explorationDetails = renderExplorationDetails(args.ledger);
	const customInstructions = args.instructions?.trim();
	const prompt = args.previousSummary
		? [
				`<conversation>\n${transcript}\n</conversation>`,
				`<previous-summary>\n${args.previousSummary}\n</previous-summary>`,
				explorationDetails
					? `<exploration-ledger>\n${explorationDetails}\n</exploration-ledger>`
					: null,
				customInstructions
					? `<custom-instructions>\n${customInstructions}\n</custom-instructions>`
					: null,
				UPDATE_SUMMARIZATION_PROMPT,
			]
				.filter(Boolean)
				.join("\n\n")
		: [
				`<conversation>\n${transcript}\n</conversation>`,
				explorationDetails
					? `<exploration-ledger>\n${explorationDetails}\n</exploration-ledger>`
					: null,
				customInstructions
					? `<custom-instructions>\n${customInstructions}\n</custom-instructions>`
					: null,
				SUMMARIZATION_PROMPT,
			]
				.filter(Boolean)
				.join("\n\n");

	// Size the summary output against the model's reserve budget, capped at
	// the model's `max_tokens` when the provider exposes one. Falls back to
	// 2048 when neither is known, preserving the pre-token-based behaviour. A
	// 256 floor protects against degenerate micro-budgets when `reserveTokens`
	// is unusually low.
	const providerMaxTokens = provider.maxTokens ?? 2048;
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

	if (!summaryText) {
		throw new CompactionFailedError(
			"Summary model returned no usable summary.",
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
 * a formatting miss. Returns null only when there is genuinely no text.
 */
export function extractSummaryFromResponse(text: string): string | null {
	const match = text.match(/<summary>([\s\S]*?)<\/summary>/i);
	if (match) {
		return match[1].trim();
	}
	const stripped = text
		.replace(/^\s*<analysis>[\s\S]*?<\/analysis>\s*/i, "")
		.trim();
	return stripped || null;
}

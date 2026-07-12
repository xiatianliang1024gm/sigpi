# 0003 — Extract ConversationSummarizer as an independent deep module

- **Status**: Accepted
- **Date**: 2026-07-12
- **Commit**: `e3e4e6c`

## Context and Problem

`src/agent/context.ts` is about 1079 lines and carries all conversation-context responsibilities. The compaction **summary generation** logic was inlined in `ConversationContext`: prompt assembly, the `provider.generate` call, `extractSummaryFromResponse` extraction, and the "truncation / empty response → `CompactionFailedError`" judgment.

This causes two problems:

- **Insufficient depth**: all summary-generation knowledge (prompt structure, the `summaryMaxTokens` budget algorithm, extraction rules) is mixed with the context's "when to trigger compaction", blurring the module interface.
- **Low leverage, hard to test**: a prompt bug could only be reached through the full `compact()` path with a real model; it was impossible to verify in isolation with a fake provider that "the prompt includes transcript / previous summary / exploration ledger", "the budget is computed from `reserveTokens` and `provider.maxTokens`", or "truncation and empty responses raise the corresponding errors".

The compaction **trigger logic** (split index, token threshold, hard-limit trim) belongs to `ConversationContext` and should stay.

## Considered Options

1. **Extract a stateless `summarize(provider, args)` function + new module** `src/agent/summarizer.ts` (adopted). The module owns all the summary-generation behavior above; the context degrades to a thin caller.
2. Let the new summarizer module also absorb `microCompactMessages` (micro-compact first, then summarize).
   - Rejected: `microCompactMessages` is also used by `buildMessages` (in the context itself); moving it into the summarizer would make the summarizer import back from `context.ts`, introducing a **circular dependency**. Instead, "the caller micro-compacts before passing in" is the rule.

## Decision

New module `src/agent/summarizer.ts`:

- The public interface is a stateless function:

  ```ts
  export async function summarize(
    provider: ModelProvider,
    args: SummarizeArgs,
  ): Promise<string>;
  ```

  `SummarizeArgs` contains `systemPrompt` / `messages` (already micro-compacted by the caller) / `previousSummary` / `ledger` / `instructions` / `requestContext` / `reserveTokens` / `runId` / `sessionId` / `abortSignal`. `provider` as the first argument is an explicit **seam** (enables fake-provider injection).

- The module owns: prompt assembly (transcript + previousSummary + exploration ledger + instructions, choosing create / update prompts based on whether `previousSummary` exists), `summaryMaxTokens` sizing (`Math.max(256, min(0.8*reserveTokens, provider.maxTokens ?? 2048))`), the `provider.generate` call, `extractSummaryFromResponse` extraction, and truncation / empty → `CompactionFailedError` (`reason: "truncated"` / `"empty"`).

- The three prompt constants (`SUMMARIZATION_PROMPT` / `UPDATE_SUMMARIZATION_PROMPT` / `SUMMARIZATION_SYSTEM_PROMPT`) and `extractSummaryFromResponse` move in together.

`ConversationContext.compact()` keeps only the trigger logic and becomes a thin caller: first `microCompactMessages(messagesToSummarize)`, then `await summarize(provider, {...})`.

## Consequences

- **Narrower interface, greater depth**: all summary-generation knowledge collapses into one module that can be reasoned about and unit-tested independently.
- **Higher leverage**: added `test/summarizer.test.ts`, using `MockProvider` to directly verify prompt assembly, token budgeting, truncation / empty error paths, and extraction logic — none of which could be tested in isolation past `compact()` before.
- The original `compactNow` integration test still exercises `compact()` effectively; prompt-content assertions moved with the constants into the new module.
- **Behavior change (the only one)**: truncation no longer logs a separate `warn`; it is now covered uniformly by `compact()`'s `context_summarization_failed` log (truncation is still recorded, just without a standalone `truncated`-level log).
- biome + tsc clean; full suite 397→ (with new tests) passed.

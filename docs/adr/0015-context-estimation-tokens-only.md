# 0015 — Context estimation is tokens-only (candidate 3)

- **Status**: Accepted
- **Date**: 2026-07-13
- **Commit**: (pending implementation)

## Context and Problem

The architecture-review deepening pass (candidate 3, "Consolidate token-estimation") claimed the context-window module kept two parallel metrics — a char count and a token count — and that `estimateContextWindowChars`, `estimateRecentMessagesChars`, `estimateToolSchemaChars`, and a `totalChars` field on `estimateRequest` duplicated logic that `estimateContextTokens` already covered.

Investigation against the current tree showed the report's premise was **stale** (like candidate 5):

- `estimateContextWindowChars` / `estimateRecentMessagesChars` / `estimateToolSchemaChars` do **not exist** in the tree.
- `estimateRequest` returns only `{ totalTokens, usedUsage, threshold }` — there is **no `totalChars` field**.
- Compaction logging uses `estimatedTokens`, never `estimatedChars`.
- `context-summary.ts` (`/summary`, `/context`) consumes **only tokens** — no char field.

The one genuine residue was that three summary helpers in `src/context-window.ts` computed `chars` fields that **no caller ever read**:

- `summarizeRecentMessagesByRole` returned `totalChars` and per-role `chars`.
- `estimateSystemPromptSections` returned per-section `chars`.
- `groupToolSchemas` returned per-group `chars`.

`formatContextWindowSummary` (the only caller) used only `.tokens` / `.totalTokens` / `.count` / `.label`. The `chars` values were dead output — the `chars / 4` heuristic lives on inside `estimateMessageChars`, which remains the single internal basis for every token estimate.

## Considered Options

1. **Drop the unused `chars` fields; keep `estimateMessageChars` as the internal `chars/4` basis (adopted)** — tokens become the sole exposed unit of context size. Removes dead computation, no behavioral change, no caller churn.
2. **Keep the `chars` fields "for future display use"** — rejected: they are computed on every `/summary` and never read; carrying dead output violates the single-unit discipline and the report's own consolidation intent.
3. **Delete `estimateMessageChars` and inline `chars/4` everywhere** — rejected: it is the shared heuristic used by `estimateMessageTokens` and `estimateSystemPromptTokens`; collapsing it would duplicate the formula, the opposite of consolidation.

## Decision

- Remove `chars` / `totalChars` from `summarizeRecentMessagesByRole`, `estimateSystemPromptSections`, and `groupToolSchemas` in `src/context-window.ts`.
- Keep `estimateMessageChars` (`src/agent/messages.ts`) as the internal `chars/4` basis for token estimation.
- Context size is now expressed **only in tokens** throughout the module and its single caller.

## Consequences

- **Single unit**: tokens are the only exposed context-size metric; the char heuristic is an internal implementation detail of token estimation.
- **Less dead computation**: three helpers no longer compute and return values nothing reads.
- **Behavior unchanged**: `/summary` output, compaction triggers, and the status bar were already token-driven; the removed fields were unused.
- **Tests**: unaffected — the only `totalChars` in tests belongs to the `read` tool's file-content metadata, which is unrelated to context estimation.

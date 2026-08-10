# ADR 0026 — Compaction refactor: one compaction path, two triggers, two pure interfaces

- **Status**: Accepted (grilled 2025, documented as the first standalone ADR file)
- **Relates to**: `src/agent/compactor.ts`, `src/agent/summarizer.ts`, `src/agent/context.ts`, `src/agent/runner.ts`, `src/model/transport.ts`, `src/session/store.ts`
- **Supersedes**: the in-turn checkpoint (`maybeCompactWorkingMessages`, `TURN_CHECKPOINT_*`), the `Compactor` class + `CompactorDeps` bag, `trimToHardLimit` / `trimOldestMessageGroup`, the `workingMessages` mirror array, turn-boundary persistence

> This is the first **real** ADR file in this repo. Earlier "ADR 00xx" numbers in
> `CONTEXT.md` are historical traceability back-references with no files behind
> them. From here on, significant design decisions get a numbered file under
> `docs/adr/` (see `CONTEXT.md` header note, updated by this ADR).

## Context

SigPi had **three** overlapping context-compression mechanisms, each with its own
summary prompt, split algorithm, and state:

1. **Cross-turn compaction** (`Compactor` in `src/agent/compactor.ts`) — persisted
   `summary` + `recentMessages`, triggered on token threshold in `appendMessages`
   or by `/compact`.
2. **In-turn checkpoint** (`maybeCompactWorkingMessages` in `src/agent/runner.ts`) —
   a *local* summary of the runner's `workingMessages`, injected as a system
   message, **never persisted**, with its own 4-section prompt
   (`TURN_CHECKPOINT_PROMPT`) and its own split rule (keep last N messages).
3. **Empty-response recovery** — a degenerate-response path in the runner that
   re-prompts or compact-then-continues.

Separately, **persistence happened only at turn boundaries**: the runner kept an
un-persisted `turnMessages` array, mirrored the whole conversation in a
`workingMessages` array, and flushed to disk once per turn. Every mechanism that
needed "the full conversation" had to maintain its own copy, and three places
rebuilt `workingMessages` (empty-response recovery, interruption recovery, and
post-compaction continuation).

Finally, the **model layer never recognized `context_length_exceeded`** — a 400
from the provider was classified as a plain `http_error` and killed the turn,
even though the estimate (chars/4 heuristic) is known to drift (summary growth,
tool-schema growth, stale usage baseline after compaction).

## Decision

### D1 — One compaction path, two triggers

The in-turn checkpoint is **deleted** (`maybeCompactWorkingMessages`,
`TURN_CHECKPOINT_PROMPT` / `TURN_CHECKPOINT_INSTRUCTIONS` / `TURN_CHECKPOINT_PREFIX`,
`turnCheckpoint` state, `findTurnCheckpointSplitIndex`, `CONTEXT_COMPACTED_PREFIX`
injection inside the runner). There is exactly one compaction path, with two
triggers:

- **Auto** — a pre-request estimate exceeds the soft limit, or the provider
  returns a `context_length_exceeded` error (D3).
- **Manual** — `/compact` (`force`).

### D2 — Two pure interfaces + a thin orchestrator

The `Compactor` class and its `CompactorDeps` closure bag are **deleted**. Two
pure functions take their place, plus a thin orchestration method on
`ConversationContext`:

**`decide`** — pure computation, no I/O, no state mutation:

```ts
decide(input: {
  messages: Message[];                 // current recent messages
  budget: ContextBudget;               // hardContextLimit / keepRecentTokens / reserveTokens
  keepRecentFloor: number;
  systemPrompt: string;                // explicit params — no closure injection
  toolSchemas: readonly ToolSchema[];
  pendingUserInput?: string;
  force?: boolean;                     // /compact: skip the threshold check
}): { shouldCompact: boolean; splitIndex: number }
```

- The over-limit check runs **inside** `decide` against the whole *request*
  (`systemPrompt + toolSchemas + pendingUserInput + recent messages`), reusing
  `estimateContextTokens` (which prefers the `lastUsage` baseline and only
  accumulates tokens after `lastUsageMessageIndex`; falls back to `chars/4`
  when no usage is available). The soft limit is
  `hardContextLimit - reserveTokens`.
- `splitIndex` uses the existing `findCompactSplitIndex` semantics preserved
  verbatim: from the tail, keep up to `keepRecentTokens` of recent messages,
  aligned so a split never lands inside a tool-result group; `force` always
  summarizes at least `keepRecentFloor` messages; a `token` trigger that does
  not reach `keepRecentTokens` returns `splitIndex = 0` (no compact).

**`execute`** — the actual summarization:

```ts
execute(input: {
  provider: ModelProvider;
  systemPrompt: string;
  messages: Message[];                 // the slice to summarize (messages[0..splitIndex))
  previousSummary: string | null;
  instructions?: string;
  requestContext?: { turnId?: string };
  reserveTokens: number;
  abortSignal?: AbortSignal;
}): Promise<{ summary: string; usage: ModelUsage }>
```

- Internally applies `microCompactMessages` (old tool results reduced to
  `name` + `toolCallId`, content emptied) before calling `summarize`.
- Returns the new summary **and** the provider-reported `usage` of the
  summarize call (the current code drops `response.usage`; this recovers it).
- On any model failure it **throws** — it never trims, never degrades (see D4).

**`ConversationContext.compact()`** — the thin orchestrator ("apply"):

1. Calls `decide` (or receives `force` from `/compact`).
2. If `shouldCompact` and `splitIndex > 0`, calls `execute`, then applies the
   result: `setSummary`, slice `recentMessages` to `messages.slice(splitIndex)`,
   `invalidateLastUsage()`, record a `CompactionEntry` (now carrying `usage`, D7).
3. **Post-compaction check (D6)**: re-estimates; if still over the soft limit,
   throws `CompactionFailedError` with `reason: "insufficient_compaction"` —
   the user fixes the configuration; nothing is silently dropped.
4. Returns the updated `ContextUpdateResult` (field `trimmed` **removed**).

The runner only *triggers*: it calls `context.compact()` when the estimate
exceeds the limit, on `/compact`, and on a `context_length_exceeded` retry. It
never touches decide/execute/apply internals.

### D3 — Provider `context_length_exceeded` → compact → retry once

The transport gains a `RequestFailureKind` value `"context_length_exceeded"`:
`mapSdkError` recognizes the provider's context-length error code (400 with
`error.code` like `context_length_exceeded` in both chat-completions and
responses formats) instead of classifying it as a plain `http_error`.

The runner catches it, calls `context.compact({ force: true })`, retries the
original request **once**; a second failure re-throws the original error
unwrapped. This is the "LLM interface tells the agent it's over budget" trigger.

**Scope narrowing (D6 companion)**: this 400 path is only the self-heal for
*estimate misses* (a request sent without a prior compact). A post-compaction
overflow is caught eagerly by D6 and reported as `insufficient_compaction`,
never left to the 400 path.

### D4 — No silent trimming, ever

`trimToHardLimit` and `trimOldestMessageGroup` are **deleted** along with the
`trimmed` field and the trim-on-summarize-failure fallback. If summarization
fails, the compaction **throws** (`CompactionFailedError`) and the user retries.
If compaction succeeds but the window still overflows (D6), the compaction
**throws**. There is no code path that drops old messages without the user
knowing.

### D5 — Persist every message; delete the working buffer

Persistence moves from turn-boundary to **message-level**: every new message is
appended to the `ConversationContext` state and committed to the session store
immediately (the store already appends deltas — `writeSession` persists only
`entries.slice(prevCount)` — so the incremental cost is one meta write per
message). Two exceptions, without which message-level persistence breaks
existing behavior:

1. **Empty assistant responses are never persisted** — the runner discards a
   degenerate (no text, no tool calls) response before it lands in the context,
   and retries; the transcript never accumulates empty entries.
2. **Dangling tool calls are closed at persist time** — when a tool-call message
   is persisted after an interrupt (no tool result followed), the synthetic
   `INTERRUPTED_TOOL_RESULT_ERROR` result is persisted with it, so a resumed
   session never rehydrates an unclosed `tool_use` (provider 400).

Consequences:

- `turnMessages`, `turnMessagesPersisted`, `lastCheckpointedTurnMessageCount`
  are deleted.
- The `workingMessages` mirror array is **deleted**. Before every `generate`,
  the runner rebuilds the request payload from `context.buildMessages(...)`.
  The three rebuild sites (empty-response recovery, interruption recovery,
  post-compaction continuation) collapse into one: "rebuild from context and
  continue".
- `estimateWorkingMessageTokens` and its `role !== "system"` filtering are
  deleted; token estimation always runs against the single source of truth
  (the context state).

### D6 — `decide` runs once per request, not per append

`appendMessages` no longer estimates or triggers compaction. `decide` runs
**once, immediately before each `generate`**, against the full request shape
(the most accurate moment: complete `systemPrompt`, `toolSchemas`, and
`pendingUserInput` are all visible). Trigger frequency drops from per-message
to per-request. Estimate drift is caught by D3 (400 → compact → retry), and a
post-compaction overflow is caught eagerly by the D6 check in `compact()`.

### D7 — Compaction usage is audit data, not a baseline

The `usage` returned by `execute` is recorded on the `CompactionEntry`
(`summarizedCount`, `trigger`, `tokensBefore`, `tokensAfter`, **`usage`**). It
is surfaced in logs / `context_compacted` telemetry. It is **never** fed into
the `lastUsage` baseline: `invalidateLastUsage()` still clears the baseline
after compaction (the old `totalTokens` covered messages that no longer exist),
and scrubs `usage` off kept entries so `hydrateState` cannot restore a stale
count on resume. The summarize request's token count does not describe the next
main request's window; treating it as a baseline would systematically
under-estimate and re-trigger 400s forever.

### D8 — Convention change: ADR files now exist

`CONTEXT.md` previously stated "SigPi keeps no separate ADR documents". That
clause is retired: significant design decisions are written to numbered files
under `docs/adr/` (starting with this one), and `CONTEXT.md` entries carry the
ADR number as a link. `AGENTS.md`'s "Single-context layout" note is updated to
point at `docs/adr/` for decision records.

## Consequences

**Positive**

- One summary prompt, one split algorithm, one persistence path, one source of
  truth for conversation state (the context) — no more dual-copy drift bugs
  (e.g. the old comment about a 5.2K vs 2.3K estimate mismatch between
  `workingMessages` and the context).
- `decide` and `execute` are pure and independently unit-testable (pass a mock
  provider to `execute`; `decide` needs no context instance).
- Trigger surface is minimal: one pre-request estimate + one 400 handler + the
  `/compact` command.
- The agent self-heals from estimate drift (400 → compact → retry once).
- Compaction is auditable (usage on the entry) without corrupting the estimate
  baseline.

**Costs / risks**

- One extra meta write per message on the session store (bounded: transcript
  appends are already delta-based).
- A genuinely over-budget request may fail once (400) before self-healing,
  instead of being prevented pre-flight.
- A post-compaction overflow now surfaces as a hard `insufficient_compaction`
  error the user must fix — by design, not silent.
- Removing `trimToHardLimit` removes the last-resort safety net; correctness
  now depends on the estimate + 400 retry loop + D6 check, so the
  `reserveTokens` budget and `keepRecentTokens` configuration carry more weight.

**Implementation checklist** (referenced by the implementer)

1. `src/model/transport.ts` — add `"context_length_exceeded"` to
   `RequestFailureKind`; recognize it in `mapSdkError` (both adapters' error
   shapes).
2. `src/agent/compactor.ts` — delete `Compactor`, `CompactorDeps`,
   `trimToHardLimit`, `trimOldestMessageGroup`; keep `microCompactMessages` and
   the split/align helpers; export `decide` and `execute` (file may be renamed
   to `compaction.ts`).
3. `src/agent/summarizer.ts` — return `usage` alongside the summary.
4. `src/agent/context.ts` — `compact()` orchestrates decide→execute→apply;
   remove threshold checking from `appendMessages`; keep `invalidateLastUsage`;
   remove `trimmed` from results; add the D6 post-compaction check.
5. `src/agent/runner.ts` — delete checkpoint machinery and `workingMessages`;
   rebuild request from `context.buildMessages` before each `generate`; drop
   empty assistant responses before they persist; close dangling tool calls at
   persist time; handle `context_length_exceeded` → `compact({force:true})` →
   retry once.
6. `src/session/store.ts` — commit per message (delta append already in place).
7. `src/types.ts` — `ContextUpdateResult` drops `trimmed`; `CompactionEntry`
   gains `usage`; `RequestFailureKind` gains `context_length_exceeded`.
8. Tests: `decide` (force vs token splits, floor, tool-group alignment),
   `execute` (mock provider returns usage; failure throws), 400 retry loop,
   empty-response non-persistence, interrupt tool-call closure, post-compaction
   overflow error.

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
  `name` + `toolCallId` plus a short self-describing elision notice — see the
  amendment at the end of this file) before calling `summarize`.
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

## Amendment — micro-compaction must never blank a tool result

**Status**: applied. Scope: `microCompactMessages` (`src/agent/compaction.ts`).
The `decide` / `execute` / apply split above is unchanged.

The original mechanism line said elided tool results had their "content
emptied". On the wire that is a tool message with `content: ""`, which the
model cannot distinguish from a tool that legitimately returned nothing. The
observed failure (reproduced from a real session, `read` of three files in one
step): the model concluded the reads had failed, re-issued the identical calls,
which pushed fresh output into the window, which evicted the results it had
just fetched — a self-sustaining re-read loop that burned the step budget
(`index.html` read 4×, `tree.js` / `transcript.js` / `markdown.js` / `dom.js`
read 3× each) while every persisted transcript looked complete, because the
elision happens only in the request shape, never in the entry stream.

Two rules now hold, both enforced by `microCompactMessages`:

1. **Elision is loud.** An elided result is replaced by
   `formatOmittedToolResult(name, originalChars)` — a short notice naming the
   tool, the dropped size, stating that the call succeeded and the output was
   not empty, and stating that a re-run returns the same text but that the text
   is dropped again once newer results arrive. `name` + `toolCallId` are still
   preserved. A genuinely empty result is left alone (nothing was reclaimed, and
   a notice would be false). The notice deliberately does not forbid re-running:
   a re-run is legitimate and does work, because of rule 2.
2. **The newest batch is pinned.** Every tool result belonging to the most
   recent assistant tool-call message is kept in full regardless of the token
   budget. `MICRO_COMPACT_KEEP_TOOL_TOKENS` alone cannot guarantee this: one
   step that reads several files can exceed it by itself, so without pinning the
   earlier reads of a batch were elided before the model could act on them.
   Pinning cannot mask a hard-limit overflow, because the compaction trigger
   (`decide`) is computed from the uncompacted `recentMessages`.

### Threshold: 8_000 → 32_000

`MICRO_COMPACT_KEEP_TOOL_TOKENS` was raised from 8_000 (~32 KB) to 32_000
(~128 KB). 8_000 was smaller than a single `read` result (the read tool caps at
50 KB), so ordinary multi-file exploration lost tool output roughly one step
after fetching it — the condition that produced the re-read loop above.

The value is now anchored to the general practice of other agents, not to this
project's history. Every comparable implementation keeps a working set of
recent tool output in the **10k–50k token** band:

| Implementation | Kept / reclaimed |
| --- | --- |
| Anthropic `clear_tool_uses_20250919` (server-side context editing) | triggers at 100k input tokens; `keep: 3` tool use/result pairs |
| Claude Code MicroCompact | reclaims ~10k–50k tokens per activation |
| Claude Code session-memory compact | keeps 10k (`minTokens`) – 40k (`maxTokens`) |
| Claude Code post-compact file restore | 50k token budget for recently read files |

32_000 is mid-band and ≈16% of the default 200k window, leaving ~150k for the
system prompt, tool schemas, conversation and summary — micro-compaction shapes
the request but must not be what governs the window; full compaction does.
`MICRO_COMPACT_FLOOR_TOOL_RESULTS = 3` is unchanged: it mirrors Anthropic's
`keep: 3` default (conservatively — that counts tool use/result pairs, this
floors on tool results).

A follow-up worth considering (not done here) is scaling the budget with
`hardContextLimit` instead of holding it constant, the way Claude Code scales
its auto-compact threshold to the model's window.

Because `microCompactMessages` is a pure, non-mutating view, the notice is
recomputed from the live `recentMessages` on every request and never
double-applied; the append-only entry stream still holds the full output.

## Amendment — micro-compaction: turn freeze, a scaled budget, a turn-head trigger, and visible elision

**Status**: applied. **Amends**: D1/D6 (when the auto trigger runs), the
"Threshold: 8_000 → 32_000" section above (the budget is now window-relative),
and the rule list of "micro-compaction must never blank a tool result".
**Scope**: `src/agent/compaction.ts` (`planMicroCompaction` — the whole
policy), `src/agent/context.ts` (`buildMessages`), `src/agent/runner.ts`
(turn-head trigger, `context_elided` reporting), `src/session/events.ts` +
`src/server/web/reducer.js` + `src/tui/status-bar.ts` (presentation).
The `decide` / `execute` / apply split, and every other decision in this ADR,
are unchanged.

### A1 — Why anything changed here

A real session
(`~/.sigpi/projects/sigpi-…/sessions/d1fe8c21-18b2-487c-b52f-dd5838c4ae9e.jsonl`,
134 entries, **zero** `compaction` entries) showed the agent re-reading files it
had already read: 24 of 57 `read` calls repeated an identical
`(path, offset, limit)`, and in **24 of 24** cases the earlier copy had been
elided from the request the model was answering. The model's own reasoning says
so — `#58` "since they were *elided earlier*", `#66` "multi.ts was 28k chars,
*got elided*", `#116` "These *got elided earlier*; I need their content".

Two measured costs, both offline (no token spend; replay tool:
`scripts/micro-compact-replay.mjs`):

1. **Elision is expensive when it moves every step.** Using the provider's own
   `usage.cacheRead / usage.input` per request in that session: requests whose
   elision set changed averaged **18%** cache hit (n=18); requests that only grew
   the tail averaged **88%** (n=11). Adjacent requests alternate
   (`#82 97% → #85 20% → #87 21% → #89 97%`, within the same second), so this is
   not a TTL effect. Mechanism: DeepSeek's cache matches a *persisted prefix
   unit*, and a rewrite in the middle of the prefix retires the unit.
2. **The flat budget was too small for the work.** One implementation turn read
   ~100k tokens of files; a flat 32k evicted two thirds of what the model had
   just fetched, and it answered by fetching it again.

### A2 — Three rules, not five

`planMicroCompaction` now keeps, in priority order:

1. **The newest batch is pinned** — every result of the most recent assistant
   tool-call message, whatever the budget says. One step that reads several
   files can exceed the entire budget by itself.
2. **The running turn is frozen** — the results of the turn still in flight are
   kept ahead of anything older, and that class is pruned only from its oldest
   end, last. What this buys is *priority*, not capacity: no earlier turn's
   content can take room the running turn needs. A turn that reads more than the
   whole budget still loses its own oldest results, because the alternative is a
   request that cannot be sent.
3. **The rest is a recency window** — the oldest results are dropped until the
   budget is met, with a floor of `MICRO_COMPACT_FLOOR_TOOL_RESULTS = 3`.

Elision stays **monotone**: a result that has been elided is never restored as
the conversation grows, so the request prefix only ever changes forward (the
prefix is the cache key). Elision is a **view**: `microCompactMessages` returns
a new array, the entry stream and the session record keep every result in full.

### A3 — The budget scales with the window (the follow-up above, now done)

`microCompactToolTokenBudget(hardContextLimit)` — evaluated on **every request**
by `ConversationContext.buildMessages`, never cached, so `/model switch`
retargets it immediately the way `getContextBudget` does for the full-compaction
threshold:

```
max(8_000, round(hardContextLimit * 0.3))    // MICRO_COMPACT_KEEP_TOOL_FRACTION = 0.3
```

- **200k window → 60k** (the old value was a flat 32k).
- **No window to scale against** (unit tests, legacy callers) → the historical
  `MICRO_COMPACT_KEEP_TOOL_TOKENS = 32_000`.
- **`MICRO_COMPACT_KEEP_TOOL_MIN_TOKENS = 8_000`** is a floor, not a target: a
  32k or 64k window must not be budgeted a flat 32k of tool output, but nor
  should the budget collapse to nothing — a couple of file reads have to fit for
  the agent to work at all.

**Why 30%.** The flat 32k was ≈16% of the default 200k window, and the reported
session is what that looks like in practice: one implementation turn read ~100k
tokens of files, so a 32k budget evicted two thirds of what the model had just
fetched and it re-fetched the files (`transcript.js` 4×, `manager.ts` 5×). 30%
leaves the system prompt, tool schemas, conversation text and summary the other
~70%, and still lands inside the 10k–50k band the survey table above describes
for comparable agents (60k of a 200k window, the same order as Claude Code's
`maxTokens: 40_000` session-memory tier). The fraction is a *share of the
window*, so a bigger model gets a proportionally bigger working set instead of
the same flat number.

**Not settled by the value itself**: the floor interacts with
`MICRO_COMPACT_FLOOR_TOOL_RESULTS` when the in-flight turn alone exceeds the
budget — the walk then runs down to the 3-result floor, and the surviving
results are the newest ones. Whether the floor should scale with the budget is
an open tuning question, not a decided one.

### A4 — Deferred: working-set pinning and superseded-copy elision (待考虑，暂不实现)

A prototype added two further rules, and both were **implemented, measured, and
then removed** — deliberately, not for lack of time. Do not re-add them without
re-reading this section:

- **Working-set pinning** — keep the newest result for each
  `(tool, target, range)` across turns (a `read` keyed on path *plus*
  offset/limit, since line-range pages are complementary), with a per-target
  cap of 8_000 tokens so one heavily paged file cannot crowd out the others.
- **Superseded-copy elision** — a result whose newer copy of the same target
  ships in the same request carries no information of its own, so drop it even
  when the budget has room, under its own marker `[context-superseded]` and a
  notice that could honestly promise "nothing was lost, do not re-run the call"
  (the generic notice cannot promise that).

Why they were removed: both make the planner model **file identity** — which
read of which range is "the current one", how many tokens of it stay pinned —
in order to decide what the model still needs. That is a judgment about the
task, and the model is better placed to make it than a token accountant. The
planner's job is narrower: decide what to drop when the request does not fit.
It should stay simple enough to predict from the message list alone.

What the removal costs, measured on the same session (see A7): the last
request's in-turn loss rises from 19,120 (prototype) to 41,737 (shipped) tokens,
cumulative in-turn loss from 188,369 to 398,600, cumulative cross-turn loss from
204,862 to 705,348, and repeat reads from 14 to 16 — i.e. **the prototype's
extra rules were doing real work**, and the shipped policy is knowingly weaker
on context retention. What it buys back is a simpler, predictable policy whose
only inputs are the message list and the budget, and better request-prefix
stability than the prototype had (46,462 vs 37,323 stable tokens per request —
dropping superseded copies rewrites the prefix in the middle; simply keeping
them does not).

Revisit if a session shows the model re-reading what an earlier turn had
already fetched *and* the extra bookkeeping can be confined to a pure function
with no new per-target configuration. The offline replay tool is the gate: it
reproduces the table below without a single model call.

Two things to keep straight if this is revisited: the per-target cap of 8_000
was never tuned against a real multi-page file, and the "free" superseded
elision was not free at all (see the prefix-stability numbers above) — the
`retainSupersededCopies` escape hatch existed only to measure that trade-off
and went away with the rule.

### A5 — The auto trigger is a turn-head decision

`maybeAutoCompactBeforeRequest` (`src/agent/runner.ts`) returns immediately for
`step > 1`. The token trigger therefore fires **once per turn, before the turn's
first request**; inside a turn the only path to a full compaction is the
provider's `context_length_exceeded` → `compact({force: true})` → retry once
(D3), plus the explicit `/compact`.

Reason: mid-turn, the window is whatever *this turn* has accumulated, and a full
compaction replaces that material with a summary of it — a strictly larger
information loss than the micro-compaction view, which never touches the entry
stream and only drops what does not fit. The estimate-based trigger remains a
*pre-flight* check for the shape that is about to be sent; it is not a
mid-flight repair mechanism.

Consequence to watch: a long turn now relies on micro-compaction and on the 400
path to stay inside the window. The 400 path is bounded (`GENERATE_MAX_RETRIES
= 1`), and a post-compaction overflow surfaces as `insufficient_compaction`
rather than looping, so the failure mode is an error the user sees — not a
silent retry storm.

### A6 — Elision is visible

Elision happens in the request shape only, so the transcript looked complete
while the model was being served placeholders — which is why the re-read loop
above went unnoticed for a whole session. Two surfaces now report it:

- **Log**: `micro_compact_applied` (context manager), emitted only when the
  decision *changes*; the signature is the set of elided positions, because two
  decisions that each drop one result are different decisions when they drop
  different results. The decision is recomputed on every request (it is a pure
  view), so a count-based signature would have collapsed them.
- **Progress event**: `context_elided` `{step, elidedToolResults, elidedTokens,
  keptToolResults, budget}`, emitted by the runner once per distinct decision
  within a turn. The TUI/CLI transcript and the web transcript both render it as
  a system line via `formatElisionMessage` (`src/session/events.ts` and its web
  port `src/server/web/reducer.js`, which must stay in sync); the TUI status bar
  labels it `elided`. The wording states that the request dropped the output and
  that the session record still holds it — a line that only said "elided 7
  results" would read like data loss to a user looking at a complete transcript.

### A7 — Measurement (offline replay, zero tokens)

`node scripts/micro-compact-replay.mjs [session.jsonl …]` replays a stored
session through the frozen pre-refactor algorithm and through the current
planner, over the same history. On the motivating session (50 requests; 117,152
tool-result tokens in the history, **39.3%** of them older copies of a range
already present):

| metric | before (legacy) | after (32k flat) | **after (60k scaled, shipped)** |
| --- | --- | --- | --- |
| last request: real in-turn loss | 57,504 | 70,311 | **41,737** |
| last request: real cross-turn loss | 35,538 | 35,538 | 35,538 |
| last request: results elided | 57 | 58 | 48 |
| cumulative in-turn loss | 818,488 | 971,204 | **398,600** |
| cumulative cross-turn loss | 923,049 | 938,275 | **705,348** |
| repeat reads | 24 | 24 | **16** |
| stable prefix tokens (same-turn mean) | 51,811 | 53,058 | 46,462 |
| prefix-changed requests / comparisons | 19 / 48 | 19 / 48 | **15 / 48** |

How to read it:

1. **The scaled budget is what fixes the reported problem** (in-turn loss at the
   last request −27%, repeat reads 24 → 16, cumulative in-turn loss −51%),
   together with turn freeze. At the same 32k the new planner is *worse* on
   in-turn loss than the old one (70,311 vs 57,504): freezing the running turn
   means the budget now has to bite inside it once the earlier turns are
   exhausted, and when the in-flight turn alone exceeds the budget the walk runs
   down to the 3-result floor (A3). That is the price of the priority guarantee,
   and it is why the budget had to grow rather than the rules multiply.
2. **"Stable prefix" is a proxy, not a cache measurement.** No real-API cache
   benefit has been verified for this refactor (`cacheRead` was only used to
   diagnose the old behavior, A1). The proxy got *worse* (51,811 → 46,462),
   which is expected: a larger budget plus a moving boundary means more prefix
   rewrites, not fewer. The open question is whether that is cheaper than
   re-reading files; it depends on the provider's cache price versus its miss
   price, and it has not been measured.
3. **The remaining gap is cross-turn**: the last request still drops 35,538
   tokens of earlier turns, because one turn can out-produce the whole budget.
   Closing it is the deferred work in A4 or a source-side limit on per-turn
   reads — not more eviction cleverness in the planner.

### Rejected: pruning to a low-water mark

Pruning to ~85% of the budget (instead of stopping as soon as the budget is
met) was tried to make the boundary move "in batches" and keep the cache
prefix stable. It cannot work: the trigger is evaluated against the full
candidate mass, which includes everything already elided, so once the history
exceeds the budget the trigger stays true on every later request and the
boundary advances by one result per request regardless of the target. A
low-water mark would only drop ~15% more context. The comment in
`planMicroCompaction` records this at the point where the walk stops.

### Rejected: materializing elision into the entry stream

Writing the placeholder into the entries (instead of rendering it as a view)
would break the append-only stream, the audit trail, and the
`firstKeptEntryId` invariant that full compaction depends on. Micro-compaction
stays a pure view.



# 0022 — Status bar revision: `?` before first response, git branch, drop `model`/`tokens` prefixes

- **Status**: Accepted
- **Date**: 2026-07-16
- **Branch**: `feat/status-bar`
- **Area**: status bar composition (`src/chat-repl.ts`, `src/cli.ts`), new `src/git.ts`, glossary (`CONTEXT.md`)

## Context and Problem

The status bar (`src/chat-repl.ts:169-182`) currently renders:

```
model {modelName} | tokens {used}/{limit} ({pct}%) | {cwd}
```

This revision keeps the same segments but drops the `model ` and `tokens ` labels (the leading position already identifies each), and replaces the pre-response token estimate with `?`:

```
{modelName} | ?/{limit} | {cwd} ({branch})
```

Three concrete defects:

1. **Token number is wrong before the first model response.** `formatStatusBar` calls `estimateContextTokens` (`src/chat-repl.ts:132-145`), which falls back to a `chars/4` heuristic when `lastUsage` is `null` (`src/context-window.ts:80-150`). The heuristic is known to be inaccurate — especially for CJK content and code — so the user sees a confidently-wrong number on a fresh session.
2. **The `model ` prefix is noise.** The model name stays as the first segment (it is *not* shown in the prompt area, so the status bar is where the user sees it), but the literal `model ` label adds no information — the leading position already identifies it as the model. The status bar is a footer for *session state*, not a model picker, so a bare name is enough.
3. **No git branch.** When the user is inside a repo, the branch is the most useful piece of cwd context — far more so than the absolute path alone.

Additionally, after `ConversationContext.recover()` clears `lastUsage` (`src/agent/context.ts:233, 344`), the status bar silently falls back to the heuristic again, re-introducing defect (1) mid-session.

## Options Considered

**Q1 — Token display before the first response?**

- A: keep the `chars/4` heuristic. Rejected — the whole point of this revision is that the heuristic is wrong.
- B: show `tokens ?/{limit}` (no percentage). Chosen — honest about the unknown; the limit is still useful (it tells the user the model's capacity).
- C: hide the segment entirely. Rejected — the limit is the one piece of information the user *does* know, and hiding it makes the bar feel broken.

**Q2 — Token display after the first response?**

- A: `lastUsage.totalTokens` exactly, no trailing-delta estimate. Chosen — the provider's number is ground truth; the user does not need to see the heuristic at all.
- B: `lastUsage.totalTokens + (trailing chars)/4`. Rejected — re-introduces the heuristic the user just complained about, even if only for the delta. The display stays at the last response's number until the next response lands; staleness is honest, a wrong estimate is not.
- C: mark the trailing portion (e.g. `12.3K+200`). Rejected — visual noise for a number the user can't act on.

**Q3 — Token display after `recover()`?**

- A: keep showing the last known number. Rejected — the recovered tail is a different conversation; the old number is misleading.
- B: drop back to `?`. Chosen — same rule as "before first response": no `lastUsage`, no number.

**Q4 — Git detection mechanism?**

- A: walk up from `cwd` looking for `.git`. Rejected — doesn't give the branch; still needs a subprocess.
- B: spawn `git rev-parse --abbrev-ref HEAD` (+ `--show-toplevel` to confirm work-tree). Chosen — one call, handles worktrees/submodules, gives the branch directly.
- C: shell out to a higher-level git library. Rejected — dependency for one read.

**Q5 — Detached HEAD?**

- A: show `HEAD` literally. Rejected — useless to the user.
- B: show the short SHA, e.g. `@a1b2c3d`. Chosen — actionable (the user can `git checkout` it).
- C: hide the segment. Rejected — the SHA is the most useful thing to show in detached state.

**Q6 — Git module shape?**

- A: inline in `chat-repl.ts`. Rejected — `chat-repl.ts` is already a 255-line orchestrator; subprocess + caching logic doesn't belong there.
- B: new `src/git.ts` (flat). Chosen — single file, room to grow (`getGitStatus`, `getGitRoot`, etc. later), one-line interface.
- C: `src/git/branch.ts` (nested). Rejected — premature structure for one function.

**Q7 — Git lookup: sync or async?**

- A: sync, cached. Rejected — first call blocks the prompt on a subprocess.
- B: async, cached. Chosen — `formatStatusBar` becomes async; the two call sites in `cli.ts` (`readInput`, `startRunningTurnInputListener`) already `await` setup, so the ripple is small.

**Q8 — Cache strategy?**

- A: module-level `Map<string, string>`, no TTL. Chosen — branch only changes on `git checkout` (rare); staleness self-heals on `/cd` or session restart.
- B: TTL (e.g. 5s). Rejected — adds a knob for no real benefit; the user can `/cd .` to force a refresh.
- C: no cache. Rejected — spawns git on every keystroke.

**Q9 — Timeout / failure handling?**

- 50ms subprocess timeout. On timeout, non-zero exit, or any error: return `null`, omit the branch segment silently. Never block the prompt on git.

**Q10 — Persist `lastUsage` across session resume?**

Currently `ConversationContext.hydrateState` (`src/agent/context.ts:323-345`) explicitly sets `lastUsage = null` with the comment *"Hydrated sessions have no provider usage info available; fall back to the chars/4 heuristic"*. `PersistedSession` carries no `usage` field anywhere; `SessionSummary.estimatedTokens` is a `chars/4` estimate. So on every resume, the provider's `totalTokens` is thrown away and the bar shows `?` (or the heuristic) until the user types something and gets a response.

- A: attach `usage?: ModelUsage` to the assistant `MessageEntry`. On hydrate, scan `recentMessages` for the last assistant message with `usage !== undefined`; set `lastUsage = { usage, messageIndex: that index }`. Chosen — the usage is a property of that specific response, and `messageIndex` becomes derivable rather than a fragile top-level pointer.
- B: top-level `lastUsage: { usage; messageIndex } | null` on `PersistedSession`. Rejected — `messageIndex` is fragile (depends on the order of `recentMessages` after hydration, which can shift if a compaction entry is added).
- C: on `SessionTurnHistoryEntry`. Rejected — that type is for audit/`/history`; mixing display state into it feels wrong.

**Q11 — Persist `usage` from failed/interrupted turns?**

The provider reports `usage` in the final chunk of a streaming response. Three failure modes: network error mid-stream (usage may or may not have arrived), `finish_reason: "length"` (usage complete, response truncated), user interrupt (usage complete, response abandoned).

- A: persist `usage` whenever the provider reported it, regardless of turn outcome. Chosen — the number is the provider's ground truth for what was sent/received; it's not invalidated by the turn failing afterward. For `length` truncations and interrupts, the usage is *more* useful than for successful turns (it tells the user "you hit the limit").
- B: only persist from successful completions. Rejected — throws away the most useful cases (truncation, interrupt).

**Q12 — Migration of old sessions?**

- Old sessions (no `usage` field on assistant messages) → on hydrate, scan finds no assistant message with `usage` → `lastUsage = null` → bar shows `?` until first response. This is the current behavior, so no regression. No schema migration needed; the new field is optional.

**Q13 — Cache hit rate formula?**

`ModelUsage` already carries `cacheRead` and `input` (`src/types.ts:324-330`). Three formulas:

- A: `cacheRead / (cacheRead + input)`. Chosen — Anthropic/OpenAI standard; `cacheWrite` is a one-time cost, not a miss.
- B: `cacheRead / totalTokens`. Rejected — includes output in the denominator, dilutes the rate.
- C: `cacheRead / (cacheRead + input + cacheWrite)`. Rejected — less common, penalizes first-time caching.

**Q14 — Edge case: no cacheable input?**

When `cacheRead + input === 0` (trivial request, or provider doesn't report cache fields), the formula is undefined.

- Hide the segment entirely. Chosen — `Hit(0.0%)` would be misleading (implies "cache missed on real input" when there was no input); `Hit(--)` is visual noise for a non-event.
- When `cacheRead === 0 && input > 0` (legitimate 0% hit rate, cache was cold): show `Hit(0.0%)`.

**Q15 — Placement?**

- A: inline with tokens — `12.3K/183.6K (7%) Hit(85.3%) | ~/repo (main)`. Chosen — the cache rate is a property of the same response that produced the token count, so they belong together.
- B: separate segment — `12.3K/183.6K (7%) | Hit(85.3%) | ~/repo (main)`. Rejected — visually distinct but the `|` separator would imply they're independent metrics when they're not.
- C: after cwd — `12.3K/183.6K (7%) | ~/repo (main) | Hit(85.3%)`. Rejected — splits context info from its efficiency metric.

**Q16 — Cache segment lifecycle?**

Same rules as the token segment: hide when `lastUsage` is `null` (before first response, after `recover()`, or on resume of an old session without `usage`); show otherwise, subject to the `cacheRead + input === 0` hide rule.

**Q17 — Token display during a running turn (event-driven redraw)?**

The bar has two redraw paths: the prompt redraw (`formatStatusBar`, used when idle / between responses) and the event-driven redraw (`formatStatusBarForEvent`, used while a turn is in flight with `TurnProgressEvent`s). During a turn, the runner emits `estimatedContextTokens` on progress events — a `chars/4` estimate of the in-flight request (`src/agent/runner.ts:305`, `estimateWorkingMessageTokens`). Q2 rejected trailing-delta estimates for the *prompt redraw*; that decision targets the idle display. The open question is whether the *event redraw* should render the live estimate or fall back to `formatStatusBar` (which would show `?` until the response lands).

- A: event redraw shows the live `estimatedContextTokens` during the turn, then snaps to `lastUsage.totalTokens` after the response. Chosen — gives the user a live, rising token count as the request is built; the snap to ground truth on completion is expected progress feedback, not the "confident wrong number" Q2 set out to remove (Q2's concern was the *idle* redraw showing a wrong number the user might trust). The live number is explicitly framed as in-flight progress, not a persisted/authoritative count.
- B: event redraw ignores `estimatedContextTokens` and calls `formatStatusBar` (shows `?` during the turn). Rejected — loses useful live feedback; the bar would look frozen at `?` for the whole turn, which reads as broken rather than "working".
- C: event redraw shows the last response's `lastUsage.totalTokens` (frozen at the previous number). Rejected — on a fresh session there is no previous number, forcing `?`; and on later turns it would hide genuine in-turn growth.

## Decision

1. **Token segment** in `formatStatusBar`:
   - If `state.runtime.context.getLastUsage()` is `null`: render `?/{limit}` (no percentage).
   - Otherwise: render `{lastUsage.totalTokens}/{limit} ({pct}%)`.
   - **No** trailing-delta estimate. The display stays at the last response's number until the next response lands.
2. **Cache hit rate segment** — appended inline to the token segment (no `|` separator):
   - If `lastUsage` is `null`: omit.
   - If `cacheRead + input === 0`: omit (no cacheable input, or provider doesn't report cache fields).
   - Otherwise: render `Hit({pct}%)` where `pct = cacheRead / (cacheRead + input) * 100`, one decimal place.
   - Examples: `12.3K/183.6K (7%) Hit(85.3%) | ~/repo (main)`, `12.3K/183.6K (7%) Hit(0.0%) | ~/repo (main)`, `12.3K/183.6K (7%) | ~/repo (main)` (no cache segment).
2. **Drop the `model ` prefix, keep the model name.** The first segment is now the bare `{modelName}` (no `model ` label). The name is retained because the prompt area does not show it, so the status bar is the user's only at-a-glance view of the active model.
3. **Git branch segment**: append `(branch)` to the cwd segment.
   - Normal: `~/repo (main)`.
   - Detached: `~/repo (@a1b2c3d)` (short SHA, prefixed with `@`).
   - Not-a-repo / timeout / error: `~/repo` (segment omitted, no parens).
4. **New module `src/git.ts`** exporting `getGitBranch(cwd: string): Promise<string | null>`.
   - Spawns `git rev-parse --abbrev-ref HEAD` with a 50ms timeout.
   - On `HEAD` (detached), falls back to `git rev-parse --short HEAD` and prefixes with `@`.
   - Module-level `Map<string, string>` cache, keyed by `cwd`, no TTL.
   - Returns `null` on any failure; never throws.
5. **`formatStatusBar` becomes async**; `formatStatusBarForEvent` follows. The two call sites in `src/cli.ts` (`readInput` at line 382, `startRunningTurnInputListener` at line 434) `await` the result.
6. **Glossary**: add a dedicated `## Status bar` section to `CONTEXT.md` documenting the composition, the `?` rule, the git branch format, and the resume behavior.
7. **Persist `lastUsage` across resume** — add optional `usage?: ModelUsage` to `MessageEntry` (assistant messages only). `recordAssistantMessage` writes it; `markTurnCompleted` / `markTurnFailed` / `markTurnInterrupted` persist it via the existing `resolveEntriesForPersist` path. `hydrateState` scans `recentMessages` for the last assistant message with `usage !== undefined` and sets `lastUsage = { usage, messageIndex: that index }`. If none found, `lastUsage = null` → bar shows `?` (no regression for old sessions).
8. **`formatStatusBarForEvent` keeps the live in-turn estimate.** While a turn is in flight, progress events carry `estimatedContextTokens` (a `chars/4` estimate of the request being built); the event redraw renders that number rather than `formatStatusBar`'s `?`. Once the response is recorded (`lastUsage` set), the bar snaps to `lastUsage.totalTokens` (ground truth, with the `Hit(...)` segment). This is a deliberate, accepted exception to the "no estimate" rule of decision 1: that rule governs the *idle / prompt redraw* (`formatStatusBar`), where a confident wrong number is harmful; the event redraw is explicitly in-flight progress feedback, and the snap to ground truth on completion is expected.

## Consequences

- **Honest numbers**: the status bar never displays a heuristic-derived token count. Before the first response (and after `recover()`), it shows `?`; after, it shows the provider's number exactly.
- **Stale-but-honest**: between responses, the token number does not update as the user types. This is a deliberate trade — staleness is preferable to a wrong estimate. The next response refreshes it.
- **Git branch is best-effort**: a slow or broken git never blocks the prompt. The segment silently disappears.
- **Async ripple**: `formatStatusBar` and `formatStatusBarForEvent` are now `async`. Callers in `cli.ts` already `await` setup, so the change is local. Any future sync caller must be audited.
- **Test coverage**: new `describe("status bar revision", ...)` block in `test/chat-repl.test.ts` covering: `?` before first response, exact `lastUsage.totalTokens` after, no trailing delta on new user message, `?` after `recover()`, git branch normal / detached / absent, model name at the start with no `model ` prefix, **resume with persisted `usage` shows the real number (not `?`)**, **resume without `usage` (old session) shows `?`**, **cache hit rate shown when `cacheRead + input > 0`**, **cache hit rate hidden when `cacheRead + input === 0`**, **cache hit rate hidden when `lastUsage` is `null`**, **`Hit(0.0%)` shown for legitimate zero hit rate**. Git is mocked via scoped `vi.mock("../src/git.js", ...)`; `lastUsage` is driven through the real `ConversationContext`; resume is exercised by constructing a `MessageEntry[]` with `usage` set on the last assistant message and calling `hydrateState`.
- **Dropped the `model ` prefix; kept the model name.** The first segment is the bare `{modelName}`. The prompt area does not surface the active model, so the status bar is where the user sees it; only the redundant `model ` label was removed.
- **Live-then-truth token number during a turn**: the token count may tick up (live `chars/4` estimate via `formatStatusBarForEvent`) while a turn runs and then settle to the provider's `totalTokens` (ground truth) once the response is recorded. This is expected progress feedback from the event redraw, *not* the "stale estimate" decision 1 prohibits (that rule is scoped to the idle / prompt redraw). Concretely: a fresh session shows `?`, typing and pressing Enter shows a rising `N/limit` during generation, and on completion it snaps to `{lastUsage.totalTokens}/limit (pct%) [Hit(x%)]`. Two tests encode it: `formatStatusBarForEvent uses live context token estimate` and `formatStatusBarForEvent uses event token estimate when available`.

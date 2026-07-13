# 0013 — Entry-stream builders already have one owner (candidate 5, no change)

- **Status**: Accepted
- **Date**: 2026-07-13
- **Commit**: `—` (no code change)

## Context and Problem

The architecture-review deepening pass (candidate 5, "Fold the entry-stream builders into one owner") claimed that `hydrateState` and `resolveEntriesForPersist` each independently rebuild a stream from the legacy `{summary, recentMessages}` pair via `buildEntriesFromContextState`, and that "two synthesis paths means two places to drift."

That premise was already resolved by **ADR-0004** (`db809cd`, committed 2026-07-12 — a day before the review was generated). In the current tree both call sites route through the single `buildEntriesFromContextState` seam:

- `hydrateState` (`src/agent/context.ts:330`) — `if (state.entries?.length) … else buildEntriesFromContextState(...)`.
- `resolveEntriesForPersist` (`src/session/format.ts:297`) — `if (contextState.entries?.length) return … else buildEntriesFromContextState(...)`.

The entry-stream builders (`buildEntriesFromContextState`, `appendCompactionEntry`, `appendMessageEntries`, `deriveContextStateFromEntries`) already live in `src/session/format.ts`, which is the owner module. `ConversationContext.hydrateState` and `recordCompaction` merely delegate to it. There is no second synthesis path to fold.

## Considered Options

1. **No code change; record that ADR-0004 already achieved the goal (adopted)** — the report's premise was stale relative to the current tree. Forcing a change would be churn for churn's sake.
2. **Light locality cleanup** — extract a `hydrateEntries(state)` helper into `format.ts` so the `if (state.entries) … else buildEntries…` branch leaves `context.ts`. Rejected: the branch is a one-line delegation decision, not a synthesis path; moving it buys no duplication reduction and adds a function for its own sake.

## Decision

Candidate 5 is **already implemented** by ADR-0004. No code change. `src/session/format.ts` is the single entry-stream owner module; both hydration and persistence share `buildEntriesFromContextState`.

## Consequences

- No behavioral or structural change.
- A future explorer reading the architecture-review HTML should not re-suggest folding the two synthesis paths — they were unified in `db809cd`.

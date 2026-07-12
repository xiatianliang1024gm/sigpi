# 0004 — Single owner for the entry stream

- **Status**: Accepted
- **Date**: 2026-07-12
- **Commit**: `db809cd`

## Context and Problem

The on-disk entry stream (`SessionEntry[]`) is the core of session persistence. Its serialization happens in `src/session/format.ts`'s `resolveEntriesForPersist`. That function originally had **two** streams of entry-producing logic:

1. Trust `contextState.entries` (the runtime path, maintained by `ConversationContext` as the accumulated stream);
2. When the caller only passes `{summary, recentMessages}`, use an **ad-hoc merge** (dedupe by id + randomly fill ids + hand-build compaction / message entries) to extend a new stream from `session.entries`.

Path (2) is a second producer and is **inconsistent** with `hydrateState`'s `buildEntriesFromContextState` logic that synthesizes a stream from `{summary, recentMessages}` — the same input has two synthesis implementations, violating "single owner for the entry stream".

## Considered Options

1. **Collapse into a single synthesis seam** (adopted):
   - No `contextState` → return `session.entries` (caller owns its stream);
   - Has `contextState` with `entries` → trust its accumulated stream (runtime path);
   - Only when the caller does **not** maintain `entries`, synthesize a "new window" with the same `buildEntriesFromContextState` as `hydrate`, then **append** it onto the existing accumulated `session.entries`.
2. Delete the fallback outright and replace it with `buildEntriesFromContextState` **rebuilding** the window: `return buildEntriesFromContextState({summary, recentMessages})`.
   - Rejected: this would **drop history** in multi-turn scenarios. The root cause is that `store.writeSession` persists by **incrementally appending** `entries.slice(prevCount)`, requiring `session.entries` to always be the **full accumulation**. Rebuilding the window (only the latest turn) makes `entries` non-accumulating, so the delta append breaks (`entries.length` does not grow, no error, no new lines persisted). The multi-turn integration test (`session store writes append-only transcript`) went red on the spot — a hidden contract the review had not anticipated.

## Decision

```ts
export function resolveEntriesForPersist(args): SessionEntry[] {
  if (!args.contextState) return args.session.entries;          // caller owns it
  if (args.contextState.entries?.length) return args.contextState.entries; // runtime: trust
  const base = args.session.entries ?? [];                      // compat path for non-stream-aware callers
  const window = buildEntriesFromContextState({                 // single synthesizer (same as hydrate)
    summary: args.contextState.summary ?? null,
    recentMessages: args.contextState.recentMessages ?? [],
    timestamp: args.timestamp,
  });
  return [...base, ...window];                                 // append, keep append-only
}
```

Removed the original ad-hoc merge / id-dedupe / hand-built-entry duplication. `hydrateState` and `resolveEntriesForPersist` now share the same synthesis seam (`buildEntriesFromContextState`).

## Consequences

- **Single owner**: the runtime path always trusts `ConversationContext`'s accumulated `entries`; non-stream-aware callers (legacy / tests) synthesize a window via `buildEntriesFromContextState` and append, keeping append-only.
- **Deduplicated synthesis**: hydration and persistence share one synthesis implementation instead of each maintaining its own.
- **Behavior unchanged**: the runtime always takes the "trust `entries`" path; legacy / test callers still get an accumulated, append-only stream (multi-turn integration tests and restore tests keep their original assertions).
- `session-format` tests updated to assert the "old transcript retained + new window appended" semantics.
- biome + tsc clean; full suite 398/398 passed.

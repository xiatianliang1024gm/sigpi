# 0001 — Fold session-store lifecycle methods' commit scaffolding into a private commit seam

- **Status**: Accepted
- **Date**: 2026-07-12
- **Commit**: `6986d53`

## Context and Problem

`src/session/store.ts` has five nearly isomorphic lifecycle methods:

- `markTurnStarted`
- `markTurnCompleted`
- `updateSnapshot`
- `markTurnFailed`
- `markTurnInterrupted`

Each repeats the same tail: "assemble `updated` → `writeSession(updated)` → `writeIndex(upsertSummary(readIndex(), updated))`". This persistence sequence is the session store's **real commit point**, yet it is scattered across five places, violating locality: any invariant about "a successful commit must refresh both meta and index" would have to be changed in five spots, and a miss means inconsistency.

Creating a session (`createSession`) and the recovery branch of `loadSession` (corruption recovery) are semantically different paths and should not be unified.

## Considered Options

1. **Extract a private `commit(session)` that owns writeSession + writeIndex** (adopted). The five methods only assemble `updated` and then `return this.commit(updated)`.
2. Also funnel `createSession` / `loadSession`'s recovery branch into `commit`.
   - Rejected: `createSession` writes meta first then builds an empty index, and `loadSession`'s recovery branch is a fallback rebuild while reading corrupt data — **semantically different**; funneling them in would hide those differences and reduce readability.

## Decision

Add a private method:

```ts
private async commit(session: PersistedSession): Promise<PersistedSession> {
  await this.writeSession(session);
  await this.writeIndex(await this.upsertSummary(await this.readIndex(), session));
  return session;
}
```

It owns only the "write + index" step (not read-modify-write). The five lifecycle methods' tails shrink from ~5 lines of scaffolding to `return this.commit(updated)`. `createSession` and `loadSession`'s recovery branch stay explicit and do not call `commit`.

## Consequences

- **Improved locality**: the commit-point invariant is defined in one place; a new lifecycle method only needs to assemble `updated` and `return this.commit(updated)`.
- **No new tests**: the existing suite already covers each lifecycle method's persistence behavior; the refactor did not change externally observable behavior, so no separate test for `commit` was added (avoiding leaking internals just for testing).
- Behavior unchanged.

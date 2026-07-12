# 7. Session & Persistence (advanced)

The loop produces a turn; a *session* is the sequence of turns, saved so you can close the terminal
and resume later. This chapter covers how SigPi persists and rehydrates context.

## Two owners of state

- **`ConversationContext`** (`src/agent/context.ts`) owns the *live* state: summary, recent
  messages, the entry stream, and the exploration ledger. It is the source of truth while running.
- **`SessionStore`** (`src/session/store.ts`) owns *persistence*: writing that state to disk and
  reading it back.

The loop only ever talks to `ConversationContext`. Persistence is a side effect handled through a
single serialization module.

## The entry stream

The bridge between live state and disk is the **entry stream** — an append-only list of entries
(summary entries, message entries, compaction entries). One module owns it:

```ts
// src/session/format.ts — EntryStreamSerializer
buildEntriesFromContextState(state)      // state -> entries (from scratch)
resolveEntriesForPersist(state, entries) // state -> entries (append-only merge)
deriveContextStateFromEntries(entries)   // entries -> state
```

Both `ConversationContext` and `SessionStore` delegate here, so the conversion logic lives in exactly
one place. The context stays the single owner of truth; the store just records its stream.

## Where things live

Sessions are stored globally under `~/.sigpi/projects/<project-key>/sessions/`. Each session has an
`index.json` plus its entry stream. `SESSION_VERSION` (currently `4`) tags the format so older
session files can be detected/migrated.

## Resume

On resume (`/resume` in the REPL, or `chat --session <id>`), `SessionStore.loadSession` reads the
entry stream and `deriveContextStateFromEntries` rebuilds the live context. Two fingerprints guard
against silent mismatches:

- **system-prompt fingerprint** — if the system prompt changed since the session was saved, the old
  transcript may not match the new prompt.
- **skills fingerprint** — same idea for loaded skills.

A mismatch does not crash; it produces a **warning** (`loadedSession.warnings`) so you know the
resumed context may be stale.

## Key takeaways

- Live state (`ConversationContext`) and persisted state (`SessionStore`) are separate concerns.
- The entry stream + one serializer module is the only place that converts between them.
- Resume is "rebuild live state from the saved entry stream," with fingerprints to flag drift.
- A session is just a persisted turn transcript plus compaction entries — no special "agent memory"
  subsystem is needed.

Next: [Real-world Concerns](./08-real-world-concerns.md).

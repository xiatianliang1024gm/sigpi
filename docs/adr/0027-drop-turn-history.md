# ADR 0027 — Drop turn history from the session meta file

- **Status**: Accepted (grilled 2025)
- **Relates to**: `src/session/store.ts`, `src/session/format.ts`, `src/agent/context.ts`, `src/types.ts`, `src/cli.ts`
- **Supersedes**: `PersistedSession.turns` (`SessionTurnHistoryEntry`), `nextTurnId`, `session show` / `formatSessionDetails`, `parseTurnId`

## Context

`{id}.meta.json` is rewritten **in full** on every commit (`writeJsonAtomic`).
The `turns` array was the source of O(n²) write amplification: each turn
(including the full `toolExecutions` payload — `toolCall` + structured
`result` with `data`/`error`/`details`) was appended once, then **every**
subsequent commit (turn start, each message snapshot, turn end) rewrote the
entire history again. The jsonl file, by contrast, is append-only — message
and compaction entries are written once and never rewritten.

Goal: stop persisting turn history into the meta file, reuse the jsonl
append path, and cut disk writes.

Survey of consumers:

- `turns` had exactly one *live* reader with behavior: `nextTurnId`
  (store.ts) — an internal counter for the numeric `turnId`. The other
  readers were `formatSessionDetails` (the `session show` CLI) and tests.
- Turn status (`completed` / `failed` / `interrupted`) had **no behavioral
  consumer** in code. Crash recovery reads the single `lastTurn` record
  (`status === "in_progress"` → normalize to `interrupted` + warning) — not
  the `turns` array.
- The runtime turn id is already a UUID (`randomUUID()` in
  `src/agent/runner.ts:354`). The persisted numeric `turnId` was a parallel
  construct: `parseTurnId` (context.ts:629) ran `parseInt` over a UUID and
  produced `null` or a garbage leading digit.
- jsonl message entries already carry a `turnId` field (numeric, nullable —
  `null` on compaction-rebuilt entries).

## Decision

### D1 — Delete `turns` from the meta file

Remove `PersistedSession.turns` / `SessionTurnHistoryEntry`, the
`sessionTurnHistoryEntrySchema`, `sessionToolExecutionEntrySchema` and
`toolExecutionResultSchema` zod schemas (`toolCallSchema` **stays** — it is
still used by `assistantMessageSchema.toolCalls`), the `turns: [...]` appends
in all four `markTurn*` paths, the interrupted-entry append in crash
recovery (store.ts:353-364 — keep the `lastTurn` normalization + warning),
the `turns.length === 0` clause in `isEmptySession`, and the timestamp
normalization loop over `turns` (~store.ts:1004).

### D2 — No replacement persistence for turn history

`session show` is deleted (CLI branch, usage line, import, and
`formatSessionDetails` in `session/format.ts`), so turn history has **no
consumer left**. No `kind: "turn"` jsonl entry type is added and nothing is
derived from jsonl — the data is simply dropped.

### D3 — `turnId` becomes the runtime UUID

Delete `nextTurnId` (store.ts:1033) and `parseTurnId` (context.ts:629).
The jsonl message entry's `turnId` field **stays** as an audit attribute
(which turn a message belongs to), but becomes `string | null`, written
directly from `requestContext?.turnId` (already a UUID). One append-only
write per message — cost is negligible against the O(n²) being removed.

### D4 — Keep `lastTurn` and `turnCount` in the meta file; no back-compat

`lastTurn` remains the crash-recovery anchor (it carries `in_progress`
status and the `toolExecutionCount` number, but **no tool payload** — a
single bounded record, O(1) per commit). `turnCount` stays a scalar (it
feeds `index.json` / `session list` / `/session info`). Old session files
with a `turns` field are **not migrated**: zod's non-strict object parsing
strips the unknown key on load. Historic session files lose their turn
history — accepted.

## Considered Options

- **Add `kind: "turn"` jsonl entries** (one append at turn end, preserving
  turn status) — rejected: turn status has no consumer once `session show`
  is gone; adding an entry type for dead data.
- **Derive turns from jsonl grouped by `turnId`** — rejected:
  compaction-rebuilt messages have `turnId: null`, and a failed/interrupted
  turn that produced no messages leaves no trace in jsonl; status semantics
  are not derivable.
- **Keep `turns` in meta but strip `toolExecutions`** — rejected: the
  history is still rewritten wholesale on every commit; doesn't fix the
  amplification and doesn't reuse the append path.

## Consequences

- Per-commit meta rewrite drops from O(n²) (history × tool payload × commits)
  to O(1) bounded (scalars + `lastTurn` + delta entries).
- Structured tool-execution data (`toolCall` / `result` with `data` / `error`
  / `details`) is no longer persisted anywhere — tool payloads exist only as
  rendered text in jsonl. No consumer; accepted.
- `session show` is gone; `session list` (index.json summary) is unaffected.
- Turn status is no longer persisted beyond `lastTurnStatus` in `index.json`
  (derived from `lastTurn.status`).

## Implementation checklist

1. `src/types.ts` — delete `SessionTurnHistoryEntry` and
   `PersistedSession.turns`; change `SessionEntry.turnId` from
   `number | null` to `string | null`.
2. `src/session/store.ts` — delete `nextTurnId`, `sessionTurnHistoryEntrySchema`,
   `sessionToolExecutionEntrySchema`, `toolExecutionResultSchema`; drop the
   `turns` appends in all four `markTurn*` paths and in crash recovery (keep
   the `lastTurn` normalization + warning); drop the `isEmptySession` turns
   clause and the turns timestamp-normalization loop.
3. `src/agent/context.ts` — delete `parseTurnId`; pass
   `requestContext?.turnId ?? null` straight into `appendMessageEntries`.
4. `src/cli.ts` + `src/session/format.ts` — delete the `session show` branch,
   usage line and import; delete `formatSessionDetails`.
5. Tests — delete the `formatSessionDetails` test from `test/session-format.test.ts`
   (the entry-stream tests for `deriveContextStateFromEntries` /
   `resolveEntriesForPersist` stay); drop the `turns` / `toolExecutions`
   assertions (including the structured tool-result round-trip) from
   `test/session-store.test.ts`; drop the `turns` assertions from
   `test/session-runtime.test.ts`; change fixture `turnId` values from
   numbers to strings (`test/session-store.test.ts`,
   `test/session-runtime.test.ts`, `test/context-entries.test.ts`,
   `test/transcript-replay.test.ts`, `test/chat-commands.test.ts`).

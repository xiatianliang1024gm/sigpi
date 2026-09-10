# Context Map

Ubiquitous language for the sigpi agent. Terms are defined once here and
linked from code. Keep entries short; expand nuance in the source code.

## Terms

### Turn summary
The user-facing "Work done this turn" note emitted after a compaction or max-steps fallback
(`src/agent/runner.ts` — `buildMaxStepsFallbackAnswer`). A concise handoff of **which files were
read and which were modified** this turn.

### File operation (summary scope)
A tool execution recorded in the turn summary. Restricted to an allow-list: `read` → *Read*,
`edit`/`write` → *Modified*. All other tools (`bash`, `grep`, `glob`, `update-plan`) are excluded.

### Read / Modified
The two line kinds in a turn summary. `Read <path>` for the `read` tool; `Modified <path>` for
`edit`/`write`. When a path is both read and modified in a turn, only `Modified` is recorded
(modified wins, one line per path).

### Compaction
The single context-compression path (ADR 0026): old messages are summarized
when the token budget is exceeded (auto) or on `/compact` (force). Two pure
interfaces — `decide` (pure check + split) and `execute` (summarize, returns
`{summary, usage}`) — orchestrated by `ConversationContext.compact()`
(`src/agent/compaction.ts`, `src/agent/context.ts`). The
turn summary is a separate, user-facing artifact. Retired: turn checkpoint,
`Compactor` class, `trimToHardLimit`.

## ADR Index

- **ADR 0026** — Compaction refactor: one compaction path, two triggers, two pure
  interfaces. `docs/adr/0026-compaction-refactor.md` (first standalone ADR file;
  prior ADR numbers in `CONTEXT.md` are historical back-references with no files).
  See `AGENTS.md` for the reading path.
- **ADR 0027** — Drop turn history from the session meta file.
  `docs/adr/0027-drop-turn-history.md`.
- **ADR 0028** — Frontend-agnostic session controller: a headless
  `SessionController` between the runtime and every frontend, plus the UI-neutral
  reducer and an SSE transport. `docs/adr/0028-frontend-agnostic-session-controller.md`.

## Terms (continued)

### Session controller
The headless orchestrator (`src/session/controller.ts`) that owns an agent
turn's lifecycle and its `TurnInterruptController`, and exposes one
`onProgress` stream plus `submit`/`requestInterrupt`. Both the TUI and the
web/SSE frontend hold one; it never touches the terminal.

### Turn transcript view
The minimal output surface (`TurnTranscriptView`, `src/session/events.ts`) that
`applyTurnProgress` folds `TurnProgressEvent`s into. `ReplView` (TUI) and a web
transcript sink both implement it, which is what lets one reducer drive every
frontend.

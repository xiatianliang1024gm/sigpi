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
Context compression that replaces old messages with a structured summary
(`src/agent/summarizer.ts`, `src/agent/context.ts`). Produces the working-context checkpoint; the
turn summary is a separate, user-facing artifact.

## ADR Index

No ADRs are currently maintained. See `AGENTS.md` for the reading path.

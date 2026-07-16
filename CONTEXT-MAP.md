# Context Map

Ubiquitous language for the sigpi agent. Terms are defined once here and linked from ADRs and
code. Keep entries short; expand nuance in the referenced ADR.

## Terms

### Turn summary
The user-facing "Work done this turn" note emitted after a compaction or max-steps fallback
(`src/agent/runner.ts` — `buildMaxStepsFallbackAnswer`). A concise handoff of **which files were
read and which were modified** this turn. See ADR-0022.

### File operation (summary scope)
A tool execution recorded in the turn summary. Restricted to an allow-list: `read` → *Read*,
`edit`/`write` → *Modified*. All other tools (`bash`, `grep`, `glob`, `update-plan`) are excluded.
See ADR-0022.

### Read / Modified
The two line kinds in a turn summary. `Read <path>` for the `read` tool; `Modified <path>` for
`edit`/`write`. When a path is both read and modified in a turn, only `Modified` is recorded
(modified wins, one line per path). See ADR-0022.

### Exploration ledger
The in-context structured record injected into the model's working context
(`src/agent/exploration-ledger.ts`): searched queries, candidate files, read ranges, rejected
paths, key findings, modified files. Distinct from the turn summary — it tracks searches too and
is consumed by the model, not shown as the turn handoff. See ADR-0011.

### Compaction
Context compression that replaces old messages with a structured summary
(`src/agent/summarizer.ts`, `src/agent/context.ts`). Produces the working-context checkpoint; the
turn summary (ADR-0022) is a separate, user-facing artifact.

## ADR Index

- ADR-0011 — Process output modes: compact vs detailed
- ADR-0021 — Context budget moves to model level
- ADR-0022 — Turn summary records only file read/modify operations

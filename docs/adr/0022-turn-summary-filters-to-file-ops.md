# 0022 — Turn summary records only file read/modify operations

- **Status**: Accepted
- **Date**: 2026-07-15
- **Area**: turn summary (`src/agent/runner.ts` — `summarizeToolExecutions`, `buildMaxStepsFallbackAnswer`)

## Context and Problem

After a context compaction (or a max-steps fallback), the agent emits a user-facing
"Work done this turn" summary built by `summarizeToolExecutions` in
`src/agent/runner.ts:1008`. The current implementation classifies every executed tool
call **by the shape of its arguments**, not by the tool's identity:

```ts
const pathArg = execution.toolCall.arguments.file_path;
const commandArg = execution.toolCall.arguments.command;
const fact =
    typeof pathArg === "string" ? `Read ${pathArg}`
    : typeof commandArg === "string" ? `Ran ${commandArg}`
    : `Called ${execution.toolCall.name}`;
```

This leaks non-file operations into the summary:

- `bash` carries a `command` arg → emitted as `Ran pwd && ls -la`, `Ran gh issue view ...`, etc.
- `grep` / `glob` carry neither `file_path` nor `command` → emitted as `Called grep`, `Called glob`.
- `edit` / `write` carry `file_path` → mislabeled as `Read <path>` even though they modify files.

The intent of the summary is to tell the next phase **which files were read and which were
modified** — a compact handoff note, not a transcript of every tool call. Bash, grep, and glob
are search/shell operations that do not need to be recorded (the in-context exploration ledger
already tracks searches separately).

## Decision

Filter the turn summary by an **explicit tool-name allow-list** instead of by argument shape.

- Allow-list: `{ read, edit, write }`. Every other tool (`bash`, `grep`, `glob`, `update-plan`,
  and any future tool) is skipped entirely.
- `read` → `Read <path>`.
- `edit` / `write` → `Modified <path>`.
- **Same-path precedence**: if a path appears as both a read and a modify, record only
  `Modified <path>` (a modification implies the file was touched; the separate `Read` line is
  redundant). Implement by accumulating a `Map<path, "read" | "modified">` where `modified`
  overwrites `read`, then emitting one line per path.
- Keep the existing `slice(0, 20)` cap on emitted lines (safety bound; file operations rarely
  approach it).
- Paths are emitted as-is (absolute, from `arguments.file_path`) — no relative conversion or
  truncation, matching prior behavior.

## Options Considered

**Q1 — Classify by argument shape or by tool name?**
- *Argument-shape heuristic (status quo)*: fragile — any future tool taking `file_path` would be
  mislabeled as `Read`, and `bash`/`grep`/`glob` still leak via the `Ran`/`Called` fallbacks.
- *Tool-name allow-list (chosen)*: robust to argument changes, matches intent, explicitly
  excludes search/shell tools.

**Q2 — How should `edit` / `write` be labeled?**
- *All as `Read` (minimal change)*: semantically wrong — modifications shown as reads.
- *Split `Read` vs `Modified` (chosen)*: honest handoff, matches "read which / changed which".

**Q3 — Same file read and modified?**
- *Record both*: redundant.
- *Modified wins, one line (chosen)*: concise and sufficient.

**Q4 — Line cap?**
- *Keep 20 (chosen)*: safe, unchanged behavior.
- *Remove / raise*: unnecessary; file ops don't explode in count.

## Consequences

- The "Work done this turn" summary will read like:
  ```
  Work done this turn:
  - Read /home/.../SKILL.md
  - Read /home/.../exploration-ledger.ts
  - Modified /home/.../runner.ts
  ```
  with no `Ran ...`, `Called grep`, or `Called glob` lines.
- `bash`, `grep`, `glob`, `update-plan` no longer appear in the user-facing turn summary.
- The in-context exploration ledger (`src/agent/exploration-ledger.ts`) is unchanged — it
  continues to track searches, read ranges, and modified files for the model's own context.
- Future tools that read or modify files must be added to the allow-list explicitly; omission
  means they are silently excluded from the summary (acceptable — summary is a handoff note, not
  an audit log).

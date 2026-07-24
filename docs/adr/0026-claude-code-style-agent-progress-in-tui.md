# Claude Code-style agent progress rendering in TUI

The persistent TUI (ADR 0025 A1) currently shows tool results as detached
`ToolResultMessageComponent` blocks appended after each tool completes. This
creates a visual split between the model's narrative (the reasoning+content
streamed into `AssistantMessageComponent`) and the tool-execution evidence —
the two don't read as a single activity log. We decided to adopt Claude Code's
glyph + indent vocabulary so the TUI renderer produces a flowing narrative
stream with inline tool indicators, matching the mental model users already
have from `claude`.

## Decision

### ReplView interface: `beginToolLine` replaces `addToolResult`

`addToolResult(rendered, toolName?, toolResultData?)` is deleted and replaced
with a two-phase lifecycle — "open on start, finish/fail on result" — so the
TUI can show an in-progress tool indicator that resolves in place:

```typescript
interface ToolLineHandle {
  /** Append a success summary to the same line. For edit/write tools, pass an
   *  optional FileEditSummary to render an inline git-diff below the line. */
  finish(outcome: string, diffSummary?: FileEditSummary | null): void;
  /** Append an error summary to the same line, rendered red. */
  fail(error: string): void;
}

// On ReplView:
beginToolLine(id: string, label: string, toolName: string): ToolLineHandle;
```

The REPL loop (`applyTurnProgress`) keeps a `Map<string, ToolLineHandle>`,
calling `beginToolLine` on `tool_execution_started` and `finish`/`fail` on
`tool_execution_finished`. Terminal events finalize any remaining handles.

### Dedup removed

The runner's `findRecentDuplicateToolCall` / `buildDuplicateToolCallResult`
block and the `DEDUP_*` constants are deleted. Tools no longer get short-circuited
by parameter matching; every tool call runs or fails on its own.

### Visual vocabulary

```
❯ user input                                    ← UserMessageComponent (unchanged)
● Let me read the config file.                  ← AssistantMessageComponent, ● prefix
  ⎿ Read src/config.ts → 42 lines              ← ToolLineComponent, 2-space indent
  ⎿ Edit src/config.ts → success               ← ToolLineComponent
    │ - const port = 3000                       ← FileEditComponent, 4-space indent
    │ + const port = 8080                       ←   git-diff style (green bg / red bg)
● Done. Port changed.                           ← next AssistantMessageComponent
System: compaction notice                        ← SystemMessageComponent (unchanged)
```

| Glyph | Meaning | Indent |
|-------|---------|--------|
| `❯` | user input | 0 |
| `●` | model narrative (new prefix on AssistantMessageComponent) | 0 |
| `⎿` | tool-call line (replaces old ToolResultMessageComponent blocks) | 2 spaces |
| `⏐` | diff preview line (only below edit/write tool lines on success) | 4 spaces |

### Diff below edit/write

When an `edit` or `write` tool succeeds, `finish(outcome, diffSummary)` renders
a `FileEditComponent` (already exists in `src/tui/file-edit-renderer.ts`)
directly below the tool line, indented 4 spaces. The diff uses git-style
colored +/- lines (green background for additions, red for deletions).

Same-path edits within a turn should eventually merge into one diff block, but
the first implementation shows one diff per tool line.

### Batch file-edit summaries removed

The `formatFileEditSummaries` loop at `cli.ts:450-452` is deleted — every edit
is already rendered inline by its tool line.

### Tool failure rendering

On failure: the tool line's `⎿` prefix stays, the error text renders red, and
the REPL loop additionally appends a one-line error `SystemMessageComponent`.

## Considered options

**A) Interface-level tool-line lifecycle (chosen).** `beginToolLine` sits on
`ReplView`, the REPL loop owns the handle map. Every implementation of
`ReplView` is forced to think about the two-phase lifecycle.

**B) Internal to `applyTurnProgress`.** `ChatRenderer` manages a private
`Map<string, Component>` without surfacing the concept to the `ReplView`
interface. Rejected because the tool line is a genuine display concept — future
console/non-TTY renderers will want their own compact version.

## Consequences

- `ReplView` grows one method and one handle interface; `addToolResult` is
  removed. All call sites (CLI REPL loop, tests) must adopt the new lifecycle.
- The dedup removal simplifies the runner by ~35 lines and eliminates the
  parameter-normalization machinery (`sortObjectKeys`, `normalizeToolCallKey`).
- The `assistant_text` path (non-streaming steps between tool calls) now
  naturally flows through `AssistantMessageComponent` with the ● prefix, so the
  earlier gap where `assistant_message` events were silently dropped in TUI
  mode is closed.

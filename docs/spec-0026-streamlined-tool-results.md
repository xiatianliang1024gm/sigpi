# 0026 -- Streamlined tool results for the LLM

- **Triage label**: `ready-for-agent`
- **Grilled**: 2026-07-22

## Problem Statement

Tool results sent to the LLM are noisy. The `formatToolExecutionResult` envelope wraps every result in `TOOL:`/`STATUS:`/`RESULT:` headers, and per-tool rendered outputs include metadata fields (shell, cwd, exit code, pattern, path, result count, etc.) that the LLM does not need. On success, the LLM only needs the actual result: file content, search matches, directory listing, or stdout. The metadata bloats context windows and distracts the model. On framework errors, however, structured error information remains valuable for the LLM to diagnose and correct its approach.

## Solution

Separate the LLM-bound rendering path from the display path. On framework success (`ToolExecutionResult.ok = true`), return only the tool's essential result to the LLM — no envelope, no metadata fields. On framework error, preserve the existing error format. The display layer (CLI, TUI) gets its own formatting seam that has access to both the LLM result string and the structured `toolResultData`, enabling per-tool display decisions (diffs for edit/write, special handling for plan updates, etc.) without polluting what the model sees.

## User Stories

1. As an LLM agent, I want bash tool results to contain only stdout and stderr, so that I can process command output without scanning past Shell/Cwd/Exit code metadata.
2. As an LLM agent, I want read tool results to contain only the file content, so that I can consume source code directly without summary-line and content-block wrapping.
3. As an LLM agent, I want grep tool results to contain only matching lines, so that I can act on search results immediately.
4. As an LLM agent, I want glob tool results to contain only the file path list, so that I can reference matched files without Pattern/Path/Match count overhead.
5. As an LLM agent, I want edit tool results to be a simple "ok" confirmation, so that I am not distracted by Path/Replacements/Replace all metadata for a write I just performed.
6. As an LLM agent, I want write tool results to be a simple "ok" confirmation, for the same reason.
7. As an LLM agent, I want update_plan tool results to be a simple "ok" confirmation, since I just submitted the plan and do not need it echoed back.
8. As an LLM agent, I want a deduplication result to say "[repeated, see previous result]" instead of expanding structured key-value fields, so that I am quickly informed without noise.
9. As an LLM agent, I want truncated results to include a brief inline truncation notice at the truncation point, so that I know results are incomplete without reading formatted metadata blocks.
10. As a developer working with the sigpi codebase, I want the LLM rendering path and the display rendering path to be separate functions, so that each can evolve independently without coupling display needs to model context.
11. As a CLI user in compact mode, I want successful tool executions to show only a checkmark without extra first-line noise, so that the display stays quiet when everything works.
12. As a CLI user in detailed mode, I want read/grep/glob/bash results shown directly, so that I see the same essential output the LLM sees.
13. As a CLI user in detailed mode, I want edit/write results rendered as a line-numbered diff, so that I can visually inspect what changed in the file.
14. As a TUI user, I want the same display quality as the CLI detailed mode, with per-tool formatting decisions applied consistently.
15. As a system, I want a message-level 65536-character safety-net truncation that only triggers when a tool's own truncation fails, so that the LLM context is protected from runaway output.

## Implementation Decisions

### Core principle

The `rendered` string in each tool's `withRendered(data, rendered)` is the LLM-facing text. The `data` object is for downstream consumers (`recordLedger`, `describeProgress`, exploration ledger, display layer). These two paths are independent. This change only modifies `rendered` values; `data` fields are untouched.

### Envelope removal

The `formatToolExecutionResult` function no longer wraps success results in `TOOL:`/`STATUS:`/`RESULT:` lines. On success it returns the tool's `rendered` text directly. On error (`ok: false`) it keeps the `TOOL:`/`STATUS:`/`ERROR:`/`DETAILS:` structure, since error information is useful diagnostic context for the LLM.

### Per-tool rendered output (success path)

| Tool | New `rendered` | Truncation marker |
|------|---------------|-------------------|
| bash | `joinRenderedSections([stdout, stderr])` — no `STDOUT:`/`STDERR:` labels, no `=== CONTENT START ===` block markers, no Command/Shell/Cwd/Exit code/Signal/Timed out fields | Per-line head/tail truncation at 30000 chars with `...[truncated N chars; showing head/tail]...` in the middle; overflow-to-file preview at 2000 chars |
| read | Content text only (no summary line, no block markers) | `[...truncated, continue from line N]` at truncation point, to tell the LLM how to paginate |
| grep | Matching lines only | `[...truncated, N of M results shown]` at the end |
| glob | File path list only (no Pattern/Path/Matches labels) | `[...truncated, N of M results shown]` at the end |
| edit | `"ok"` | N/A |
| write | `"ok"` | N/A |
| update_plan | `"ok"` | N/A |

### Deduplication result

`buildDuplicateToolCallResult` in the runner changes its `data` from `{repeated, deduplicated, toolName, stepsBack}` to the string `"[repeated, see previous result]"`. The exploration ledger does not consume dedup results, so no downstream breakage.

### Message-level safety-net truncation

`truncateToolMessageContent` threshold changes from 8000 to 65536 characters. It retains head/tail truncation strategy as a last-resort safety net when a tool fails to apply its own truncation.

### Micro-compaction

`makeOmittedToolMessage` placeholder is removed. When a tool result is compacted out of the working context, the corresponding `ToolMessage` content is set to an empty string `""` rather than `[tool result omitted: ...]`. The current placeholders provide no useful information to the model.

### Display layer — compact mode (CLI)

`quietResultSummary` function is removed. On success, compact mode shows only the checkmark glyph followed by blank (no first-line extraction). On failure, the error string from the formatted error result is shown.

### Display layer — detailed mode (CLI)

A new `summarizeToolResultForDisplay` function replaces the current `summarizeClearToolResult`. It receives `toolName`, `ok`, `toolResult`, and `toolResultData`:

- `read`/`grep`/`glob`/`bash`: directly show `toolResult` (the pure result)
- `edit`/`write`: render a line-numbered diff using `toolResultData.editSummary` (a `FileEditSummary` with `kind: "file_edit"`, `path`, `additions`, `deletions`, `preview` lines with `kind`/`lineNumber`/`text`)
- `update_plan`: special handling (plan content already rendered in `tool_execution_started`)
- Framework errors: show the error text
- Other tools: show `toolResult` directly

### Display layer — TUI

`ChatRenderer.addToolResult` signature extended to receive `toolName` and `toolResultData` alongside `rendered`. The TUI applies the same per-tool display logic as detailed CLI mode, reusing `summarizeToolResultForDisplay` or an equivalent TUI renderer.

### Error path unchanged

All `ok: false` paths preserve their existing behavior. Errors from `ToolRegistry.execute` (argument parse errors, unknown tools, validation errors) and errors from tool execution continue to include `rendered` detail strings and the structured `error`/`details` envelope.

## Testing Decisions

### What makes a good test

Only test the external behavior of the rendering functions, not the internal formatting strings. A test should call `formatToolExecutionResult` (or the per-tool execute function) and assert on the shape of the returned string, not on exact line-by-line output (unless the output is as simple as `"ok"`).

### Modules tested

- `formatToolExecutionResult` — success path returns pure `rendered`, error path returns formatted error
- Per-tool `rendered` output — each tool's `execute()` result contains the correct new-style `rendered` string
- `truncateToolMessageContent` — 65536 threshold with head/tail strategy
- `summarizeToolResultForDisplay` — per-tool display logic (edit/write diff, update_plan skip, other tools pass-through)
- `buildDuplicateToolCallResult` — returns string `data`
- `microCompactMessages` — omits tool results to empty string

### Prior art

- `src/tools/__tests__/` — existing tool tests for bash, read, grep, glob, edit, write
- `src/agent/__tests__/` — existing message and context tests

## Out of Scope

- Changing the `data` fields returned by any tool. `command`, `exitCode`, `pattern`, `path`, `totalMatchCount`, `editSummary`, `continuation`, etc. remain in `data` for downstream consumers (`recordLedger`, `describeProgress`, exploration ledger, display layer).
- Changing the `ToolExecutionResult` type shape. `ok`, `data`, `error`, `details` stay as-is.
- Changing how the exploration ledger records tool executions.
- Changing the progress reporting pipeline (`describeProgress`, `TurnProgressEvent` structure).
- Removing or refactoring `withRendered` — the `data`/`rendered` dual-path pattern stays.
- ADR: this spec does not create a separate ADR. The design decisions are documented here.

## Further Notes

The `editSummary` field in edit/write's `data` captures a pre-edit diff preview (with line numbers, additions, deletions) computed before the file is written. It is essential for the display layer because after the file is modified, the original content is lost and line numbers cannot be reconstructed from `old_string`/`new_string` alone. This field stays in `data` and is consumed only by the display layer, never by the LLM.

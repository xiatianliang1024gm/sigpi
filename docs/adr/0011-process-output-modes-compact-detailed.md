# 0011 — Process output modes renamed to compact/detailed; `full` removed

- **Status**: Accepted
- **Date**: 2026-07-13
- **Commit**: (pending implementation)

## Context and Problem

`[agent] process_output` had three modes — `quiet`, `clear`, `full` — and two problems:

- **Names did not convey degree.** `quiet` vs `clear` gave no signal about which was more verbose, so users could not predict what they would get.
- **`full` had no real use and a bad failure mode.** `full` was identical to `clear` except it skipped tool-result truncation, so `read` output (and other large results) dumped whole onto the screen and flooded it. In practice it was only exercised by tests.

The goal: a two-tier vocabulary whose names make the verbosity ordering obvious, with the screen-flooding tier gone.

## Considered Options

1. **Two tiers, hard break, invalid value errors (adopted)** — `compact` (minimal) and `detailed` (default); `full` removed; old names (`quiet`/`clear`/`full`) and any other value fail config validation with an actionable error. `processOutputMode` is not persisted in sessions, so there is no data migration.
2. **Two tiers with deprecated aliases** — accept `quiet`→`compact`, `clear`→`detailed`, `full`→`detailed` and emit a warning.
   - Rejected: keeping the legacy vocabulary defeats the clarity goal; a clean break keeps the config surface small. We accepted the one-time cost of users editing `~/.sigpi/config.toml`.
3. **Keep three modes, just rename** (keep `full` as a raw-output mode).
   - Rejected: `full` has no use scenario and is the source of the screen-flooding complaint.

**Naming** — considered `compact`/`detailed` (adopted), `minimal`/`verbose`, `brief`/`expanded`. `verbose` was rejected because it reads like the discarded `full` (unfiltered output), which `detailed` explicitly is not — `detailed` still truncates tool results at 2000 chars / 80 lines.

## Decision

- Rename the modes to **`compact`** and **`detailed`**; **`detailed` is the default** (replacing `clear`).
- **`compact`** — dense, Claude-Code-style tier: shows the user message and the assistant "thinking" note, and **groups parallel tool calls returned in a single model response** (indented block under the optional assistant note, one line per tool + reduced result). Tool "params" are shown via the human `describeProgress` summary, not raw `toolArguments` JSON.
- **`detailed`** — `compact` plus turn/model-run dividers, counts, and fuller tool-result rendering (still truncated).
- **Remove `full`.** Diagnosis relies on `detailed` truncation plus server-side logs (`~/.sigpi/logs/agent.log` at `debug`).
- **Invalid values error.** Any value outside `{compact, detailed}` — including the old `quiet`/`clear`/`full` — fails config validation with a message stating the valid values and how to fix it (same policy for the `AGENT_PROCESS_OUTPUT` env var).
- **Grouping is `compact`-only.** `detailed` keeps its current per-tool separation and dividers unchanged.

## Consequences

- **Clearer vocabulary**: the name order (`compact` < `detailed`) communicates verbosity directly.
- **Breaking change for users**: existing `process_output = "quiet" | "clear" | "full"` must be updated to `compact` or `detailed`; the validation error tells them how.
- **Implementation surface**: `ProcessOutputMode` enum → `"compact" | "detailed"`; config parser + default + actionable error message + `renderDefaultConfigToml`; `AGENT_PROCESS_OUTPUT` parser (invalid → throws); `renderQuietProgressEvent` renamed to `renderCompactProgressEvent` with the `tool_calls_received`-keyed grouping and assistant-message rendering; dropped the `mode === "full"` branch in `renderClearProgressEvent`; `runner.ts` truncation gate `"clear"` → `"detailed"`; updated `chat-repl.test.ts` / `config.test.ts` and `docs/cli-process-output.md` / example config.
- **No session-data migration**: `processOutputMode` is a runtime display concern, not persisted.

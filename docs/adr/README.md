# Architecture Decision Records

This directory records SigPi's architecture decisions. Each record focuses on **one** decision and uses a unified template:

- **Status**: the current state of the decision (usually "Accepted").
- **Context and Problem**: why this decision is made now and the pain point it addresses.
- **Options Considered**: alternative approaches evaluated, including rejected ones and why.
- **Decision**: the chosen approach.
- **Consequences**: benefits, deliberate trade-offs, behavioral changes, and test coverage.

These records use the codebase-design vocabulary: **module**, **interface**, **depth**, **seam**, **leverage**, **locality** — without introducing words like component / service / API / boundary.

## Architecture review pass (2026-07-12)

The following four decisions came from a single "architecture review → find deepening opportunities → grill and implement each" pass, sharing the same constraints:

- internal seams exist only to isolate complexity, never to leak internal details for testing;
- behavior is preserved (unless a difference is explicitly recorded);
- every commit keeps `biome` + `tsc` clean and the full test suite green.

| # | Title | Commit | One-liner |
|---|-------|--------|-----------|
| [0001](./0001-conversation-context-commit-seam.md) | Fold session-store lifecycle methods' commit scaffolding into a private commit seam | `6986d53` | The five methods' "write session + write index" tail folds into a private `commit()` |
| [0002](./0002-config-alias-table.md) | Unify TOML and runtime config field names with a single alias table | `5d5a808` | TOML↔runtime two-way mapping now has a single `CONFIG_ALIASES` source |
| [0003](./0003-conversation-summarizer-module.md) | Extract ConversationSummarizer as an independent deep module | `e3e4e6c` | Prompt assembly / provider call / extraction / error handling pulled out of the stateless context into `summarize()` |
| [0004](./0004-entry-stream-single-owner.md) | Single owner for the entry stream | `db809cd` | `resolveEntriesForPersist` collapses into one synthetic seam; `ConversationContext` is the sole owner |

## SSE streaming-response pass (2026-07-12)

To mitigate "large responses time out easily", model requests were switched to SSE streaming + idle/stall timeouts. The following three decisions came from a single `/grilling` session (grill-with-docs) and share the same constraints:

- downstream consumer contracts are unchanged (transport reads streamed increments but still returns a complete `ModelResponse`);
- transport stays format-agnostic; delta-shape knowledge stays in the adapter;
- robustness is prioritized over implementation simplicity.

| # | Title | Commit | One-liner |
|---|-------|--------|-----------|
| [0005](./0005-idle-stall-timeout.md) | Idle/stall timeout replaces total-duration deadline | `37f7373` | A single timer resets every frame, covering first-byte and mid-stream silence; no longer kills long-but-steady responses |
| [0006](./0006-streaming-unconditional-with-optout.md) | Streaming on unconditionally in transport + per-model `stream` opt-out + single-chunk JSON tolerance | `37f7373` | Provider constraints forced a reversal from "no new config" to a minimal `stream` switch |
| [0007](./0007-both-adapters-delta-folding.md) | Both adapters do pure delta folding; `responses` does not rely on `response.completed` | `37f7373` | Chose robustness over the `response.completed` full-payload shortcut |
| [0010](./0010-agent-turn-single-module.md) | Agent turn is a single deep module over a SessionStore interface | `—` | One-shot persists a session by default (`--no-session` = in-memory store); `AgentTurn` wraps `SessionRuntime`+`AgentRunner`; `SessionStore` becomes an interface |

## Process output modes pass (2026-07-13)

Renamed `[agent] process_output` from `quiet`/`clear`/`full` to `compact`/`detailed`, made `detailed` the default, removed `full`, and grouped parallel tool calls in `compact`. Came from a `/grilling` session (grill-with-docs).

| # | Title | Commit | One-liner |
|---|-------|--------|-----------|
| [0011](./0011-process-output-modes-compact-detailed.md) | Process output modes renamed to compact/detailed; `full` removed | `—` | Two tiers: `compact` (dense, groups parallel tool calls) and `detailed` (adds dividers/counts); invalid values error; `full` gone |

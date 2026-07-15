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

## Model provider seam pass (2026-07-13)

Gave the `ModelProvider` seam a home module in `src/model/`. Came from the architecture-review deepening pass (candidate 4).

| # | Title | Commit | One-liner |
|---|-------|--------|-----------|
| [0012](./0012-model-provider-seam-home.md) | Model provider seam gets a home module | `d2bcb2f` | `ModelProvider` defined + `createModelProvider` in `src/model/provider.ts`; `createRuntimeProvider` deleted; no consumer names the concrete class |
| [0013](./0013-entry-stream-owner-already-resolved.md) | Entry-stream builders already have one owner (candidate 5, no change) | `—` | ADR-0004 (`db809cd`) already unified `hydrateState` + `resolveEntriesForPersist` on `buildEntriesFromContextState`; report premise was stale |
| [0014](./0014-skill-discovery-helpers-not-collapsed.md) | Skill-discovery helpers not collapsed (candidate 6, no change) | `—` | Rated Speculative; `catalog.ts`/`manifest.ts`/`format.ts` are already a clean orchestrator + 2 pure-helper split, no drift risk |
| [0015](./0015-context-estimation-tokens-only.md) | Context estimation is tokens-only (candidate 3) | `58bb157` | Report premise stale; removed unused `chars` fields from 3 summary helpers, kept `estimateMessageChars` as the `chars/4` basis |
| [0016](./0016-configurable-trusted-roots.md) | Configurable trusted roots replace the hard workspace-write block | `—` | `[tools] allowed_roots` (defaulted via `init` to `os.tmpdir()`) unifies read+write escape from the workspace-write block; `read_only` stays write-closed |

## Skill trust pass (2026-07-13)

Reconsidered the skill trust model after a hands-on comparison with Claude Code
(load implies trust), Codex (`/skill` enable/disable, default enabled), and Pi
(load implies trust). Came from a `/grilling` session (grill-with-docs).

| # | Title | Commit | One-liner |
|---|-------|--------|-----------|
| [0017](./0017-skill-trust-load-implies-trust.md) | Skill trust: load implies trust; skill roots are read-only | `5907ec3` | No trust gate / allowlist; a discovered skill is trusted on load. Skill roots become a hard, mode-independent (incl. `full_access`) write block — the compensating control |

## Streaming render + interrupt pass (2026-07-14)

Came from a `/grilling` session (grill-with-docs) triggered by a "stuck in thinking, no timeout, ESC does nothing" report on a reasoning model (hy3 via OpenRouter). Four coupled decisions: capture reasoning tokens, render them live via one `onDelta` chain, keep `model_delta` render-only vs phase events, and make ESC a terminal cancel (not a retry). The idle/stall timeout is intentionally left unchanged.

| # | Title | Commit | One-liner |
|---|-------|--------|-----------|
| [0020](./0020-streaming-render-and-interrupt-fix.md) | Streaming render of reasoning/content + interrupt-not-retry | `618e08c` | Adapter captures `reasoning_content`; one `onDelta` chain carries `{reasoningDelta, contentDelta}` → `model_delta` event (UI v1 renders reasoning); ESC aborts the turn instead of retrying; idle timer unchanged |

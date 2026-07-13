# Context

Domain glossary for SigPi (formerly TinyPi). Use these names when discussing seams and
deepening opportunities so future architecture reviews share one vocabulary.

## Domain terms

- **Goal resolution** — `src/agent/goal-resolution.ts`. Stateless module that infers the current user goal from the conversation state (summary `## Goal`, exploration-ledger findings, and recent messages), and collapses continuation inputs (`continue` / `继续` / `go on` / …) back onto the previous real goal. Kept free of `ConversationContext` so it is testable in isolation.
- **Conversation context** — `src/agent/context.ts` (`ConversationContext`). Owns the summary, recent messages, entry stream, and exploration ledger; the source of truth for working context.
- **Compaction** — summarizing older recent messages into the summary when the token budget is exceeded (token trigger) or on demand (force).
- **Exploration ledger** — `src/agent/exploration-ledger.ts`. Structured record of what the agent has searched, read, modified, and found, injected into the working context to curb re-exploration.
- **Tool** — a capability the agent can call, defined by `ToolDefinition` and dispatched through `ToolRegistry`. Built-ins live in `src/tools/builtin/`.
- **Session** — a persisted conversation (`src/session/store.ts`). Stores the entry stream (message + compaction entries), turn history, and a recovery snapshot.
- **EntryStreamSerializer** — `src/session/format.ts`. The single module that converts between a context state (`{summary, recentMessages}`) and the entry stream in both directions: `buildEntriesFromContextState` (state → entries, from scratch), `resolveEntriesForPersist` (state → entries, append-only merge into an existing transcript), and `deriveContextStateFromEntries` (entries → state). Context and store both delegate here, so entry derivation lives in one place.
- **Skill** — an instruction document discovered from skill roots and surfaced to the system prompt (`src/skills/`).
- **Model provider** — the `ModelProvider` seam (`src/model/`) that turns a request into a model response. Composed from a format-agnostic `ModelTransport` and a `WireFormatAdapter` (chat-completions or responses); `OpenAICompatibleProvider` is the thin composer that selects the adapter by `config.apiFormat`.
- **Model transport** — `src/model/transport.ts`. Owns HTTP resilience shared by every wire format: fetch, generic SSE framing, stream body reading, an idle/stall timeout that resets on every received chunk, abort merging, error classification (`ModelRequestError` + `RequestFailureKind`), JSON parsing, and the retry/backoff loop. It is format-agnostic — it only parses SSE frames and hands each `data:` payload to the adapter; it never interprets delta shapes.
- **Idle/stall timeout (静默超时)** — a model request's timeout is measured as *silence*, not total duration: one timer starts at `fetch` and resets on every received SSE frame (or body chunk), firing only after `timeoutMs` with no bytes. It therefore guards both a dead server (never sends a first frame) and a mid-stream stall, while no longer killing responses that stream steadily but run long in total. _Avoid_: total-duration timeout, hard turn deadline.
- **Wire format adapter** — `src/model/wire-format.ts` (`WireFormatAdapter`) with two implementations: `ChatCompletionsAdapter` and `ResponsesAdapter`. Each owns its endpoint (`buildUrl`), request-body shape (`toRequestBody`), single-shot response parsing (`parse` — used on the non-streaming path and the single-JSON fallback), and **streaming delta accumulation**: `accumulate(frame)` folds one SSE `data:` payload into running state and `finalize()` emits the complete `ModelResponse`. Keeping delta-shape knowledge in the adapter is what lets the transport stay format-agnostic. Adding an API format means adding one adapter, not forking the transport.
- **Agent turn** — one `runTurn()` pass in `src/agent/runner.ts`: user input → some number of tool-call steps → final answer. This is the concrete shape of the "agent loop" in this project; step count is bounded by `maxSteps`, and exceeding it falls back to a synthesis answer (`buildMaxStepsFallbackAnswer`).
- **Function calling** — the mechanism by which the model emits `toolCalls` in its response, the runner dispatches them via `ToolRegistry`, and the results are fed back into the working context. Distinct from **Tool** (the capability definition): a Tool is "what can be done"; function calling is "how the model drives it".
- **Context management** — see **Compaction**; this project keeps the working context within the token budget using a three-part scheme of "summary + recent messages + in-turn checkpoint", corresponding to one of the three teaching concepts claimed by the README.

## Conventions

- **One-shot prompts persist a session by default.** A `sigpi "prompt"` with no flags creates and persists a Session (mirroring `claude -p`, `codex exec`, and Pi, which all keep a session by default). Ephemeral, fire-and-forget execution is the explicit exception, reached via a `--no-session` opt-out — not the default. Consequence for the architecture: every `Agent turn` is a Session turn, so the runtime need not keep a parallel bare `AgentRunner` alongside `SessionRuntime`; the opt-out path is the only place a non-persisted runner is constructed.

## Seam artifacts

- **Tool seam** — the `ToolDefinition` interface. Deepened so each tool may carry its own progress/ledger adapters instead of tool-specific code living elsewhere.
  - `describeProgress(args)` (optional) — returns `{ summary; detail? }` for progress reporting.
  - `recordLedger(recorder, toolCall, result)` (optional) — records exploration into the ledger via the `LedgerRecorder` facade.
- **LedgerRecorder** — a facade passed to a tool's `recordLedger` adapter. Exposes intent methods (`search`, `read`, `modified`, `finding`, `rejected`, `shellFinding`); the ledger module implements it and owns caps, dedup, and normalization. Keeps ledger invariants out of the tool definitions.
- **ledgerRecorder callback** — injected into `ConversationContext` (mirrors `compactionHooks`) so the context can record into the ledger without depending on the tool registry.

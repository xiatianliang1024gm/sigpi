# 0010 — Agent turn is a single deep module over a SessionStore interface

- **Status**: Accepted
- **Date**: 2026-07-13
- **Commit**: (pending implementation)

## Context and Problem

A single agent turn is driven through a chain of thin modules, and the runtime keeps **two** turn objects alive:

- `SessionRuntime` (owns `runner + context + store + session`) wraps `AgentRunner.runTurn` with `markTurnStarted/Completed/Interrupted/Failed` and `compactContext → store.updateSnapshot`.
- `AgentRunner` is also held bare as `state.runner`, and the REPL falls back to it via `state.sessionRuntime ?? state.runner` (chat-repl.ts:144, chat-commands.ts:180) whenever there is no session.
- `executeChatTurn` (chat-session.ts:7) is a fourth pass-through wrapper that only adds `formatModelErrorMessage` on failure.

The bare `AgentRunner` path is reachable **only** from the one-shot prompt entry (`sigpi "prompt"` with no `--session`/`--create-session`), where `bootstrapSessionState` yields a null session and `runtime.ts:310` skips building `SessionRuntime`. In chat mode a session is always created or resumed, so the `?? state.runner` fallback is dead code. The result: two turn types, a duplicated fallback, and a wrapper — all shallow, all leaking the same turn across seams.

A survey of Claude Code (`claude -p`, `persistSession` opt-out), Codex (`codex exec`, `--resume`), and Pi (always-persisted sessions) shows the field convention: **one-shot prompts persist a session by default; ephemeral execution is the explicit opt-out.** SigPi's ephemeral-by-default one-shot ran against that convention.

## Considered Options

1. **Elevate `SessionRuntime` into the deep Agent turn module (Shape A)** — rename it, fold `executeChatTurn` in, delete the bare runner.
   - Rejected in favor of B: keeping `SessionRuntime` as a named, independently-constructable module preserves its clear `runner + context + store + session` shape and avoids a rename churn across call sites; the new `AgentTurn` wrapper gives a single interface without disturbing `SessionRuntime`'s internals.
2. **New `AgentTurn` module wraps `SessionRuntime` + `AgentRunner` (Shape B, adopted)** — `AgentTurn` is the single turn interface the REPL holds (`state.turn`); it drives `SessionRuntime`, which in turn drives `AgentRunner`. `AgentRunner` survives only as the test surface (`test/agent-runner.test.ts` builds it directly with no store).
3. **Keep one-shot ephemeral by default** — leave the dual `runner | sessionRuntime` state and shrink the refactor to folding `executeChatTurn` only.
   - Rejected: runs against the field convention and forfeits the deletion-test win (the dual state and both fallbacks stay).

For the `--no-session` opt-out:

- **In-memory store (adopted)** — `--no-session` constructs a `SessionRuntime` over an `InMemorySessionStore` (no disk write). `AgentRunner` disappears from production code entirely.
- **Bare runner for opt-out** — rejected: reintroduces the second turn type we are deleting.
- **Temp-dir disk store** — rejected: it *does* write to disk, violating "no disk write", and leaves temp files.

For the store seam:

- **Extract a `SessionStore` interface (adopted)** — pull the ~11 public async methods into `interface SessionStore`; the disk class implements it (renamed `DiskSessionStore`), and `InMemorySessionStore` implements the same contract. `SessionRuntime`/`AgentTurn` depend on the interface. This is a real seam (the store is exactly what varies between persist and don't) and makes `SessionRuntime` the only turn type.
- **Structural union type, no explicit interface** — rejected: weaker typing, implicit interface anyway.
- **Temp-dir disk store** — rejected above.

## Decision

- One-shot prompts persist a session by default; `--no-session` is an explicit opt-out that uses an in-memory store (no disk write). Recorded as a convention in `CONTEXT.md`.
- Introduce `AgentTurn` (`src/agent/turn.ts`) as the single deep turn module. It owns `runner: AgentRunner`, `context: ConversationContext`, and `store: SessionStore` (interface), and exposes `runTurn` / `compactContext` / `getCurrentSession`. The REPL holds `state.turn: AgentTurn` instead of `runner | sessionRuntime`.
- `SessionRuntime` stays as the module that binds `AgentRunner + ConversationContext + SessionStore + PersistedSession` and performs the `markTurn*` orchestration; `AgentTurn` constructs and delegates to it.
- Extract `interface SessionStore` from the current `SessionStore` class. The disk implementation is renamed `DiskSessionStore`; a new `InMemorySessionStore` implements the same interface for `--no-session`.
- Delete `executeChatTurn` (fold its error formatting into the turn module / REPL), both `?? state.runner` fallbacks, and the bare `state.runner` field. `AgentRunner` remains constructable without a store (test surface only).

## Consequences

- **Single turn type**: every turn is a Session turn; the bare `AgentRunner` production path is gone. Locality: turn lifecycle lives in `AgentTurn` + `SessionRuntime`.
- **Leverage**: one `AgentTurn` interface, N call sites (REPL, `/compact`, one-shot, chat).
- **Real seam**: `SessionStore` interface with two implementations (disk + in-memory) — the same "extract interface, two impls" pattern as the model provider seam (candidate 4).
- **Behavior**: one-shot with no flags now persists a session (aligns with Claude Code / Codex / Pi); `--no-session` behaves as before except via an in-memory store rather than a bare runner.
- **Test surface preserved**: `test/agent-runner.test.ts` still builds `AgentRunner` directly; `InMemorySessionStore` makes `AgentTurn`/`SessionRuntime` testable without disk.
- **Deletions**: `executeChatTurn`, dual `runner | sessionRuntime` state, both fallbacks.

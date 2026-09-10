# ADR 0028 — Frontend-agnostic session controller

## Status

Accepted.

## Context

The agent loop (`AgentRunner`) was already UI-neutral: it emits strongly-typed
`TurnProgressEvent`s and depends on nothing in `src/tui/`. But the *orchestration*
around it — reading input, owning the per-turn `TurnInterruptController`, folding
events into the transcript, and computing status — lived inside `runChatReplLoop`
in `src/cli.ts`, welded to the terminal. A second frontend (a web UI) would have
had to copy that orchestration, and this was the only real blocker to running the
TUI and a browser against one shared loop.

## Decision

Insert a headless `SessionController` (`src/session/controller.ts`) between the
runtime and every frontend:

- It owns the turn lifecycle: `submit(input)` creates and owns a fresh
  `TurnInterruptController` for the turn, so `requestInterrupt()` targets exactly
  the in-flight turn and emits the synthetic `interrupt_requested` event on the
  shared stream.
- It re-broadcasts its runtime's progress events to its own listeners and
  re-binds that subscription on `setRuntime`, so a frontend subscribes **once**
  and keeps receiving events across `/new` / `/resume` runtime swaps.
- It is typed against a narrow structural interface, so it never touches the
  terminal, the session store, or the tool registry.

The UI-neutral presentation layer (`src/session/events.ts`) holds the turn→view
reducer (`applyTurnProgress`), the view interfaces (`TurnTranscriptView`,
`AssistantMessageView`, `ToolLineHandle`), and the run-stats helpers. `ReplView`
(the TUI) extends `TurnTranscriptView`, so the same reducer drives the TUI and a
web transcript sink. Formatting helpers moved to `src/format.ts`.

A minimal HTTP/SSE transport (`src/server/http.ts`, `src/server/sse.ts`) maps one
controller to `POST /message`, `POST /interrupt`, and a `GET /events` SSE stream
whose frames carry the same `TurnProgressEvent` shape the TUI switches on.

## Consequences

- The TUI is now "input + render" over the controller; `cli.ts` no longer wires
  interrupts or re-subscribes on runtime swaps by hand.
- A browser client can mirror `applyTurnProgress` almost verbatim over SSE.
- `createAgentRuntime` accepts `cwd`/`homeDir`, moving it toward a fully
  injectable, multi-session (server) shape; `process.cwd()`/`$HOME` remain the
  defaults for the CLI.
- Back-compat shims: `src/cli.ts` re-exports the moved helpers and
  `src/tui/chat-renderer.ts` re-exports the moved view types.
- Still open (not in this change): per-session git-branch state (the branch
  watcher is still a module singleton), command handlers that reach into
  `state.view`, and a serializable status snapshot on the controller.

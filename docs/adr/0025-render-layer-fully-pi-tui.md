# 0025 — Render layer becomes fully Pi-tui component-based

- **Status**: Accepted
- **Date**: 2026-07-19
- **Commit**: `—` (design decision from a `/grilling` session; implementation pending)

## Context and Problem

SigPi's TUI rendering is a hybrid: live UI (reasoning preview, status bar, input
editor) is drawn by Pi-tui's `TUI`, while the turn transcript (final answer, tool
results) is printed by raw `console.log` underneath the live frame. This hybrid is
broken, and the failure was confirmed against Pi-tui's own source:

- Pi-tui's `TUI.stop()` does **not** erase the frame it drew
  (`node_modules/@earendil-works/pi-tui/dist/tui.js:474-497`) — so the previous
  input box and status bar are left on screen as frozen residue after every turn.
- Pi-tui positions its frame through an internal viewport
  (`previousViewportTop`, `hardwareCursorRow`, `maxLinesRendered`) and relative
  cursor moves (`tui.js:976-1260`). External `console.log` advances the real
  terminal without updating those counters, so the next `tui.requestRender()`
  redraws the frame displaced downward — the status bar and prompt reappear below
  the printed answer (the "rendered again" symptom). This happens **throughout**
  the turn, not just at the end, because tool results are also `console.log`'d
  while the frame is alive (`cli.ts` `writeWithActiveRunningInput` →
  `withSuspendedRendering` → `console.log` + `requestRender`).

SigPi originally had its own inline renderer, but it was not componentized —
console writes and manual erases were scattered and hard to maintain, which is
precisely why Pi-tui was adopted. The migration left a half-SigPi/half-Pi-tui
hybrid plus a now-dead `SigPiTerminal.moveTo` / `clearRenderedRows` seam
(`src/tui/sigpi-terminal.ts`) that was built for SigPi's own frame diffing and is
never called (grep: zero usages in `src`).

## Options Considered

1. **Minimal patch: clear the frame on `stop()`, never repaint after an external
   write.** Rejected — insufficient. Tool results are `console.log`'d mid-turn
   while the frame is alive; stopping the frame before each would make the live
   reasoning preview flicker/disappear during tool execution. The two render
   owners cannot coexist for the whole turn.
2. **Revert the running turn to SigPi's own inline renderer** (revive
   `moveTo`/`clearRenderedRows`, drop the Pi-tui `TUI` there). Rejected — this is
   the pre-Pi-tui mess the migration was meant to escape: it re-implements frame
   diffing, IME cursor handling, and display-width wrapping that Pi-tui's
   `Editor` already provides.
3. **Fully Pi-tui component-based render layer (chosen).** Everything drawn live
   during a turn — reasoning preview, status bar, final answer, tool results — is
   a Pi-tui component rendered inside the `TUI`; no raw `console.log` runs while a
   `TUI` is alive. The in-turn shape was a sub-decision: **A1** (a single
   persistent `TUI` for the whole session, transcript = a `chatContainer` of
   per-message components, scrolled by Pi-tui's viewport — Pi's `InteractiveMode`
   model) vs **A2** (per-phase `TUI` that commits the turn's text to stdout at turn
   end, preserving the README stdout-transcript invariant). **A1 chosen** (see
   Decision). Non-TTY / one-shot modes keep `console.log` (no `TUI`).

## Decision

Rewrite the render layer to be fully Pi-tui component-based. Retire the
SigPi/Pi-tui hybrid:

- During a turn, **all** output is rendered through Pi-tui components; the frame
  is never mixed with external `console.log`.
- A **single persistent `TUI`** lives for the whole REPL session (Pi's
  `InteractiveMode` model). The transcript is a `chatContainer` of per-message
  Pi-tui components (user / assistant / tool-result / compaction), with streaming
  updates applied in place; Pi-tui's viewport owns scrolling. There is no
  commit-to-stdout at turn end — the live terminal scrollback is no longer the
- Idle input continues to use Pi-tui's `Editor` (IME, display-width wrapping,
  autocomplete preserved).
- Running-turn input is **queueable** (Pi style): the editor stays active during a
  turn and submitted text is queued into a visible `pending` area (mirroring Pi's
  `pendingMessagesContainer`) and consumed at the next idle prompt; only ESC
  interrupts. Matches SigPi's existing `queuedLines` + resume-on-"go on" model.
  `ProcessTerminal` frame-diff helpers; `SigPiTerminal` becomes a thin pass-through
  over Pi-tui's `Terminal`.
- Idle input continues to use Pi-tui's `Editor` (IME, display-width wrapping,
  autocomplete preserved).
- Non-TTY / one-shot rendering is unchanged (`console.log`, no `TUI`) — spec-0020's
  "drop `model_delta` outside TTY" stands.

**Decided in-turn shape (2026-07-19): A1 — persistent full-screen `TUI` owning a
component-based transcript, matching Pi's `InteractiveMode`.** A single `TUI` spans
the whole session; the transcript is a `chatContainer` of per-message components,
streaming updates applied in place, Pi-tui's viewport owns scrolling. This
**abandons the README's "transcript is plain stdout / terminal scrollback"
invariant** — old turns are no longer in the OS scrollback, they live in the
component tree. Non-TTY / one-shot output stays on its separate `console.log` path
(spec-0020), so non-TTY parity holds. Session persistence is unaffected: the
transcript is already stored via `EntryStreamSerializer` and the TUI is just a view
of it. A2 (inline-commit) was rejected to stay consistent with Pi and avoid
per-phase TUI teardown.

## Consequences

- Removes the root cause of the duplicate / leftover-frame bug: no more two render
  owners fighting over the cursor.
- Trades a scattered hand-rolled renderer for a component model: the transcript is
  a `chatContainer` of per-message components (user / assistant / tool-result /
  compaction), with streaming updates applied in place — mirroring Pi's
  `addMessageToChat` / `streamingComponent` in `interactive-mode.ts`.
- Deletes dead code (`moveTo` / `clearRenderedRows` / `clearRenderedRowsSequence`
  and the now-unused `SigPiTerminal` extensions).
- Preserves: IME / hardware-cursor behavior (Pi-tui `Editor`) and non-TTY output
  (separate `console.log` path). **Abandons** the README's stdout-transcript
  invariant: the live terminal scrollback is no longer the transcript (Pi-tui's
  viewport owns scrolling); session persistence is unaffected because the
  transcript is already stored separately via `EntryStreamSerializer` and the TUI
  is just a view of it.
- Test surface: existing `test/tui.test.ts` / `test/chat-input.test.ts` assertions
  about "no `\x1B[2J`", "transcript not cleared", and "no duplicate prompt" become
  the regression contract for the rewrite; under A1 the assertions shift to
  "transcript is a component tree" / "no external `console.log` while the `TUI` is
  alive" / "no duplicate prompt component".
- The README's "Preserve Transcript Output" section becomes partly outdated under
  A1 (it asserts the stdout-transcript invariant); it should be revised during
  implementation to describe the persistent `TUI` + component transcript model.

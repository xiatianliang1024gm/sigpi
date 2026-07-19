# Spec: Streaming render of reasoning tokens + fully Pi-tui render layer (ADR 0025 A1)

> Synthesized from the `/grill-with-docs` session, ADR 0020 (transport / interrupt /
> event-division), and ADR 0025 (render layer fully Pi-tui, A1 persistent `TUI`).
> Uses the `CONTEXT.md` glossary. This is the implementation brief for those ADRs,
> not a re-opening of those decisions. Triage label: `ready-for-agent`.

## Problem Statement

When a user runs SigPi against a reasoning model over the chat-completions wire
format (for example a reasoning model behind an OpenAI-compatible gateway), the
turn is a poor experience:

- The model streams chain-of-thought as **reasoning tokens** in a separate delta
  field (`reasoning_content` / `reasoning`), but the chat-completions adapter only
  reads `delta.content` and `delta.tool_calls`, so the reasoning is dropped. The UI
  shows only a `thinking` status-bar label with no text — the user cannot tell
  whether the model is working or dead.
- The **idle/stall timeout** resets on *every received byte*, including reasoning
  bytes, so a model that streams thinking indefinitely never trips the timer. There
  is no timeout prompt. (ADR 0024's total request timeout now bounds this case.)
- Pressing **ESC** aborts the in-flight request, but the transport surfaces the abort
  as its own error and does not re-throw the interrupt reason, so the retry loop
  re-issues the request — the turn re-enters `thinking`, and ESC appears to "do
  nothing".
- When the model finally emits content it hits its real output ceiling (well below
  the configured cap) and returns `finish_reason: "length"`; the transport throws a
  truncated error and the partial answer is not saved. The surfaced advice ("increase
  max_tokens") is misleading because the binding constraint is the model's own output
  cap, not the configured request cap.
- The TUI render layer is a hybrid: live UI (reasoning preview, status bar, input
  editor) is drawn by the Pi-tui `TUI`, while the turn transcript (final answer, tool
  results) is printed by raw `console.log` underneath the live frame. This desyncs
  Pi-tui's viewport: `TUI.stop()` does not erase the frame, and external `console.log`
  advances the real terminal without updating Pi-tui's cursor counters, so the next
  render redraws the frame displaced downward — the status bar and prompt reappear
  below the printed answer, and frozen residue from the previous turn is left on
  screen.

The user's actual experience: "stuck in thinking, no result, no timeout, ESC can't
cancel, and the screen keeps drawing over itself."

## Solution

Make a reasoning model's turn **visible, cancellable, and correctly composited**:

1. **Capture reasoning tokens.** The chat-completions adapter reads
   `delta.reasoning_content` / `delta.reasoning` into running adapter state and
   exposes a partial-view accessor returning the incremental
   `{reasoningDelta, contentDelta}` since the last call.
2. **Stream render via one delta chain.** The model provider, transport, and runner
   accept an `onDelta` callback; after each accumulated frame the transport emits the
   adapter's partial view. The runner forwards it as a new `model_delta`
   `TurnProgressEvent`. Rendering is display-only and does **not** change the
   agent-turn control flow (still `await` the full response before tool calls /
   compaction).
3. **Event division.** `model_delta` drives the live text panel only; existing phase
   events (`assistant_message`, `tool_calls_received`, `tool_execution_*`) remain
   persistence/logging-only and are untouched.
4. **Interrupt is terminal, not retryable.** The transport catch recognizes an
   aborted signal and throws the interrupt error (not a retryable network error), so
   ESC cancels the turn immediately.
5. **Fully Pi-tui render layer (ADR 0025, A1).** A single persistent Pi-tui `TUI`
   spans the whole REPL session. The transcript is a `chatContainer` of per-message
   components (user / assistant / tool-result / compaction); the streaming assistant
   message renders the reasoning (thinking block) and content live, in place, from
   `model_delta`. There is no separate reasoning-stream component and no raw
   `console.log` while the `TUI` is alive (that desyncs Pi-tui's viewport). The
   status bar is a persistent footer child; the input editor and a queueable pending
   area are persistent children.
6. **No double-print.** Because reasoning lives inside the assistant message, there
   is no standalone preview to clear; the message simply shows its final state on
   completion / interrupt / failure. `assistant_message` owns the final persisted
   display.
7. **Non-TTY parity.** One-shot / non-TTY modes keep `console.log` (no `TUI`):
   `model_delta` is dropped there except as diagnostic output on a failed / truncated
   turn, and the final answer still prints whole.

## User Stories

1. As a user of a reasoning model, I want the model's thinking to appear live in the
   REPL, so that I can see the model is working instead of a blank `thinking` label.
2. As a user of a reasoning model, I want reasoning tokens rendered distinctly (dim +
   indented) from the eventual answer, so that I can tell thinking apart from the
   final response.
3. As a user of a reasoning model, I want the reasoning to appear within the assistant
   message (which sits above the input prompt), so that it does not overlap the prompt
   line or the status footer.
4. As a user of a reasoning model, I want the assistant message to grow with the
   stream but be scrolled by Pi-tui's viewport, so that the prompt line stays visible
   and reachable.
5. As a user mid-turn, I want to press ESC and have the turn actually stop, so that I
   am not stuck watching an unwanted generation.
6. As a user who pressed ESC, I want the turn to end immediately rather than silently
   retry and re-enter `thinking`, so that cancellation is trustworthy.
7. As a user whose turn completes normally, I want the final answer shown once via the
   existing `assistant_message` path, so that reasoning is not printed twice (live
   preview + whole text).
8. As a user whose turn is interrupted by ESC, I want the message to show its final /
   interrupted state (no separate live preview to clear), so that no half-rendered
   residue lingers in the UI.
9. As a user whose turn fails or is truncated, I want the message to show its final
   state and the final answer owned by the phase event, so that the UI stays
   consistent.
10. As a user running SigPi in one-shot / non-TTY mode (compact, clear, quiet), I want
    the normal answer printed whole as today, so that my piped output is unchanged and
    not spammed by per-frame deltas.
11. As a user whose one-shot turn is truncated (`finish_reason: "length"`), I want the
    reasoning accumulated so far printed as diagnostic output, so that I can see what
    the model was thinking when it hit the cap.
12. As a user watching tool calls execute, I want each tool result rendered into the
    transcript as a component in the same `chatContainer`, so that the transcript is a
    single coherent scrollback rather than a mix of component output and console text.
13. As a user whose context is compacted mid-session, I want the compaction recorded as
    a transcript component (not a raw console line), so that the component tree stays
    internally consistent.
14. As a user typing while a turn is running, I want my input accepted into a visible
    pending area and consumed at the next idle prompt (only ESC interrupts), so that I
    can pre-type a follow-up without disrupting the running turn.
15. As a user resuming a session, I want the live transcript rebuilt as a component tree
    from the persisted entry stream, so that the persisted conversation and the live
    view stay consistent (session persistence is unaffected — the transcript is stored
    via the entry-stream serializer and the `TUI` is just a view of it).
16. As a developer, I want the `onDelta` payload to carry both
    `{reasoningDelta, contentDelta}` from day one, so that adding content streaming
    later needs no transport/runner change.
17. As a developer, I want `model_delta` to be a single event type carrying both
    deltas, so that the runner and the render layer handle one switch branch per frame.
18. As a developer, I want tool-call phase events (`tool_calls_received`,
    `tool_execution_*`) untouched and never overlapping with in-flight `model_delta`
    frames, so that the render-only and persistence-only signal families stay
    decoupled.
19. As a developer, I want the agent-turn control flow unchanged (still `await` the
    full response before tool calls / compaction), so that streaming render is a pure
    display-layer addition.
20. As a developer, I want the render layer expressed as a single `ReplView` interface
    with two implementations — the persistent Pi-tui renderer and a console fallback —
    so that the REPL loop has one control flow for TTY and non-TTY paths.
21. As a developer, I want no raw `console.log` executed while the Pi-tui `TUI` is
    alive, so that the viewport never desyncs and the duplicate-frame bug cannot
    recur.
22. As a user on a model that streams thinking forever and is never ESC'd, I accept that
    the idle/stall timeout will not trip (deferred enhancement), because the total
    request timeout (ADR 0024) closes the reasoning-forever gap and live rendering +
    working ESC remove the "mysterious stall" symptom.

## Implementation Decisions

- **WireFormatAdapter / chat-completions adapter**: `foldChunk` reads
  `delta.reasoning_content` / `delta.reasoning` into running adapter state; a
  partial-view accessor returns the incremental `{reasoningDelta, contentDelta}` since
  the last call. The responses adapter is unaffected (no reasoning field today) but
  should expose the same partial-view shape for symmetry.
- **Model transport**: the generate / perform-request / stream-read path accepts an
  `onDelta` callback. After each adapter accumulation the transport invokes
  `onDelta(adapter.getPartialView())`. Non-streaming paths pass no delta (no-op). The
  existing idle/stall timer behavior is preserved unchanged.
- **Interrupt vs retry**: in the transport catch, when the error is an abort and the
  abort signal is marked aborted, throw the interrupt error directly (using the
  signal's reason when it is an interrupt error, otherwise a fresh interrupt error).
  Do **not** classify it as a retryable network error, and do **not** let the retry
  path re-issue the request. This is the bug fix for ESC-appears-to-do-nothing.
- **Runner**: forwards `onDelta` into generation; translates each partial view into a
  new `model_delta` `TurnProgressEvent` carrying `{reasoningDelta, contentDelta}`. The
  runner still `await`s the full response before tool calls / compaction — no
  control-flow change.
- **Types**: add the `model_delta` `TurnProgressEvent` variant (render-only) and the
  `onDelta` callback type. Phase events (`assistant_message`, `tool_calls_received`,
  `tool_execution_*`, `turn_interrupted`, `turn_failed`) are unchanged and remain
  persistence/logging-only.
- **Render layer (ADR 0025 A1)**: a single persistent Pi-tui `TUI` spans the whole
  session. The transcript is a `chatContainer` of per-message components (user /
  assistant / tool-result / compaction); the streaming assistant message component
  renders reasoning (thinking block) and content live, in place, from `model_delta`.
  The status bar is a footer child; the input editor and a queueable pending area are
  persistent children. There is no separate reasoning-stream component. All live
  output is a component — never raw `console.log` while the `TUI` is alive (that
  desyncs Pi-tui's viewport and is the bug ADR 0025 fixes).
- **ReplView interface**: one interface abstracting the two output surfaces (persistent
  Pi-tui renderer, console fallback). The REPL loop is written against this interface
  so TTY and non-TTY share one control flow; the loop does not branch on TTY.
- **Non-TTY / one-shot renderers** (compact, clear, quiet): `model_delta` is silently
  dropped in the console renderers. On a failed / truncated turn, the reasoning
  accumulated so far is printed as diagnostic output. The final answer still prints
  whole via `assistant_message`.
- **Event division (hard rule)**: `model_delta` is render-only; phase events are
  persistence/logging-only. The two families are orthogonal and never overlap (tool-call
  events fire only after generation returns the full response).
- **Deferred (out of scope)**: improving the `truncated` error message to distinguish
  "request cap hit" (SigPi's clamp) from "model cap hit" (provider's own max output).
  The separate reasoning-phase timeout originally listed is **resolved by ADR 0024** —
  the total request timeout closes the reasoning-forever gap without a per-phase timer.

## Testing Decisions

- **Test external behavior, not implementation.** Assert on emitted
  `TurnProgressEvent`s, rendered frame lines, and transport outcomes — not on internal
  adapter bookkeeping.
- **Seam 1 — data path (highest seam): the model-streaming test suite.** Reuse its
  existing SSE / JSON response helpers. Cover: the adapter captures
  `delta.reasoning_content`; `onDelta` fires once per SSE frame with
  `{reasoningDelta, contentDelta}`; the runner emits `model_delta`; an abort (abort
  error + aborted signal) throws the interrupt error and is **not** retried. Prior art:
  the adapter-parse tests and the model-streaming tests already exercise these modules.
- **Seam 2 — REPL render: the TUI test suite and the chat-input test suite.** Cover the
  persistent `TUI` component tree: the transcript is a `chatContainer` of per-message
  components; the streaming assistant message renders reasoning (thinking) + content
  live from `model_delta`; no separate reasoning-stream component exists; `model_delta`
  is render-only and is never mixed with `console.log` while the `TUI` is alive; no
  duplicate prompt component. Prior art: those suites already render `Tui` frames.
- **Seam 3 — non-TTY / one-shot: the CLI progress-reporter tests.** Cover: `model_delta`
  dropped in console renderers; on a failed / truncated turn the accumulated reasoning
  prints as diagnostic output. Prior art: existing CLI progress-reporter tests.
- Three seams on existing suites; no new test files invented. The data path and the two
  render surfaces (component tree vs stdout) are genuinely separate modules, so a single
  collapsed integration seam would be slower and more brittle.

## Out of Scope

- A separate **reasoning-phase timeout** / "semantic silence" refinement of the
  idle/stall timeout. **Resolved by ADR 0024**: the total request timeout bounds the
  whole request and catches reasoning-forever, so the per-phase timer is unnecessary and
  the idle reset rule is unchanged.
- Changing the **idle/stall timeout** mechanics (byte-reset behavior unchanged).
- Improving the **`truncated`** error message to distinguish request-cap vs model-cap
  hits.
- Changes to the **responses adapter** reasoning handling (no reasoning field today;
  only the partial-view shape is aligned).
- Retaining the README's "transcript is plain stdout / terminal scrollback" invariant —
  **abandoned by ADR 0025 A1**: old turns are no longer in the OS scrollback under TTY;
  they live in the component tree. Non-TTY parity holds.

## Further Notes

- This spec encodes the accepted decisions of ADR 0020 for the transport / interrupt /
  event-division layers; the **UI shape** was revised by ADR 0025 (fully Pi-tui render
  layer, A1 persistent `TUI`, reasoning inside the assistant message, transcript as a
  component tree). It is the implementation brief for those ADRs, not a re-opening of
  those decisions.
- The `max_tokens` truncation the user hit is a *model* output-cap limit, not the
  configured request cap; the misleading "increase max_tokens" advice is tracked as a
  deferred item, not fixed here.
- Glossary terms used: reasoning token, content token, streaming render, idle/stall
  timeout, total request timeout, interrupt vs retry, TurnProgressEvent, WireFormatAdapter,
  chat-completions adapter, model transport, Tui, model_delta, status bar, chat input,
  session, compaction, entry-stream serializer, process output mode.

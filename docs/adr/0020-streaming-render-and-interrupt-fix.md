# 0020 — Streaming render of reasoning/content + interrupt-not-retry

- **Status**: Accepted
- **Date**: 2026-07-14
- **Commit**: `—` (pending implementation)

## Context and Problem

Using a reasoning model over chat-completions (e.g. `tencent/hy3:free` via
OpenRouter) surfaced three coupled symptoms in one turn:

1. **Blank "thinking" phase.** The model streams its chain-of-thought in a
   separate delta field (`reasoning_content` / `reasoning`), but
   `ChatCompletionsAdapter.foldChunk` only reads `delta.content` and
   `delta.tool_calls`. The reasoning tokens are dropped, so the UI shows only a
   `thinking` label with no text — the user cannot tell whether the model is
   working or hung.
2. **No visible progress, no timeout, ESC does nothing.** The transport's
   idle/stall timer (`transport.ts`) resets on *every received byte*, including
   reasoning bytes, so a model that streams thinking indefinitely never trips
   the idle timer. ESC aborts the in-flight `fetch`, but undici surfaces the
   abort as its own `AbortError` DOMException and does **not** re-throw
   `signal.reason` (`TurnInterruptedError`); the transport catch then
   classifies it as `aborted` / `network_error`, `isRetryableRequestError`
   returns true, and the retry loop re-issues the request — the turn re-enters
   `thinking`, so ESC appears to "do nothing".
3. **Late truncation surprise.** When the model finally emits content it hits
   its real output ceiling (well below the configured `max_tokens = 100000`)
   and returns `finish_reason: "length"`; the transport throws `truncated` and
   the partial answer is intentionally not saved. The surfaced advice
   ("increase max_tokens") is misleading because the binding constraint is the
   model's own output cap, not the configured request cap.

The first two are the actionable root causes for the "stuck in thinking" report
and are addressed here. The truncation advice is noted as a follow-up (see
Consequences).

## Considered Options

For **what to render**:

1. **Render both reasoning and content deltas through one `onDelta` chain, UI
   v1 renders only reasoning** (adopted). The `onDelta` payload carries
   `{reasoningDelta, contentDelta}` from day one so adding content streaming
   later needs no transport/runner change.
2. Render only reasoning (interface carries reasoning alone): smaller surface
   but locks the interface; content streaming would later require re-plumbing
   transport/runner. Rejected.
3. Render only content: does nothing for the hy3 thinking-blank symptom.
   Rejected.

For **the progress event shape**:

1. **One `model_delta` event carrying both deltas** (adopted). Matches the
   single `onDelta` payload; the TUI handles one switch branch per frame; the
   UI decides which delta to render (v1: reasoning only).
2. Split `model_reasoning` / `model_content` into two events: cleaner
   semantics but forces "one frame → two events" or non-empty branching in the
   runner. Rejected as needless complexity for a high-frequency signal.

For **event division**:

1. **`model_delta` is render-only; existing phase events
   (`assistant_message`, `tool_calls_received`, `tool_execution_*`) stay
   persistence/logging-only and untouched** (adopted). Tool-call events fire
   only after `generate()` returns the full `ModelResponse`, so they never
   overlap with in-flight `model_delta` frames. The two signal families are
   orthogonal and decoupled.

For **the idle/stall timeout**:

1. **Leave the idle timer as-is; do not add a separate `reasoning_timeout`
   timer** (adopted). Once reasoning is rendered live and ESC truly cancels
   (below), a live-but-slow stream is *visible* and *manually cancellable*, so
   the "mysterious stall" symptom is gone. The residual gap — a model that
   streams thinking forever and is never ESC'd — is accepted as a deferred
   enhancement, not a required fix. The idle timer's job stays "catch dead
   streams", not "bound thinking duration".
2. Add a fixed-deadline thinking timer reusing `timeout_ms`, cleared on first
   `content` delta, reporting `reasoning_timeout`: would close the residual
   gap, but is unnecessary once rendering + interrupt are fixed and would add
   a second timer to reason about. Deferred.

For **interrupt vs retry**:

1. **Detect `AbortError` + `request.abortSignal?.aborted` in the transport
   catch and throw the interrupt error directly (no retry)** (adopted). The
   transport must not rely on `signal.reason` being re-thrown by undici; it
   must recognize the abort from the signal state and treat it as a terminal
   cancellation.
2. Leave as-is: ESC aborts then retries, making cancellation appear to fail.
   Rejected — this is the reported bug.

For **UI shape (REPL)**:

1. **A dedicated `ReasoningStreamComponent` is a `Tui` child placed *above* the
   prompt and *below* the bottom status bar** (adopted). The status bar is the
   fixed footer; the reasoning area must never sit below it. It is dim-colored
   and left-indented to distinguish reasoning from the later answer text
   (reserving that visual distinction for the content-streaming phase).
2. **Elastic height capped at ~70% of the content area; overflow scrolls
   internally** (adopted). The prompt line stays visible and ESC stays
   reachable. Fixed-ratio and fully-elastic (prompt pushed to the bottom) were
   rejected as either wasting space or hiding the input.
3. **Live-preview lifecycle: the component is cleared on `model_request_finished`
   / `assistant_message` (normal), `turn_interrupted` (ESC), and `turn_failed` /
   `truncated` (failure), and stops updating** (adopted). The final whole-text
   display is owned by `assistant_message` (persistence/logging event), so the
   reasoning is never shown twice and no half-rendered residue lingers on
   interrupt/truncation. Keeping the live component as the final display, or
   printing reasoning both live and whole, were rejected as double-printing /
   breaking the event-division decision.

For **UI shape (non-TTY / one-shot)**:

1. **`model_delta` is silently dropped in `console.log` renderers
   (compact/clear/quiet); the final answer prints whole via `assistant_message`**
   (adopted). Per-frame `console.log` would spam and is meaningless when piped.
   Exception: on a *failed/truncated* turn the reasoning accumulated so far is
   printed as diagnostic output — in the `finish_reason: "length"` case the user
   most needs to see what the model was thinking. Printing reasoning every frame
   (rejected) spams; always printing a folded reasoning block on success (deferred)
   is unnecessary since `assistant_message` already carries it.

## Decision

Seven coupled decisions, all in service of "a reasoning model's turn is visible
and cancellable":

1. **Reasoning tokens are captured.** `ChatCompletionsAdapter.foldChunk` reads
   `delta.reasoning_content` / `delta.reasoning` into running adapter state,
   exposed via a partial-view accessor used by the delta chain.
2. **Streaming render via one `onDelta` chain.** `generate` → `performRequest`
   → `readSseStream` accept an `onDelta` callback; after each `accumulate` the
   transport emits the adapter's partial view `{reasoningDelta, contentDelta}`.
   The runner forwards it as a new `model_delta` `TurnProgressEvent`. Rendering
   is display-only and does **not** change the agent-turn control flow (still
   `await` the full `ModelResponse` before tool calls / compaction).
3. **Event division.** `model_delta` drives the live text panel only; existing
   phase events remain persistence/logging-only and are untouched.
4. **Interrupt is terminal, not retryable.** The transport catch recognizes an
   aborted `request.abortSignal` and throws the interrupt error (not
   `aborted`/`network_error`), so ESC cancels the turn immediately instead of
   triggering a retry.
5. **REPL reasoning area.** A `ReasoningStreamComponent` is a `Tui` child above
   the prompt and below the status bar; dim + indented; elastic height capped at
   ~70% of content with internal scroll so the prompt stays visible.
6. **Live-preview lifecycle.** The component is cleared and stops updating on
   completion / interrupt / failure; `assistant_message` owns the final display,
   so no double-print and no residue.
7. **Non-TTY modes drop `model_delta`** except as diagnostic output on a failed /
   truncated turn.

The idle/stall timeout is intentionally **not** changed in this pass.

## Consequences

- **Fixes the reported symptoms**: the thinking phase is now visible (no blank
  `thinking` label) and ESC actually cancels the turn (no silent retry).
- **Interface is future-proof**: `{reasoningDelta, contentDelta}` from day one
  means content streaming is a UI-only addition later.
- **Control flow unchanged**: the agent loop still awaits a complete response;
  streaming render is a pure display-layer addition, so tool-calling and
  compaction logic are untouched.
- **Deliberate trade-off (accepted)**: a model that streams thinking forever
  and is never ESC'd will still not trip the idle timer. Mitigated by live
  rendering + working ESC, not by an automatic thinking timeout.
- **Follow-up (not in this ADR)**: the `truncated` error's advice ("increase
  max_tokens") is misleading when the model's own output cap is the binding
  constraint; a separate change should distinguish "request cap hit" from
  "model cap hit" in the message. Tracked as a deferred item.
- **Test coverage**: add tests for (a) adapter captures reasoning deltas,
  (b) `onDelta` fires per frame with both deltas, (c) aborted signal throws
  interrupt error and is not retried, (d) `model_delta` event shape.

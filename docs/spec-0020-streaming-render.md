# Spec: Streaming render of reasoning tokens + interrupt-not-retry

> Synthesized from the `/grill-with-docs` session and ADR 0020. Uses the
> `CONTEXT.md` glossary. Respects ADR 0020 (decisions below are accepted, not
> open questions).

## Problem Statement

When a user runs SigPi against a reasoning model over the chat-completions wire
format (for example `tencent/hy3:free` via OpenRouter), the turn appears to
hang:

- The model streams its chain-of-thought as **reasoning tokens** in a separate
  delta field (`reasoning_content` / `reasoning`), but the
  `ChatCompletionsAdapter` only reads `delta.content` and `delta.tool_calls`, so
  the reasoning is dropped. The UI shows only a `thinking` status-bar label with
  no text — the user cannot tell whether the model is working or dead.
- The **idle/stall timeout** resets on *every received byte*, including
  reasoning bytes, so a model that streams thinking indefinitely never trips the
  timer. There is no timeout prompt.
- Pressing **ESC** aborts the in-flight `fetch`, but undici surfaces the abort
  as its own `AbortError` DOMException and does not re-throw `signal.reason`
  (`TurnInterruptedError`). The `ModelTransport` catch classifies it as
  `aborted` / `network_error`, `isRetryableRequestError` returns true, and the
  retry loop re-issues the request — the turn re-enters `thinking`, so ESC
  appears to "do nothing".
- When the model finally emits content it hits its real output ceiling (well
  below the configured `max_tokens`) and returns `finish_reason: "length"`; the
  transport throws `truncated` and the partial answer is not saved. The surfaced
  advice ("increase max_tokens") is misleading because the binding constraint is
  the model's own output cap, not the configured request cap.

The user's actual experience: "stuck in thinking, no result, no timeout, ESC
can't cancel."

## Solution

Make a reasoning model's turn **visible and cancellable**:

1. **Capture reasoning tokens.** The `ChatCompletionsAdapter` reads
   `delta.reasoning_content` / `delta.reasoning` into running adapter state,
   exposed via a partial-view accessor.
2. **Stream render via one `onDelta` chain.** `generate` → `performRequest` →
   `readSseStream` accept an `onDelta` callback; after each `accumulate` the
   transport emits the adapter's partial view `{reasoningDelta, contentDelta}`.
   The runner forwards it as a new `model_delta` `TurnProgressEvent`. Rendering
   is display-only and does **not** change the agent-turn control flow (still
   `await` the full `ModelResponse` before tool calls / compaction).
3. **Event division.** `model_delta` drives the live text panel only; existing
   phase events (`assistant_message`, `tool_calls_received`, `tool_execution_*`)
   remain persistence/logging-only and are untouched.
4. **Interrupt is terminal, not retryable.** The transport catch recognizes an
   aborted `request.abortSignal` and throws the interrupt error (not
   `aborted`/`network_error`), so ESC cancels the turn immediately instead of
   triggering a retry.
5. **REPL reasoning area.** A `ReasoningStreamComponent` is a `Tui` child
   placed *above* the prompt and *below* the bottom status bar; dim-colored and
   left-indented; elastic height capped at ~70% of the content area with
   internal scroll so the prompt stays visible and ESC stays reachable.
6. **Live-preview lifecycle.** The component is cleared and stops updating on
   completion / interrupt / failure; `assistant_message` owns the final display,
   so no double-print and no residue.
7. **Non-TTY modes drop `model_delta`** except as diagnostic output on a failed /
   truncated turn.

The idle/stall timeout is intentionally **not** changed in this pass (see Out of
Scope).

## User Stories

1. As a user of a reasoning model, I want the model's thinking to appear live in
   the REPL, so that I can see the model is working instead of a blank
   `thinking` label.
2. As a user of a reasoning model, I want reasoning tokens rendered distinctly
   (dim + indented) from the eventual answer, so that I can tell thinking apart
   from the final response.
3. As a user of a reasoning model, I want the reasoning area to sit above the
   input prompt and below the status bar, so that it does not overlap the
   fixed footer or the prompt line.
4. As a user of a reasoning model, I want the reasoning area to grow with the
   stream but cap at ~70% of the content area and scroll internally, so that the
   prompt line stays visible and reachable.
5. As a user mid-turn, I want to press ESC and have the turn actually stop, so
   that I am not stuck watching an unwanted generation.
6. As a user who pressed ESC, I want the turn to end immediately rather than
   silently retry and re-enter `thinking`, so that cancellation is trustworthy.
7. As a user whose turn completes normally, I want the final answer shown once
   via the existing `assistant_message` path, so that reasoning is not printed
   twice (live preview + whole text).
8. As a user whose turn is interrupted by ESC, I want the live reasoning preview
   cleared, so that no half-rendered residue lingers in the UI.
9. As a user whose turn fails or is truncated, I want the live reasoning preview
   cleared and the final answer owned by the phase event, so that the UI stays
   consistent.
10. As a user running SigPi in one-shot / non-TTY mode (compact, clear, quiet),
    I want the normal answer printed whole as today, so that my piped output is
    unchanged and not spammed by per-frame deltas.
11. As a user whose one-shot turn is truncated (`finish_reason: "length"`), I
    want the reasoning accumulated so far printed as diagnostic output, so that I
    can see what the model was thinking when it hit the cap.
12. As a developer, I want the `onDelta` payload to carry both
    `{reasoningDelta, contentDelta}` from day one, so that adding content
    streaming later needs no transport/runner change.
13. As a developer, I want `model_delta` to be a single event type carrying both
    deltas, so that the runner and TUI handle one switch branch per frame.
14. As a developer, I want tool-call phase events (`tool_calls_received`,
    `tool_execution_*`) untouched and never overlapping with in-flight
    `model_delta` frames, so that the render-only and persistence-only signal
    families stay decoupled.
15. As a developer, I want the agent-turn control flow unchanged (still
    `await` the full `ModelResponse` before tool calls / compaction), so that
    streaming render is a pure display-layer addition.
16. As a user on a model that streams thinking forever and is never ESC'd, I
    accept that the idle/stall timeout will not trip (deferred enhancement),
    because with live rendering + working ESC the "mysterious stall" symptom is
    gone.

## Implementation Decisions

- **WireFormatAdapter / ChatCompletionsAdapter**: `foldChunk` reads
  `delta.reasoning_content` / `delta.reasoning` into running adapter state; a
  partial-view accessor returns the incremental `{reasoningDelta, contentDelta}`
  since the last call. The `ResponsesAdapter` is unaffected (it has no reasoning
  field today) but should expose the same partial-view shape for symmetry.
- **ModelTransport**: `generate` / `performRequest` / `readSseStream` accept an
  `onDelta` callback. After each `adapter.accumulate(frame)` the transport
  invokes `onDelta(adapter.getPartialView())`. Non-streaming paths pass no
  delta (no-op). The existing idle/stall timer behavior is preserved unchanged.
- **Interrupt vs retry**: in the transport catch, when the error is an
  `AbortError` (DOMException) **and** `request.abortSignal?.aborted` is true,
  throw the interrupt error directly (using `signal.reason` when it is a
  `TurnInterruptedError`, otherwise a fresh interrupt error). Do **not** classify
  it as `aborted` / `network_error`, and do **not** let `isRetryableRequestError`
  retry it. This is the bug fix for ESC-appears-to-do-nothing.
- **Runner**: forwards `onDelta` into `generate`; translates each partial view
  into a new `model_delta` `TurnProgressEvent` carrying
  `{reasoningDelta, contentDelta}`. The runner still `await`s the full
  `ModelResponse` before tool calls / compaction — no control-flow change.
- **types.ts**: add the `model_delta` `TurnProgressEvent` variant (render-only)
  and the `onDelta` callback type. Phase events (`assistant_message`,
  `tool_calls_received`, `tool_execution_*`, `turn_interrupted`, `turn_failed`)
  are unchanged and remain persistence/logging-only.
- **Tui / ReasoningStreamComponent**: a new component added as a `Tui` child
  *above* the prompt and *below* the bottom status bar. It renders dim-colored,
  left-indented text, elastic height capped at ~70% of the content area with
  internal scroll. It subscribes to `model_delta` and appends
  `reasoningDelta`. On `model_request_finished` / `assistant_message` /
  `turn_interrupted` / `turn_failed` / `truncated` it clears and stops
  updating. The status bar remains the fixed footer.
- **Non-TTY / one-shot renderers** (compact, clear, quiet): `model_delta` is
  silently dropped in the `console.log`-based renderers. On a failed/truncated
  turn, the reasoning accumulated so far is printed as diagnostic output. The
  final answer still prints whole via `assistant_message`.
- **Event division (hard rule)**: `model_delta` is render-only; phase events are
  persistence/logging-only. The two families are orthogonal and never overlap
  (tool-call events fire only after `generate()` returns the full response).
- **Deferred (out of scope)**: a separate `reasoning_timeout` timer; improving
  the `truncated` error message to distinguish "request cap hit" from "model cap
  hit".

## Testing Decisions

- **Test external behavior, not implementation.** Assert on emitted
  `TurnProgressEvent`s, rendered frame lines, and transport outcomes — not on
  internal adapter bookkeeping.
- **Seam 1 — data path (highest seam): `test/model-streaming.test.ts`.**
  Reuse its existing `sseResponse` / `jsonResponse` helpers. Cover: adapter
  captures `delta.reasoning_content`; `onDelta` fires once per SSE frame with
  `{reasoningDelta, contentDelta}`; runner emits `model_delta`; abort
  (`AbortError` + `aborted` signal) throws the interrupt error and is **not**
  retried. Prior art: `test/chat-completions-adapter.test.ts` (adapter parse) and
  `test/model-streaming.test.ts` (SSE + retry) already exercise these modules.
- **Seam 2 — REPL render: `test/tui.test.ts` + `test/chat-input.test.ts`.**
  Cover: `ReasoningStreamComponent` is a `Tui` child above the prompt / below
  the status bar, dim + indented, height capped ~70% with internal scroll;
  live-preview lifecycle clears on `model_request_finished` /
  `assistant_message` / `turn_interrupted` / `turn_failed` / `truncated` and
  stops updating. Prior art: `test/tui.test.ts` and `test/chat-input.test.ts`
  already render `Tui` frames and the running-turn component.
- **Seam 3 — non-TTY / one-shot: `test/cli-init.test.ts`** (or a focused
  addition to the progress-reporter tests). Cover: `model_delta` dropped in
  `console.log` renderers; on failed/truncated turn the accumulated reasoning
  prints as diagnostic output. Prior art: existing CLI progress-reporter tests.
- Three seams on existing files; no new test files invented. The data path and
  the two render surfaces (TUI vs stdout) are genuinely separate modules, so a
  single collapsed integration seam would be slower and more brittle.

## Out of Scope

- Adding **content streaming** to the UI (the `onDelta` interface already
  carries `contentDelta`; rendering it is a later, UI-only phase).
- A separate **`reasoning_timeout`** timer / "semantic silence" refinement of
  the idle/stall timeout. Accepted as a deferred enhancement because live
  rendering + working ESC remove the "mysterious stall" symptom.
- Changing the **idle/stall timeout** mechanics (byte-reset behavior unchanged).
- Improving the **`truncated`** error message to distinguish request-cap vs
  model-cap hits.
- Changes to the **ResponsesAdapter** reasoning handling (no reasoning field
  today; only the partial-view shape is aligned).

## Further Notes

- This spec encodes the accepted decisions of ADR 0020; it is the implementation
  brief for that ADR, not a re-opening of those decisions.
- The `max_tokens` truncation the user hit is a *model* output-cap limit, not the
  configured request cap; the misleading "increase max_tokens" advice is tracked
  as a deferred item, not fixed here.
- Glossary terms used: reasoning token, content token, streaming render,
  idle/stall timeout, interrupt vs retry, TurnProgressEvent, WireFormatAdapter,
  ChatCompletionsAdapter, ModelTransport, Tui, ReasoningStreamComponent,
  model_delta.

# Spec: Model transport adopts OpenAI SDK; total + idle timeouts; max_tokens clamp

> Synthesized from the `/grill-with-docs` session and ADR 0024. Uses the
> `CONTEXT.md` glossary. Respects ADR 0024 (decisions below are accepted, not
> open questions). Supersedes ADR 0005 (its rejection of a second/connect timer)
> and ADR 0020 (its accepted reasoning-forever gap + deferred
> `reasoning_timeout`). ADR 0021 (`reserveTokens` compaction budget) stands.

## Problem Statement

When a user runs SigPi against a reasoning model over the openai-compatible
wire format (for example `tencent/hy3:free` via OpenRouter, or a local
vLLM), the turn appears to hang or waste minutes:

- **Completely freezes.** A model that streams thinking indefinitely but never
  emits content keeps the idle/stall timeout's reset rule happy (it resets
  on *every* byte, including reasoning bytes), so the turn hangs until the
  user kills it. This is the ADR 0020 accepted gap.
- **Runs >10 minutes then says "max_tokens".** `max_tokens` is sent
  raw and unclamped (e.g. `100000`). The model generates a huge
  answer (or the provider caps it), then returns `finish_reason: "length"`
  and the turn truncates — after many minutes of wasted generation.
- **Partially hangs / times out.** A dead server or mid-stream stall is
  eventually caught by the idle/stall timer, but only after a long silence
  budget.

Differential diagnosis against **Pi** (same model, never hangs) pinned the
cause on **SigPi's side**, not the model:

- Pi delegates fetch + SSE + retry + timeout to the **OpenAI SDK**, whose
  `timeout` is a **total** request deadline (fetch → stream end, not
  reset on bytes). A reasoning-forever model is killed at `timeout_ms`
  total — no infinite freeze.
- Pi **clamps `max_tokens`** to `contextWindow − estimatedInput − 4096`,
  so it never asks a model for more output than fits the remaining context.
- SigPi hand-rolls the transport with an idle-only timer (resets on every
  byte) and sends `max_tokens` unclamped.

So the symptom is request shaping + timeout semantics, not a missing log line.
The fix is to adopt the SDK substrate Pi uses and apply the two request
guards Pi applies — not to add observability on top of a working request.

## Solution

Make the openai-compatible `Model transport` delegate fetch + SSE + retry
+ timeout to the **OpenAI SDK**, while keeping SigPi's schema-translation
layer and its agent-loop contracts intact:

1. **Adopt the SDK as the communication substrate.** The SDK owns HTTP,
   SSE framing, per-call body reading, and the **total request timeout**.
   SigPi keeps the `Wire format adapter` for schema translation
   (request → SDK params; SDK chunk → `ModelDelta`/`ModelResponse`).
2. **Add a total request timeout beside the idle/stall timeout.** The SDK's
   `timeout: timeout_ms` bounds the whole request (fetch → stream end) and
   catches reasoning-forever; the kept idle/stall timer still catches
   dead-server / mid-stream silence. Both merge into one abort signal. This
   closes the ADR 0020 gap without a separate reasoning-phase timer and
   without changing the idle reset rule.
3. **Clamp `max_tokens` to the context window.** Before each request, cap
   output at `min(req.maxTokens, contextWindow − estimatedInputTokens − 4096)`.
   This prevents the oversized-generation truncation (`finish_reason: "length"`).
   `reserveTokens` is deliberately *not* used here — it stays the ADR 0021
   compaction headroom.
4. **Preserve every agent-loop contract.** The full `RequestFailureKind`
   taxonomy, the `isRetryableRequestError` retry/backoff loop, and the
   ESC-interrupt-not-retry rule all survive, via an SDK-error →
   `ModelRequestError` mapping that re-throws `TurnInterruptedError` on
   user-abort and captures `sdkErrorType` in `details` for observability.

## User Stories

1. As a SigPi user, I want a reasoning model that streams thinking
   forever to be cancelled by a total request timeout, so my turn doesn't hang
   indefinitely ("完全卡死").
2. As a SigPi user, I want the same model that works fast on Pi to also
   work on SigPi, so I don't have to switch tools for the same task.
3. As a SigPi user, I want a request that produces no content byte for
   `timeout_ms` to be aborted by the idle/stall timeout, so a dead server
   or mid-stream stall is caught without waiting forever.
4. As a SigPi user, I want a model that streams steadily but runs long in
   total to *not* be killed (preserving today's idle/stall behavior), so
   large legitimate responses survive.
5. As a SigPi user, I want SigPi to never send a `max_tokens` larger
   than the remaining context window, so the model doesn't generate a huge
   answer that then truncates at `finish_reason: "length"` after minutes.
6. As a SigPi user, I want a `max_tokens` I configured absurdly high
   (e.g. `100000`) to be silently clamped, so I can't shoot myself in
   the foot by accident.
7. As a SigPi user, I want the compaction headroom (`reserveTokens`) to
   stay untouched, so context budgeting and compaction behavior don't regress.
8. As a SigPi user, I want pressing ESC during a hung turn to cancel it
   immediately and never retry it, so ESC always works (preserving the
   interrupt-not-retry fix).
9. As a SigPi user, I want the agent loop's retry/backoff to behave
   exactly as before, so transient network/HTTP errors still retry with jitter
   and permanent errors don't.
10. As a SigPi user, I want every failure to keep its existing
    `failureType` classification (`timeout`, `network_error`, `http_error`,
    `truncated`, `stream_error`, `aborted`, `invalid_json`,
    `invalid_response`, `empty_response`) in logs, so my existing log-based
    troubleshooting still works.
11. As a SigPi user, I want the SDK's underlying error class name
    captured in the event `details` (e.g. `sdkErrorType`), so I can tell an
    `APIConnectionError` from an `APITimeoutError` at a glance.
12. As a SigPi user, I want `truncated` (`finish_reason` `length` /
    `content_filter`) to still be detected and surfaced as a non-retryable
    failure, so a partial answer is never silently persisted.
13. As a SigPi user, I want my configured proxy to keep working, so
    requests still route through my proxy when it is set.
14. As a SigPi user, I want the multi-schema translation layer (`Wire
    format adapter`) to stay, so a future non-OpenAI schema (e.g.
    Anthropic) can be added as a separate adapter behind the same `Model
    provider` seam.
15. As a SigPi user, I want the chat-completions and responses
    schemas to keep working, so my existing `api_format` choices are
    unaffected.
16. As a SigPi user, I want the `Model provider` seam to remain
    stable (consumers never name the concrete class), so runtime/turn code
    doesn't change.
17. As a SigPi user, I want a reasoning model that emits
    `reasoning_content` / `reasoning` to have that thinking captured and
    rendered live (preserving the streaming-render work), so I can see the
    model is actually working.
18. As a maintainer, I want the HTTP/SSE/retry/timeout substrate
    delegated to a battle-tested SDK rather than hand-rolled, so we stop
    re-debugging transport edge cases.
19. As a maintainer, I want a single `timeout_ms` to bound both silence and
    total duration, so there is no new config knob to explain.
20. As a maintainer, I want the `max_tokens` clamp to use a hardcoded
    `4096` margin (Pi-style) rather than `reserveTokens`, so the clamp and
    the compaction headroom stay independent concerns.
21. As a SigPi user, I want the existing `model_request_*` / `turn_*`
    log events to keep firing with the same fields, so my greps and
    dashboards still work.

## Implementation Decisions

- **Substrate:** the `Model transport` for the openai-compatible path is
  delegated to the OpenAI SDK. The SDK owns fetch, SSE framing,
  per-call body reading, and the total request timeout. SigPi owns the
  timeout *semantics* (total + idle merged into the abort signal) and the
  `max_tokens` clamp.
- **Adapter slimmed:** the `Wire format adapter` drops `buildUrl` /
  `toRequestBody` (the SDK builds the request) and gains `toParams(request)`
  (a SigPi `ModelRequest` → SDK call params: messages, tools,
  temperature, clamped `max_tokens`, stream flag). `accumulate` /
  `onDelta` / `finalize` stay as the SDK-chunk → `ModelDelta` /
  `ModelResponse` mappers. `finish_reason` detection (incl. `length` /
  `content_filter` → `truncated`) stays adapter-side.
- **Seam preserved:** the `Model provider` seam and the chat-completions /
  responses polymorphism are unchanged; a future non-openai schema
  (Anthropic) is a *separate* adapter over a *different* SDK client,
  behind the same seam — not an extension of this one.
- **Timeout layering:** SDK `timeout: timeout_ms` (total, fetch → stream
  end, not reset on bytes) + the kept idle/stall timer (`timeout_ms`,
  resets on every byte). Both merge into one abort signal passed to the
  SDK call. The total timeout closes the reasoning-forever gap the
  idle-only design left open.
- **max_tokens clamp:** before each request, cap output at
  `min(req.maxTokens, contextWindow − estimatedInputTokens − 4096)`,
  floored at `1`. The `4096` margin is hardcoded (Pi-style);
  `reserveTokens` is *not* used here — it stays the ADR 0021 compaction
  headroom. When `max_tokens` is unset, behavior is unchanged (the
  model decides); the clamp only lowers an over-large explicit config.
- **Error mapping (preserve taxonomy):** map SDK error types →
  `ModelRequestError` + `RequestFailureKind` so the agent loop is
  unchanged — `APITimeoutError` → `timeout`; `APIConnectionError` →
  `network_error` / `stream_error`; status-bearing `APIError` →
  `http_error` (+ `httpStatus`); `APIUserAbortError` → `aborted`.
  `truncated` stays adapter-side (`finish_reason`). Capture `sdkErrorType`
  in `details` for observability. The `isRetryableRequestError`
  retry/backoff loop is untouched.
- **Interrupt vs retry preserved:** on user-abort, inspect the abort
  signal's reason and re-throw `TurnInterruptedError` (never classify as
  retryable). The ESC-cancels-turn fix stays.
- **Proxy:** reuse the existing proxy `fetch` implementation (already
  undici-based) by passing it to the SDK client; the SDK's own retry is
  disabled (`maxRetries: 0`) so SigPi's own retry loop governs.
- **ADR impact:** supersedes ADR 0005 (its rejection of a second /
  connect timer) and ADR 0020 (its accepted reasoning-forever gap + the
  deferred `reasoning_timeout`). ADR 0021 (`reserveTokens` compaction
  budget) is untouched.

## Testing Decisions

- **One highest seam.** Drive the `Model provider` (openai-compatible)
  over a **local OpenAI-SDK-compatible SSE server** (reuse / extend the
  existing `openai-compatible` test server). Assert on emitted
  `TurnProgressEvent`s (`model_request_started` / `succeeded` / `failed`
  with `failureType`, `details.sdkErrorType`), the complete
  `ModelResponse` (assistant text, tool calls, `finishReason`, incl.
  `truncated` on `length`), the **captured outbound `max_tokens`** (must
  equal the clamp), and signal-driven outcomes:
  - reasoning-forever server (thinking streams, no content) → **total
    timeout** fires → `failureType: timeout`;
  - dead server (no first byte) → **idle/stall** timer fires;
  - user ESC → `TurnInterruptedError` is re-thrown and is **not** retried.
  This single seam exercises transport + timeout + clamp + adapter
  delta-mapping end-to-end.
- **No separate low seam needed.** The error-mapping table and clamp
  math are covered by the same seam via injected SDK-shaped failures and
  asserted outbound params. If a focused unit is wanted later, the
  `Wire format adapter`'s `toParams` / `finalize` can be asserted
  directly (prior art: `chat-completions-adapter` / `responses-adapter` /
  `model-streaming` tests).
- **Test external behavior, not implementation.** Assert on events,
  responses, outbound params, and outcome classes — not on internal SDK
  plumbing or adapter bookkeeping.
- **Prior art:** `openai-compatible` (local SSE server), `model-transport`,
  `model-streaming`, `chat-completions-adapter`, `responses-adapter`
  tests.

## Out of Scope

- Implementing a non-OpenAI schema (Anthropic) adapter — only the
  `Model provider` seam is kept open; the adapter is future work.
- Changing the `reserveTokens` / compaction budget (ADR 0021 stands).
- A separate per-phase `reasoning_timeout` timer — superseded by the
  total request timeout.
- A new `total_timeout_ms` config knob — `timeout_ms` is reused for
  both timers.
- Per-request token accounting (input estimate, output-before-
  truncation, compaction-fired flag) as an observability add-on — deferred;
  `details.sdkErrorType` + the existing `truncated` / `failureType` /
  `elapsedMs` logs already localize the failure.

## Further Notes

- Root cause of the user's symptoms was SigPi-side request shaping +
  timeout semantics, confirmed by differential diagnosis: the same model on
  Pi (OpenAI SDK + total timeout + max_tokens clamp) never hangs,
  while SigPi (idle-only timer + unclamped max_tokens) did.
- Trade-off accepted: a single `timeout_ms` now bounds *both* silence
  (idle) and total duration. A healthy-but-slow stream exceeding
  `timeout_ms` total is killed (the ADR 0005 concern), but the user
  controls `timeout_ms` per model and sets it large for slow models.

# 0024 — Model transport adopts OpenAI SDK; total + idle timeouts; max_tokens clamp

- **Status**: Accepted
- **Date**: 2026-07-16
- **Commit**: `—` (design decision from a `/grilling` session; implementation pending)

## Context and Problem

Users hit "the LLM stops responding mid-turn" on reasoning models (e.g. `tencent/hy3:free` via OpenRouter, local vLLM). The **same model on Pi (which uses the OpenAI SDK) is fast and never hangs** — a differential diagnosis that pins the cause on SigPi's side, not the model.

The gap is request shaping + timeout semantics:

- Pi (a) delegates fetch + SSE + retry + timeout to the OpenAI SDK with a **total** request timeout (`timeout: timeoutMs`, fetch→stream-end, not reset on bytes), and (b) clamps `max_tokens` to `contextWindow − estimatedInput − 4096`.
- SigPi hand-rolls `transport.ts` with an idle/stall timer (resets on *every* byte) and sends `max_tokens` **raw/unclamped**.

Two distinct failure modes fall out, both SigPi-side:

1. **"Completely freezes"** = reasoning-forever: the idle timer keeps resetting on reasoning bytes, so it never trips. This is the **ADR 0020 accepted gap**.
2. **"Runs >10 min then says max_tokens"** = oversized generation: `max_tokens` set absurdly high (e.g. `100000`) is sent unclamped; the model generates a huge answer (or the free provider caps it) → `finish_reason: "length"` truncation.

## Options Considered

1. **Keep hand-rolled transport + add a `reasoning_timeout` phase timer** (ADR 0020's deferred enhancement). Rejected: it adds a config knob ADR 0005 deliberately avoided, and re-introduces the ADR 0005 "kill large slow streams" problem if we drop the idle timer to make room for it.
2. **Adopt the OpenAI SDK as the communication substrate (Pi's approach), keep the `WireFormatAdapter` layer for multi-schema translation.** Adopted. The SDK owns fetch + SSE + retry + timeout; SigPi keeps the schema-translation seam, adds a total timeout beside the idle timer, clamps `max_tokens`, and preserves its error taxonomy.

Concretely, under option 2:

- **Slim `WireFormatAdapter`** (`src/model/wire-format.ts`): drop `buildUrl` / `toRequestBody` (the SDK builds the request); add `toParams(request)` (SigPi `ModelRequest` → SDK params); keep `accumulate` / `onDelta` / `finalize` as the chunk→`ModelDelta` / `ModelResponse` mappers. The `ModelProvider` seam and the chat-completions / responses polymorphism survive untouched. A future non-openai schema (e.g. Anthropic) is a *separate* adapter over a *different* SDK client, behind the same interface — not an extension of this one.
- **Timeout layering**: SDK `timeout: timeoutMs` (the **total** request deadline) + SigPi's **idle/stall timer** kept as-is (`= timeoutMs`, resets on every byte). Both merge into one abort signal. The total timeout catches reasoning-forever (closing the ADR 0020 gap); the idle timer still catches dead-server / mid-stream silence. No change to the idle reset rule, no separate reasoning-phase timer.
- **`max_tokens` clamp**: `min(req.maxTokens, contextWindow − estimatedInputTokens − 4096)` applied before the SDK call. The hardcoded `4096` margin is Pi-style; `reserveTokens` is **intentionally not** used here — it stays the ADR 0021 compaction headroom. Prevent the oversized-generation truncation.
- **Error mapping (preserve taxonomy)**: map SDK error types → SigPi `ModelRequestError` + `RequestFailureKind` so the runner's retry/backoff (`isRetryableRequestError`) is unchanged: `APITimeoutError`→`timeout`, `APIConnectionError`→`network_error`/`stream_error`, status-bearing `APIError`→`http_error` (+`httpStatus`), `APIUserAbortError`→`aborted`. `truncated` stays SigPi-side (adapter `finalize()` detects `finish_reason: "length"`/`content_filter`). The **interrupt-vs-timeout rule (ADR 0020 ESC fix)** survives: on user-abort we inspect the signal's `reason` and re-throw `TurnInterruptedError`, never retry it. Capture `sdkErrorType` in `details` for observability.
- **Proxy**: pass `fetch: getProxyStatus().fetchImpl` (SigPi's existing undici proxy fetch) to `new OpenAI(...)`. Reuse the one proxy implementation; zero new proxy code. `maxRetries: 0` so SigPi's own retry loop governs.

## Decision

Adopt the OpenAI SDK for the openai-compatible path; slim the adapter to `toParams` + chunk→delta mappers; add a **total request timeout** alongside the **idle/stall timer**; **clamp `max_tokens`**; preserve the full error taxonomy and the ESC-interrupt fix; reuse the existing proxy `fetchImpl`. Keep `reserveTokens` for compaction (ADR 0021 untouched).

## Consequences

- **Supersedes ADR 0005** (its rejection of a second / connect+timer split) and **ADR 0020** (its accepted reasoning-forever gap + deferred `reasoning_timeout`): the SDK total timeout *is* the second timer ADR 0005 rejected, and it closes the gap ADR 0020 left open — without a reasoning-phase timer and without altering the idle reset rule.
- **Fixes both reported symptoms at the root**: freeze (total timeout bounds reasoning-forever) and >10-min truncation (`max_tokens` clamp).
- **Adds the `openai` SDK dependency** (heavy) and assumes OpenAI-ish response shapes for the openai-compatible path — consistent with SigPi's existing adapter tolerance for endpoint quirks; Anthropic remains a future separate adapter over a different client.
- **Behavior preserved**: retry/backoff (`isRetryableRequestError`), ESC-interrupt (no retry), compaction budget (`reserveTokens`), and the `ModelProvider` seam.
- **Trade-off accepted**: a single `timeoutMs` now bounds *both* silence (idle) and total duration. A healthy-but-slow stream exceeding `timeoutMs` total is killed (the ADR 0005 concern) — but the user (sole current user) controls `timeoutMs` and sets it large for slow models, so this is acceptable.
- **Observability note**: the existing `model_request_*` / `turn_*` logs already capture `truncated` / `failureType` / `elapsedMs`; the added `sdkErrorType` detail plus the `max_tokens` clamp close the only real gap (per-request token accounting remains a cheap future add-on, not required by this fix).

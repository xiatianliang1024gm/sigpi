# 0005 — Idle/stall timeout replaces total-duration deadline

- **Status**: Accepted
- **Date**: 2026-07-12
- **Commit**: `37f7373`

## Context and Problem

Goal: mitigate "large responses time out easily". Currently `ModelTransport.performRequest` starts a `setTimeout` at the same instant `fetch` is issued and aborts the whole request on expiry; the timer covers "connect + wait for first byte + download the entire response body" wall-clock time, and after receiving the response, `response.text()` reads the whole body into memory at once before `parse`. So a response that "streams steadily but is huge in total, exceeding `timeoutMs`" gets killed by mistake — SSE itself does not change total wall-clock; only changing the timeout **semantics** fixes the root cause.

## Considered Options

1. **A single idle/stall timer, reusing `timeoutMs`, reset every frame** (adopted): starts on `fetch`, resets on every SSE frame received; aborts only after `timeoutMs` of consecutive no-byte silence. One timer covers both "dead server (never gets the first frame)" and "stream stalls mid-way".
2. Keep the total-duration deadline, just raise `timeoutMs`: treats the symptom not the cause; still taken down by a genuinely slow model / stall, and hides truly hung connections.
3. Split into a connect timeout + idle timeout as two independent budgets: more knobs, more config surface, currently unnecessary.

## Decision

Model-request timeouts become an **idle/stall timeout**: a single timer starts on `fetch` and resets on every SSE frame (or any body chunk) received; only `timeoutMs` of consecutive no-byte silence triggers `timeout` (`RequestFailureKind: "timeout"`), feeding the existing retry/backoff. Waiting for the first byte is also bound by the same budget, with **no regression** versus the old total deadline. No new timeout config item is added.

## Consequences

- **Fixes the goal**: steadily-streaming but huge-total responses are no longer killed by the total-duration deadline.
- **Loses the whole-turn total budget guardrail**: a pathological response that emits one byte only every `timeoutMs-1` ms will not trigger this timer; but the existing `maxRetries` + agent `maxSteps` still bound it, so it cannot hang forever.
- **Mid-stream silence timeout → retry**: consistent with today's timeout-retry behavior, it re-runs the inference (extra token/latency cost), bounded by the `maxRetries` limit.
- Transport stays format-agnostic: the idle timer only looks at "bytes or not", not frame contents.

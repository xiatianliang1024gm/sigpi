# 0007 — Both adapters do pure delta folding; `responses` does not rely on `response.completed`

- **Status**: Accepted
- **Date**: 2026-07-12
- **Commit**: `37f7373`

## Context and Problem

Under SSE each `data:` frame is only an incremental delta, yet both adapters' `parse(data)` still expects a complete response object (see `WireFormatAdapter`). `chat_completions` has only `delta` frames + `[DONE]`, no "complete event"; the `responses` API emits a typed event stream where `response.completed` usually carries the **complete output** directly. How to fold incremental frames back into a complete `ModelResponse` is a question both adapters must answer.

## Considered Options

1. **Both adapters do pure delta folding** (adopted): `chat_completions` folds `delta` (including concatenating `tool_calls[].function.arguments` fragments by `index`, distinguishing `finish_reason`); `responses` folds `response.output_item.delta` into the corresponding item / nested content-part. `response.completed` may naturally close out, but is **not** the sole source of assembly.
2. `responses` takes a shortcut: ignore increments, wait for `response.completed`'s complete payload and `parse` it directly into the final object: minimal accumulator. But this is **single-point fragile** — if that one completed event is dropped / truncated, or the provider does not faithfully resend the complete output, the whole turn fails. Rejected.

## Decision

Both adapters take the **pure delta folding** path: transport hands each `data:` frame to `adapter.accumulate(frame)`, and on stream end (receiving `[DONE]` or connection closed with ≥1 frame already seen) calls `adapter.finalize()` to get the complete `ModelResponse`. `responses` does not treat `response.completed` as the assembly source, only as one ordinary event that may complete the folding.

## Consequences

- **Consistent seam**: both adapters share the same "accumulate" mental model; transport still only does generic framing.
- **Robust**: when the provider drops / truncates `response.completed`, only a little less gets folded, not a whole-turn failure; degrades on missing events instead of crashing.
- **Cost**: `responses`' item / nested content-part delta folding is more complex, but tractable under the OpenAI spec.
- Prevents a future engineer from "simplifying" `responses` to depend on `response.completed` and reintroducing single-point fragility.

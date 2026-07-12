# 0006 — Streaming on unconditionally in transport + per-model `stream` opt-out + single-chunk JSON tolerance

- **Status**: Accepted
- **Date**: 2026-07-12
- **Commit**: `37f7373`

## Context and Problem

To get the incremental bytes idle timeout needs, transport must request `stream: true` and read the body incrementally. Both wire formats (`chat_completions`, `responses`) support SSE. But in reality some providers do not support streaming, in two classes:

- **Ignore-type**: receive `stream:true` but ignore it, returning a normal single-chunk JSON.
- **Reject-type**: strictly validate inputs and return an HTTP error on an unrecognized `stream` — this is unsolvable at the parser level and requires simply not putting `stream:true` in the request body.

## Considered Options

1. **per-model `stream` boolean (default `true`) + SSE parser tolerant of single-chunk JSON** (adopted): reject-type is handled by the `stream=false` opt-out; ignore-type is covered zero-config by the tolerant parser.
2. Zero config, transport always streams, parser tolerates single-chunk JSON: covers ignore-type but **cannot catch reject-type** (sending `stream:true` gets a 400 that parsing cannot rescue).
3. Runtime auto-detect: try streaming first, fall back to non-streaming on a 400: wastes one request and disrupts the existing retry/backoff semantics — rejected.

## Decision

- `ModelConfig` gains `stream: boolean` (default `true`), added to the single `CONFIG_ALIASES` alias table (`stream` ↔ `stream`), with env synced to `MODEL_STREAM` (continuing ADR-0002's discipline).
- `stream=true` (default): transport writes `stream:true` via the adapter's `toRequestBody` and reads framed as SSE.
- `stream=false`: transport **does not send** `stream:true` and reads directly as single-chunk JSON, fully taking the old path.
- The SSE framer is **always** tolerant of single-chunk JSON fallback (judged by `content-type`/body shape; if it is not a `data:` event stream, treat it as the single frame).

## Consequences

- **Zero change to existing config**: default `true`, so the universal timeout fix of goal A is unchanged.
- **Reject-type providers** opt in with `stream=false`; **ignore-type** need zero config.
- The single alias table remains the sole source, not breaking ADR-0002.
- Cost: one more field than "zero config", but forced out by real provider constraints, and default-on does not affect existing setups.

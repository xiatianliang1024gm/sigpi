# 6. Model Adapters (advanced)

The agent loop calls `provider.generate(...)`. This chapter opens that seam: how SigPi talks HTTP
to an OpenAI-compatible model **and** supports two wire formats without forking the code.

## The provider seam

`ModelProvider` (`src/types.ts`) is one method:

```ts
interface ModelProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}
```

Everything the loop needs is behind this interface. Swapping providers (or mocking them in tests)
means swapping one object. `OpenAICompatibleProvider` is the concrete implementation.

## A thin composer

`src/model/openai-compatible.ts`:

```ts
generate(request, makeAdapter) {
  return this.transport.generate(request, () =>
    this.config.apiFormat === "responses"
      ? new ResponsesAdapter(this.config)
      : new ChatCompletionsAdapter(this.config),
  );
}
```

Two responsibilities, cleanly split:

- **`ModelTransport`** (`src/model/transport.ts`) owns *HTTP resilience* — and knows nothing about
  any API shape.
- **`WireFormatAdapter`** (`src/model/wire-format.ts`) owns *format shape* — and knows nothing about
  HTTP.

## What the transport owns (format-agnostic)

`ModelTransport` handles the boring, essential, easy-to-get-wrong parts of talking to a model over
HTTP:

- **Fetch + auth** — `POST` with the API key, JSON body.
- **Timeouts** — a total-deadline timer for the non-streaming path, and an **idle/stall timer** for
  streaming that resets on *every received chunk* (so a slow-but-alive stream is not killed, while a
  dead server or mid-stream stall is).
- **Abort merging** — merges the external abort signal (user interrupt) with the timeout signal.
- **Error classification** — `ModelRequestError` tagged with a `RequestFailureKind`
  (timeout / network_error / http_error / invalid_json / stream_error / …).
- **Retry/backoff** — exponential backoff (capped at 4 s), retrying only the retryable kinds
  (timeouts, network errors, 429, 5xx).

None of this mentions `chat_completions` or `responses`. That is the point.

## What the adapter owns (format-specific)

```ts
interface WireFormatAdapter {
  buildUrl(): string;                       // endpoint
  toRequestBody(request): Record<...>;      // request body shape
  parse(data): ModelResponse;              // non-streaming parse
  accumulate(frame): void;                 // fold one SSE delta
  finalize(): ModelResponse;               // complete response
}
```

Two implementations exist: `ChatCompletionsAdapter` and `ResponsesAdapter`. Each knows its own
endpoint, request body, and how to fold streaming deltas into a `ModelResponse`. The transport just
feeds each SSE `data:` frame to `adapter.accumulate` and calls `adapter.finalize()` at the end.

## Why this split matters

The user's original pain was codebases that "support many models" but became an unreadable tangle.
SigPi's answer is small:

- **Supporting another format** = write *one* adapter. You never touch the transport.
- **Supporting another transport** (e.g. a different HTTP stack) = write *one* transport. You never
  touch the adapters.

The `apiFormat` config flag selects the adapter; the transport is shared. That is the entire
"multi-model" story, and it fits in a few hundred lines.

## Key takeaways

- The model layer is two seams: **resilient HTTP** (transport) and **wire format** (adapter).
- The transport is format-agnostic; the adapter is HTTP-agnostic.
- Adding a model format is one new adapter, not a fork.
- The `ModelProvider` interface is what makes the loop testable with a mock.

Next: [Session & Persistence](./07-session.md).

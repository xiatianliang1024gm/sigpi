# 0012 — Model provider seam gets a home module

- **Status**: Accepted
- **Date**: 2026-07-13
- **Commit**: `d2bcb2f`

## Context and Problem

The ADRs and the model-adapters guide describe `ModelProvider` as the seam *in `src/model/`*, but the seam was scattered across four places:

- `ModelProvider` (the interface) was defined inline in `src/types.ts` (a 642-line shared-type grab-bag), not in the model module.
- `src/model/provider.ts` was a **three-line re-export stub** — `export type { ModelProvider }` — with zero depth. It earned nothing.
- `OpenAICompatibleProvider` (the concrete composer) lived in `src/model/openai-compatible.ts`, but consumers reached into it directly.
- `createRuntimeProvider` (the "how do I get a provider" factory) lived in `src/runtime.ts`, not in the model module.

So `src/model/` was a directory of *implementation internals* (transport, two adapters, error-format, util) with **no entry point that owned the seam**. Two consumers named the concrete class directly: `chat-commands.ts:574` did `new OpenAICompatibleProvider(model, logger)` to switch models, and `runtime.ts:108` built one via `createRuntimeProvider`. The "Model provider seam" the ADRs describe had no home module of its own.

## Considered Options

1. **Move the interface into `src/model/provider.ts` as a real definition; `types.ts` re-exports it (adopted)** — `provider.ts` becomes the definition site and the home of `createModelProvider`; the five shared-type consumers (`summarizer.ts`, `context.ts`, `runner.ts`, `turn.ts`, `test/helpers.ts`) keep `import … from "../types.js"` with zero churn. `types.ts` stays a shared-type hub; `provider.ts` is the definition site.
   - This is the lighter touch: it gives `src/model/` the seam's home without churning the shared-type hub or the consumers. `types.ts` re-exporting a type it does not define is already an established pattern (it re-exports many submodule types), and the report's "delete the re-export stub" targets `provider.ts`'s *hollow* re-export, not `types.ts`'s hub role.
2. **Update the five consumers to import `ModelProvider` from `../model/provider.js` and drop it from `types.ts` entirely** — cleaner locality (no double re-export), but touches five files plus the test helper for no behavioral gain.
   - Rejected: the churn buys nothing the adopted option does not, and `types.ts` is the agreed single import site for shared types.

For the factory:

- **`createModelProvider(config, logger)` lives in `src/model/provider.ts`; `createRuntimeProvider` is deleted from `runtime.ts` (adopted)** — the model module owns provider construction; `runtime.ts` and `chat-commands.ts` both call `createModelProvider`. No consumer names `OpenAICompatibleProvider`.
- **Keep `createRuntimeProvider` as a thin wrapper in `runtime.ts`** — rejected: it is a second, redundant factory that keeps provider construction outside the model module, defeating the locality goal.

## Decision

- Define `ModelProvider` in `src/model/provider.ts` (replacing the three-line re-export stub). `src/types.ts` re-exports it so the five shared-type consumers are unchanged.
- Add `createModelProvider(config: ModelConfig, logger?)` to `src/model/provider.ts`; it constructs `OpenAICompatibleProvider`. Delete `createRuntimeProvider` from `runtime.ts`.
- `runtime.ts` obtains the provider via `createModelProvider(config.model, runtimeLogger)`.
- `chat-commands.ts` switches models via `createModelProvider(model, state.runtime.logger)` instead of `new OpenAICompatibleProvider(...)`. No production code outside `src/model/` names the concrete class.
- Update `docs/guide/en/06-model-adapters.md`, `docs/guide/zh/06-model-adapters.md`, and `CONTEXT.md` to point the seam at `src/model/provider.ts`.

## Consequences

- **Depth**: `src/model/provider.ts` is now a real entry point — it defines the interface and owns construction — instead of a hollow pass-through.
- **Locality**: provider wiring (interface + factory) lives in one place; a second provider slots in behind `createModelProvider` without touching `runtime.ts` or `chat-commands.ts`.
- **Leverage**: one seam, N providers; the only concrete-class reference outside the model module is the test (`test/openai-compatible.test.ts`), which legitimately exercises the class directly.
- **Behavior**: unchanged. Model switching and runtime provider construction produce the same `OpenAICompatibleProvider` instance as before.
- **Deletions**: `createRuntimeProvider`; the `provider.ts` re-export stub; the direct `OpenAICompatibleProvider` construction in `chat-commands.ts`.

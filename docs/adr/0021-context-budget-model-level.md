# 0021 — Context budget moves to model level

- **Status**: Accepted
- **Date**: 2026-07-14
- **Area**: config (`src/config.ts`), runtime budget wiring (`src/runtime.ts`, `src/chat-repl.ts`, `src/agent/context.ts`)

## Context and Problem

The token budget that drives compaction is currently stored at the **agent** level:

- `contextWindow` (default `200_000`), `reserveTokens`, and `keepRecentTokens` live in
  `agentConfigSchema` and the `[agent]` TOML section.
- The budget is injected once into `ConversationContext` at startup from `config.agent`
  (`src/runtime.ts:234-236`) and mirrored onto `ChatReplState.contextWindow`
  (`src/chat-repl.ts:26-27`, `:105-106`).

But the config already supports **multiple models** selected by `modelId`
(`src/config.ts:107-108`, `:373-378`), and the model can be switched mid-session via
`/model switch <name>` (`src/chat-commands.ts:562-591`). The docs already describe
`contextWindow` as *"the model's total token budget"* (`docs/guide/en/04-context-management.md:58`),
so the code contradicts its own glossary.

The concrete pain: switching from a 200k model to a 128k model leaves the budget at 200k, so the
compaction trigger (`contextWindow - reserveTokens`) never fires early enough and the smaller model
overflows. `maxTokens` (the model's max *output*) is already a model-level field
(`src/config.ts:39`), so `contextWindow` (the model's max *total*) is its natural sibling.

## Options Considered

**Q1 — Where does the budget belong?**
- Agent-level (status quo): rejected — overflow risk on model switch, contradicts the docs.
- Model-level: chosen — capacity is a physical property of the model.

**Q2 — Do `reserveTokens` / `keepRecentTokens` move too?**
- A: only `contextWindow` moves; reserve/keep stay agent policy. Rejected — splits the budget math
  across two config sections.
- B: all three move to model level. Chosen — the whole "context budget" concept is model-bound; one
  coherent object per model.

**Q3 — Soft/hard framing?**
- Specify both `soft_context_limit` and `hard_context_limit`. Rejected — more knobs than today.
- Keep `hard_context_limit` + `reserveTokens`; soft limit stays derived (`hard - reserve`). Chosen —
  renames `contextWindow` → `hard_context_limit`, preserves current behavior.

**Q4 — Budget on `/model switch`?**
- A: budget follows the active model (recomputed each turn). Chosen — the whole point of the move.
- B: frozen at session-start model. Rejected — defeats the purpose for switched sessions.
- C: block switching to a smaller model. Rejected — surprising UX.

**Q5 — Migration of existing `[agent]` keys?**
- A: one-time relocation into each model entry. Rejected — fiddly with the file+env+agent-state merge.
- B: backward-compat read + deprecation warning. Rejected — more code, silent file rewrite risk.
- C: hard break + release-notes migration. Chosen — simplest; `[agent]` is `.strict()` so old keys
  already error; document the move.

**Q6 — Default + validation?**
- (a) keep `200_000` per-model default. Chosen — preserves today's behavior; default config unchanged.
- (b) validate `maxTokens <= hard_context_limit` at load. Chosen — cheap guard against a silently
  broken config (output larger than the total window).

**Q7 — How `ConversationContext` gets the budget?**
- A: inject a budget getter reading the active model each turn. Chosen — single source of truth.
- B: `reconfigure()` setter on switch. Rejected — easy to forget at other read sites.
- C: read `state.models[state.modelId]` at each use site. Rejected — spreads "which model is active".

**Q8 — `ChatReplState.contextWindow`?**
- (a) delete it; status bar reads through the same budget getter. Chosen — single source of truth.
- (b) keep a snapshot. Rejected — redundant mirror, drift risk.

## Decision

1. **Reclassify the budget as model-level.** Move `hard_context_limit` (renamed from `contextWindow`),
   `reserveTokens`, and `keepRecentTokens` from `agentConfigSchema` into `modelConfigSchema` /
   `[models.<id>]`.
2. **Framing:** `hard_context_limit` (physical ceiling) + `reserveTokens` (headroom); the soft limit
   stays derived as `hard_context_limit - reserveTokens`.
3. **Defaults:** `hard_context_limit` defaults to `200_000` per model (unchanged behavior).
4. **Validation:** at load, `maxTokens` (when set) must be `<= hard_context_limit`; otherwise error.
5. **Dynamic budget:** `ConversationContext` takes a budget getter that reads the *active* model
   (`state.models[state.modelId]`) each turn, so `/model switch` tightens/loosens the trigger
   automatically.
6. **Status bar:** remove `ChatReplState.contextWindow`; the status bar reads through the same budget
   getter.
7. **Migration:** hard break — remove the keys from `[agent]`. Old configs error; release notes tell
   users to move them under `[models.<id>]`.

## Consequences

- **Behavioral:** switching to a smaller model now correctly lowers the compaction trigger; switching
  to a larger model raises it. Sessions no longer overflow a switched-to smaller model.
- **Config:** `[agent]` no longer accepts `context_window` / `reserve_tokens` / `keep_recent_tokens`
  (it is `.strict()`); they move to `[models.<id>]` as `hard_context_limit` / `reserve_tokens` /
  `keep_recent_tokens`. Existing configs must be edited (breaking change, documented in release notes).
- **Validation:** a model with `max_tokens > hard_context_limit` fails fast at load instead of
  producing a silently impossible budget.
- **Locality:** the "which model is active" knowledge lives in one budget getter, not scattered across
  `runtime.ts`, `chat-repl.ts`, and `context.ts`.
- **Test coverage:** alias-map completeness (`CONFIG_ALIASES`) and the `snakeFields` reverse guard
  already enforce that every model field is wired through `parseTomlConfig`; the `maxTokens <=
  hard_context_limit` check needs a dedicated load-time test, and the budget-getter needs a test that
  exercises `/model switch` changing the trigger.

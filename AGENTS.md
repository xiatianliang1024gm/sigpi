# Agent Guide

Project root is `.`. When investigating agent conversations, model requests, or config issues, check these fixed locations first instead of searching the whole tree.

## Configuration

- Global: `~/.sigpi/config.toml`
- Project override: `.sigpi/config.toml` (usually absent; falls back to global)

Key sections: `[model]` (default model + manual selection), `[models.<id>]` (per-model `base_url`/`api_key`/timeout/retry), `[agent]` (context window, max steps), `[logging]`, `[storage]`, `[tools.bash]` (bash command bounds), `[trust]` (project-resource trust: `default_project_trust = "ask" | "always" | "never"). Model resolution order: `MODEL_ID` env → last `/model` choice in `~/.sigpi/state.json` → `[model].default`.

## Codex hooks

`.codex/` is committed. Its PostToolUse hook matches `apply_patch` and runs `node .codex/hooks/biome-check-post-tool-use.mjs`, which applies `biome check --write` to `src/**/*.ts` and `test/**/*.ts` in the current changes.

## Source entry points

- Model requests/responses: `src/model/openai-compatible.ts`
- Agent loop, tool calls, turn failure handling: `src/agent/runner.ts`
- Context construction, compaction, recent messages: `src/agent/context.ts`
- Message types: `src/agent/messages.ts`, `src/types.ts`
- Config loading: `src/config.ts`
- Runtime assembly (provider, tools, session store): `src/runtime.ts`
- Session storage: `src/session/paths.ts`, `src/session/store.ts`
- Logging: `src/logger.ts`

## Agent skills

### Issue tracker

Issues live in GitHub Issues for this repo (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.

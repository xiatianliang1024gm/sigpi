# 0009 — Documentation structure and reading path

- **Status**: Accepted
- **Date**: 2026-07-12
- **Commit**: pending implementation (decided in a grilling session, not yet landed in docs)

## Context and Problem

Positioning (see 0008) is settled: a readable reference implementation; audience = developers with a
coding foundation who want to understand how agents are implemented; `docs/` is bilingual (English
source + Chinese translation). But "what to teach, and in what order" is undecided. Without a reading
path decided first, `docs/` becomes a pile of disconnected concepts — replaying Pi/Codex's
"no main thread, hard to locate" pain.

## Considered Options

1. **Flat chapters by module** (tools / model / session / …): rejected — the reader faces ~80 files
   with no main thread.
2. **`runTurn()` as the single first read, walking loop → function calling → context management in
   control-flow order, with advanced and higher-level topics as later chapters** (adopted).
3. **Cut TUI / skills / plan-tracker / background entirely**: rejected — they exist and are
   interesting; pretending otherwise is dishonest. Instead unify them in one higher-level document as
   "built on top of the agent".

## Decision

- **Reading-path anchor**: `src/agent/runner.ts`'s `runTurn()` is the single "first read"; it strictly
  follows control flow: loop → function calling → context management.
- **Scope split**:
  - **Core three** (must teach): agent loop, function calling, context management.
  - **Advanced** (agent-mechanism extensions): Tools & ToolRegistry (incl. dedup), Model Adapters
    (chat-completions vs responses + transport), Session & Persistence, Real-world Concerns
    (interrupt escape / verification reminder / max-steps synthesis).
  - **Higher-level** (features built on top of the agent, one document): TUI, skills, plan-tracker,
    background tasks.
- **Bilingual layout**: `docs/guide/en/` (English source) + `docs/guide/zh/` (Chinese translation),
  each with a `README.md` index; the root `README.md` (English) is the international entry, doing only
  overview + quickstart + pointing to `docs/guide/`.
- **Chapter order**:
  1. Overview (what it is / why readable / how to run)
  2. The Agent Loop (`runTurn` annotated walkthrough) ← spine
  3. Function Calling (model returns `toolCalls` → dispatch → result feedback)
  4. Context Management (compaction / checkpoint / token budget)
  5. Tools & ToolRegistry (incl. dedup) [advanced]
  6. Model Adapters (chat-completions vs responses + transport) [advanced]
  7. Session & Persistence [advanced]
  8. Real-world Concerns (interrupt / verification reminder / max-steps synthesis) [advanced]
  9. Higher-level: TUI / skills / plan-tracker / background tasks (one doc) [higher-level]

## Consequences

- **Clear main thread**: the reader walks the core in one line, not drowned by 80 files.
- **Honest & complete**: advanced / higher-level features are not hidden, presented in layers.
- **Cleanup dependency**: hardcoded Chinese UX strings must become language-neutral (see 0008); the
  README's positioning first sentence is rewritten; `TinyPi`/`tinypi` residuals are cleaned repo-wide.
- **Deliberate trade-off**: TUI / skills / plan-tracker / background are excluded from the core arc to
  avoid leaving the "how an agent is implemented" main thread.

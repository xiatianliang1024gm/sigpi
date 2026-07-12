# 9. Higher-level: TUI / skills / plan-tracker / background (higher-level)

The previous chapters covered the agent *core* — the loop, function calling, context, tools, model
layer, sessions, and safety guards. None of those require a user interface, a skill system, a plan
view, or background tasks. Those four are **features built on top of the core**, and they are
collected here so they do not distract from the main thread.

The takeaway of this whole chapter: a small, readable agent core is a stable foundation you can keep
extending without touching `runTurn`.

## TUI (`src/tui/`)

The Terminal UI is a *front-end* for the agent, not part of the agent logic. It provides:

- `Tui` — the frame/overlay manager.
- `Editor` — an input editor that uses a cursor marker (`CURSOR_MARKER`, an OSC escape sequence) so
  the agent can place the hardware cursor precisely.
- `SelectList` — keyboard navigation over choices.
- `ProcessTerminal` — wraps the underlying terminal.

The agent core is UI-agnostic: `chat` can run with or without the TUI; the loop does not care which
front-end invokes it.

## Skills (`src/skills/`)

Skills are **instruction documents** that follow the
[Agent Skills specification](https://agentskills.io/specification): a directory with a `SKILL.md`
that the agent reads and follows, running any referenced scripts itself via the `bash` tool. There
is **no separate skill-execution engine** — a skill is just text injected into the system prompt.

Discovery (`loadSkillCatalog`):

1. project `.sigpi/skills` — walked upward from the working directory to the filesystem root
2. project `.agents/skills` — same upward walk
3. global `~/.sigpi/skills`
4. global `~/.agents/skills`

SigPi's own `.sigpi` namespace takes precedence over `.agents`, and project roots beat global roots.
Conflicts are reported as warnings.

## Plan tracker (`src/plan-tracker.ts`)

A lightweight, **in-memory** view of the current plan: an explanation plus a list of items, each with
a status (`pending` / `in_progress` / `completed`). It powers a glanceable TUI status bar
(`formatPlanProgressSummary`, e.g. `📋 2/5 ✅✅🔄⬜⬜`). It is intentionally not persisted — it is a
working aid for the current run, not part of the saved context.

## Background tasks (`src/tools/background.ts`)

The `bash` tool can spawn tasks in the background. `BackgroundTaskManager` tracks them
**in-memory for the lifetime of the runtime process** — a resumed or restarted session does not
recover tasks from a previous process. Each task logs to a per-task file under the session's
`bash-outputs` directory.

## Key takeaways

- The TUI, skills, plan tracker, and background tasks are all *additions* to a working agent core.
- Skills add no execution engine — they are instructions in the prompt.
- The plan tracker and background tasks are intentionally scoped (in-memory, not persisted) to keep
  the core simple.
- This is the real payoff of a readable core: you can build a surprising amount on top without
  forking the loop.

This is the end of the guide. You have now read, in order, the agent loop, function calling, context
management, tools, model adapters, sessions, real-world concerns, and the higher-level features. The
best next step is to open `src/agent/runner.ts` and read `runTurn()` end to end — it will all be
familiar.

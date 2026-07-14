# 0018 — Input history: shell-style `↑`/`↓` recall

- **Status**: Accepted
- **Date**: 2026-07-14
- **Commit**: `7508527`

## Context and Problem

The chat REPL reads input through a custom TUI `Editor` (`src/tui/editor.ts`),
wrapped by `ChatInputComponent` (idle) and `RunningTurnInputComponent` (type
while a turn runs). Today `↑`/`↓` are already bound: when a `/` chat command's
suggestions are showing, the arrows navigate those suggestions
(`src/chat-input.ts:177-185`). The user wants shell-style history recall — press
`↑`/`↓` to walk previously submitted inputs, edit them, and resend — "like typing
commands in Linux." The "Linux" framing is about *interaction feel*, not
durability: the user explicitly does **not** want the agent to read its prior
messages on restart; the conversation transcript already covers that.

Research against Pi confirmed a sensible scope: only inputs that actually reach
the model are recorded (prompts and `/skill:…`-style commands); local-only
commands (`/settings`, `/models`, `/help`, …) are not recorded and are not
recallable. We adopt that.

This ADR records the resolved design. The decisions below are hard to reverse
because they fix key bindings, the data model, and the write path; a future
reader would otherwise wonder why arrows behave this way.

### Facts established during the review (verified against source)

- `getChatCommandSuggestions` (`src/chat-commands.ts:720-736`) returns non-empty
  **only** when the buffer matches `/^\/\S*$/` — a `/` followed by non-space
  chars, no arguments yet. So the existing "arrows navigate suggestions when
  `suggestions.length > 0`" is already effectively "while typing a `/` command."
- Both input modes converge on `executeChatCommand` in the REPL loop
  (`src/cli.ts:365`). The result's `turnInput` (`src/cli.ts:385-390`) is
  non-null **exactly** when the input reached the model — `not-a-command` (a
  prompt) or `handled` + `run-turn` (`/skill:…`). Local commands and unknown
  commands yield `turnInput === null`. This is a ready-made gate for "only
  record model-reaching inputs."
- The running-turn input's `onSubmit` pushes to `queuedLines`
  (`src/cli.ts:430-432`), which re-enters the same loop and hits the same gate —
  so one write path covers both input modes.
- The `Editor` is multiline-capable (render branches on `text.includes("\n")`),
  so history entries may contain newlines.

## Considered Options

1. **Context-dependent arrows + in-memory global buffer + loop-gated writes
   (adopted)** — arrows mean history by default and suggestion-nav only while
   typing a `/` command; one in-memory buffer for the process; push in the loop
   gated by `turnInput !== null`. Lightest, reuses existing predicates, one code
   path.
2. **Rebind suggestion-nav to `Tab`, give arrows to history unconditionally
   (rejected)** — cleaner "arrows are always history" but changes the existing
   command-menu UX more abruptly and discards the already-correct `/`-context
   behavior.
3. **Persist history to disk, per-session (rejected)** — the user explicitly
   does not want durability or per-session fragmentation; the transcript already
   persists what was said. In-memory global matches the stated intent and is
   simpler.
4. **Record every non-empty submission including local commands (rejected)** —
   diverges from the Pi behavior the user pointed at, and pollutes recall with
   `/settings` toggles you'd never re-run.
5. **Push history from the input component's `onSubmit` (rejected)** — the
   component cannot tell a local command from a model-driving one without
   re-parsing; it would wrongly record `/settings`. The loop's `turnInput` gate
   is the single correct owner.
6. **Bash-style wrap-around at both ends (rejected)** — more familiar to shell
   users but adds state and test surface; stopping at the ends is simpler and
   less surprising for a chat input.
7. **Disable history in the running-turn input (rejected)** — inconsistent UX
   and loses the ability to queue a recalled command mid-turn; sharing the buffer
   is free.

## Decision

- **Key bindings are context-dependent, not key-dependent.** `↑`/`↓` recall
  history by default; they navigate command suggestions only when the current
  line is a `/` chat command with suggestions open (the existing behavior).
- **The context rule is stateless.** Arrows navigate suggestions exactly when
  `getChatCommandSuggestions` would return non-empty (buffer matches
  `/^\/\S*$/`); otherwise they recall history. No extra "recalling" mode flag.
- **In-memory, process-scoped, global.** A single `InputHistory` buffer for the
  CLI run, discarded on exit. Not persisted to disk, not tied to a `Session`.
- **Entries: only model-reaching inputs.** Natural-language prompts and
  model-driving commands such as `/skill:…` are recorded, with
  consecutive-duplicate suppression. Local-only commands (`/settings`,
  `/models`, `/help`, …) and unknown commands are **not** recorded and are not
  recallable.
- **Write path: the REPL loop, gated by `turnInput !== null`.** The buffer is
  pushed exactly when the command result's `turnInput` is non-null, recording the
  **original `line`** the user typed (not any expanded form such as a `/skill:`
  instruction). Both the idle input and the running-turn input flow through this
  one gate.
- **Navigation model.** The live draft is a distinct slot at the bottom of the
  list. `↓` past the newest entry returns to the draft; `↑` past the oldest
  entry stops (no wrap). Recalled entries (which may be multiline) load whole
  into the editor. Arrow-meaning is tied to history position: on a history entry
  (or the draft) `↑`/`↓` recall; once the recalled line is edited it drops back
  to the draft slot and `↑`/`↓` become in-editor vertical cursor movement.
- **The running-turn input shares the buffer and the same recall/record rules**,
  so history behaves identically in both modes.
- **Ownership.** A single `InputHistory` buffer is created once at CLI startup
  and injected into the REPL loop. The `Editor` stays a pure text-editing
  primitive; history navigation is a component-level concern (so it can interact
  with the suggestion-nav context).

## Consequences

- **Vocabulary**: the term **Input history (命令历史)** is added to `CONTEXT.md`
  with the rules above; it is explicitly distinct from **Session** persistence.
- **No persistence layer added.** No file, no config, no per-session storage.
- **One new module** (`InputHistory`) with a small, testable surface: `push`,
  `prev`, `next`, `current`, draft-slot handling, and consecutive-dup
  suppression. It is decoupled from the `Editor`.
- **Minimal change to existing bindings**: the `↑`/`↓` suggestion-nav branch in
  `ChatInputComponent.handleInput` is unchanged in behavior; history recall is
  the new `else` branch.
- **Tests to add**:
  - `InputHistory`: push/prev/next/draft-slot, stop-at-ends (no wrap),
    consecutive-dup suppression, multiline entries preserved whole.
  - REPL loop: only `turnInput !== null` inputs are recorded; local commands and
    unknown commands are not; the original `line` is stored (not the expanded
    `/skill:` form).
  - Component: arrows recall history by default; arrows navigate suggestions when
    the buffer matches `/^\/\S*$/`; editing a recalled line returns arrows to
    cursor movement.

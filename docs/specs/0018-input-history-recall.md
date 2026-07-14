## Problem Statement

When using the SigPi chat REPL, every input is typed from scratch. There is no way to
bring back something I sent a moment ago — a prompt I want to tweak and resend, or a
`/skill:` invocation I want to run again. In a normal shell, `↑`/`↓` recall previous
commands; the user wants that same feel in the chat input: walk previously submitted
inputs, edit them, and send. The "Linux" framing is about interaction feel, not
durability — the user explicitly does **not** want the agent to re-read its prior
messages on restart; the conversation transcript already covers that.

## Solution

Add **Input history (命令历史)**: a shell-style `↑`/`↓` recall in the chat input.
Pressing `↑`/`↓` walks previously submitted inputs (loaded into the editor for
editing), and `Enter` resends. The feature coexists with the existing `/` command
suggestion navigation by context, records only inputs that actually reach the model
(mirroring Pi's behavior), and lives entirely in memory for the lifetime of the
process. It is distinct from the existing `/history` command, which shows the saved
**turn history** of the active session — that is the transcript, not command recall.

## User Stories

1. As a chat user, I want to press `↑` to recall my most recent submitted input, so
   that I can resend or edit it without retyping.
2. As a chat user, I want to keep pressing `↑` to walk older inputs and `↓` to walk
   back toward the newest, so that I can browse my recent inputs like a shell.
3. As a chat user, I want a recalled input to load into the editor with my cursor at
   the end, so that I can immediately edit or send it.
4. As a chat user, I want the live text I was typing (the draft) to be preserved when
   I scroll up into history and back down, so that I never lose what I was mid-typing.
5. As a chat user, I want `↓` at the newest entry to return me to my draft, so that
   the bottom of the list is always my current input.
6. As a chat user, I want `↑` at the oldest entry to stop (not wrap), so that the
   behavior is predictable and doesn't loop unexpectedly.
7. As a chat user, I want `↑`/`↓` to navigate command suggestions when I am typing a
   `/` command with suggestions open, so that the existing command-menu UX is
   unchanged.
8. As a chat user, I want `↑`/`↓` to recall history whenever I am not in the
   `/`-command suggestion context, so that the default arrow behavior is history.
9. As a chat user, I want only my natural-language prompts and model-driving commands
   (such as `/skill:…`) to be recorded, so that recall stays focused on things worth
   re-running.
10. As a chat user, I want local-only commands (`/settings`, `/models`, `/help`, …)
    and unknown commands to be excluded from history, so that recall isn't cluttered
    with commands that don't reach the model.
11. As a chat user, I want consecutive identical submissions to be stored only once,
    so that repeated sends don't fill the history buffer.
12. As a chat user, I want a multiline input I submitted to be recalled whole (with
    its newlines intact), so that I can resend a multi-line prompt as-is.
13. As a chat user, I want `↑`/`↓` to mean history while a recalled (or draft) line
    is shown, but to become in-editor vertical cursor movement once I edit that line,
    so that multiline editing still works after recall.
14. As a chat user, I want inputs I type while a turn is running to be recallable
    later, so that history behaves identically whether or not the agent is busy.
15. As a chat user, I want inputs I type while a turn is running to be recorded under
    the same rules as idle input, so that there is one consistent history.
16. As a chat user, I want history to reset when the process exits, so that nothing
    persists to disk and a fresh start is clean (matching the "in-memory only" intent).
17. As a chat user, I want the original text I typed (e.g. `/skill:foo`) recorded
    rather than any expanded form, so that recall re-runs exactly what I entered.
18. As a maintainer, I want the history buffer to be a small, independently testable
    module decoupled from the `Editor`, so that the TUI primitive stays a pure
    text-editing component.
19. As a maintainer, I want history navigation to be a component-level concern, so
    that it can interact with the existing suggestion-navigation context.
20. As a maintainer, I want the write path to live in the REPL loop gated by whether
    the input reached the model, so that no input component has to re-parse commands
    to decide what to record.

## Implementation Decisions

- **New module: `InputHistory`** — a small, in-memory buffer created once at CLI
  startup and injected into the REPL loop. It exposes `push`, `prev`, `next`,
  `current`, draft-slot handling, and consecutive-duplicate suppression. It is
  decoupled from the `Editor` and holds no TUI state.
- **Key-binding rule is context-dependent, not key-dependent.** `↑`/`↓` recall
  history by default; they navigate command suggestions only when the current line
  is a `/` chat command with suggestions open (the existing behavior, unchanged).
- **The context rule is stateless at the draft slot.** At the draft slot, arrows
  navigate suggestions exactly when `getChatCommandSuggestions` would return
  non-empty (buffer matches `/^\/\S*$/`); otherwise they recall history. Once an
  `↑`/`↓` enters the recall context (a recalled entry is showing, or the user is
  mid-edit of a recalled line), slash suggestions are suppressed so the arrows keep
  walking history instead of getting trapped on a recalled `/`-command such as
  `/skill:foo`. The recall context clears when the buffer returns to the clean
  draft slot, so clearing a recalled line fully restores recall.
- **In-memory, process-scoped, global.** A single buffer for the CLI run, discarded
  on exit. Not persisted to disk, not tied to a `Session`.
- **Entries: only model-reaching inputs.** Natural-language prompts and model-driving
  commands such as `/skill:…` are recorded, with consecutive-duplicate suppression.
  Local-only commands (`/settings`, `/models`, `/help`, …) and unknown commands are
  not recorded and are not recallable. This mirrors Pi's observed behavior.
- **Write path: the REPL loop, gated by `turnInput !== null`.** The buffer is pushed
  exactly when the command result's `turnInput` is non-null (i.e. the input reached
  the model), recording the **original `line`** the user typed (not any expanded form
  such as a `/skill:` instruction). Both the idle input and the running-turn input
  converge on this one gate, so a single write path covers both modes.
- **Navigation model.** The live draft is a distinct slot at the bottom of the list.
  `↓` past the newest entry returns to the draft; `↑` past the oldest entry stops
  (no wrap). Recalled entries (which may be multiline) load whole into the editor.
  Arrow-meaning is tied to history position: on a history entry (or the draft)
  `↑`/`↓` recall; once the recalled line is edited it drops back to the draft slot
  and `↑`/`↓` become in-editor vertical cursor movement.
- **The running-turn input shares the buffer and the same recall/record rules**, so
  history behaves identically in both modes.
- **Naming discipline.** The new concept is **Input history (命令历史)** and is
  explicitly distinct from the existing `/history` command (which shows saved turn
  history / the session transcript). The spec does not rename or alter `/history`.
- **ADR of record:** ADR 0018 — Input history: shell-style `↑`/`↓` recall. The
  glossary term **Input history (命令历史)** is defined in `CONTEXT.md`.

## Testing Decisions

- **What makes a good test:** assert external behavior only — what the buffer
  returns, what the loop records, and what the input component does on arrow keys —
  not internal cursor bookkeeping. Prefer the existing dependency-injected seams
  over new ones.
- **Seam 1 — `InputHistory` pure unit.** New tests for the buffer in isolation:
  `push`/`prev`/`next`/draft-slot, stop-at-ends (no wrap), consecutive-duplicate
  suppression, and multiline entries preserved whole. No TUI required.
- **Seam 2 — REPL loop write path (highest existing seam).** `runChatReplLoop`
  already accepts injected `readChatInput` / `executeChatCommand` / `executeTurn`.
  Add one injected `inputHistory` dependency and assert: only inputs whose
  `turnInput !== null` are recorded; the original `line` is stored (not the expanded
  `/skill:` form); local commands and unknown commands are not. This exercises the
  buffer through the real loop rather than a re-implementation.
- **Seam 3 — input component arrow behavior (existing TUI harness).** Reuse the
  `FakeInput`/`FakeOutput` harness from `chat-input.test.ts`. Assert `↑`/`↓` recall
  history by default, navigate suggestions when the buffer matches `/^\/\S*$/`, and
  that editing a recalled line returns arrows to cursor movement.
- **Prior art:** `test/chat-input.test.ts` (TUI input via `FakeInput`/`FakeOutput`),
  `test/chat-repl.test.ts` (loop driven with injected `readChatInput` and scripted
  prompts), and `test/helpers.ts` (`MockProvider`, `MemoryLogger`, CLI capture
  helpers).

## Out of Scope

- Persisting history to disk or across restarts.
- Per-session or per-conversation history partitions.
- Any change to the existing `/history` command or the session transcript it shows.
- Fuzzy / substring search of history (e.g. `Ctrl-R`); only linear `↑`/`↓` recall.
- Recording local-only commands or unknown commands.
- Bash-style wrap-around at the ends of the list.
- A separate "mode flag" for history vs. suggestion navigation (the rule stays
  stateless).

## Further Notes

- The design was reached via a `/grilling` session and recorded in ADR 0018; the
  glossary term lives in `CONTEXT.md`. This spec is the implementation-facing
  counterpart and should be implemented in a way that honors both.
- The single highest test seam is the REPL loop dependency injection (Seam 2); the
  unit and TUI tests are supporting seams that reuse existing harnesses.
- Because the write gate (`turnInput !== null`) already distinguishes model-reaching
  inputs from local commands, the "only record model-reaching inputs" rule requires
  no command re-parsing in the input components.

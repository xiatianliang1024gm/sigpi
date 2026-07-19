# TUI Development Notes

- This project has one persistent TUI for the chat REPL, plus modal overlays
- (session selector) shown on top of it.
-
- - **Chat REPL** — a single Pi-tui `TUI` lives for the whole session (ADR 0025, A1
-   model, mirroring Pi's `InteractiveMode`). The transcript is a **component tree**
-   (`chatContainer` of per-message components: user / assistant / tool-result /
-   compaction), rendered by Pi-tui and scrolled by Pi-tui's viewport. The input
-   `Editor`, status footer, and a `pending` area are persistent children.
- - **Session selector** — a modal overlay shown on startup / `/session`; replaces
-   the viewport while active, then returns to the chat `TUI`.
-
## Core Rules
-
### Transcript is a component tree, not terminal scrollback
-
- Under ADR 0025 the live transcript is owned by the `TUI` as components — **not** by
- the OS terminal scrollback. Previous turns are not in `stdout`; they live in the
- component tree and are scrolled by Pi-tui's viewport. Consequences:
-
- - Do **not** print turn output with raw `console.log` while the `TUI` is alive — it
-   desyncs Pi-tui's internal viewport and re-draws the frame displaced (the bug ADR
-   0025 fixes). All live output is a component; only non-TTY / one-shot modes use
-   `console.log`.
- - The `TUI` renders from the current cursor on first paint and scrolls its own
-   viewport as the transcript grows; it does **not** rely on the terminal scrollback
-   to preserve history.
- - The chat input is a component *inside* the persistent `TUI`, not a separate
-   inline `TUI`. The old `InlineTerminal` / per-phase `TUI` reconstruction is gone.
-
- Use full-screen clears only for modal screens (session selector) where replacing
- the viewport is expected.

### Keep Hardware Cursor Real

Chinese/Japanese/Korean IME candidate windows follow the terminal hardware cursor, not a fake glyph.

The editor emits `CURSOR_MARKER` as a zero-width marker. Pi-tui's `TUI` scans rendered lines for that marker, removes it from visible output, and moves the hardware cursor to the marker position after drawing the frame. (SigPi's fork `Editor` emits its own marker; the chat-input wrapper converts it to Pi-tui's `CURSOR_MARKER` before handing lines to the `TUI`.)

Do not render a fake cursor such as `▌` for input position. It may look correct visually while the IME candidate window appears somewhere else.

### Render Input With Display Width

Input must wrap by terminal display width, not JavaScript string length.

Chinese full-width characters count as 2 columns. ANSI/APC escape sequences count as 0 columns. Use the helpers in `src/tui/utils.ts` instead of ad hoc slicing:

- `visibleWidth()`
- `truncateToWidth()`
- `wrapToWidth()`
- `normalizeRenderedLine()`

The prompt only belongs on the first visual line:

```text
> abcdefgh
ijk
```

Continuation lines should not repeat `> `. This keeps editing and IME placement predictable.

## Rendering Modes

### Full-Screen TUI

Use full-screen mode when the UI owns the viewport.

Expected behavior:

- clear on start
- fill the terminal height
- absolute cursor positioning is fine
- clear the screen on exit if the UI is modal

Example: session selector.

### Inline TUI

Use inline mode when the UI is part of a transcript.

Expected behavior:

- never emit `CSI 2J` full-screen clear
- render relative to the current cursor line
- only clear the inline input area
- leave all previous output above the prompt intact
- move to the line below the rendered prompt on submit/cancel

Example: chat input.

## Input Model

Keep text editing state in `Editor`; do not duplicate cursor logic in callers.

`Editor` owns:

- current text
- cursor index
- left/right movement by code point
- backspace/delete
- bracketed paste insertion
- submit/cancel callbacks
- wrapped rendering with `CURSOR_MARKER`

Callers such as `readChatInput()` should compose `Editor.render()` with extra UI like slash-command suggestions, not reimplement input rendering.

## IME Checklist

When changing TUI input, verify:

- the terminal hardware cursor is visible while editing
- `CURSOR_MARKER` is present before the logical insertion point
- Pi-tui's `TUI` moves hardware cursor after writing changed lines
- marker stripping happens after cursor calculation, before writing visible lines
- candidate windows appear near the current insertion point for Chinese input

If IME candidates appear at the right edge or a stale location, the hardware cursor is not being moved to the marker location at the end of the render pass.

## Testing Guidance

Prefer tests that validate behavior, not one exact terminal escape protocol.

For inline input:

- assert existing transcript text is not cleared
- assert no `\x1B[2J` is emitted
- assert rendered visible text contains the prompt/input
- assert wrapping works for ASCII and Chinese text
- assert editing in the middle of Chinese text keeps the expected content

For TUI core:

- use a fake terminal and assert final cursor movement
- assert hardware cursor movement happens after drawing
- assert full-width characters affect cursor columns correctly

Key regression tests currently cover:

- chat input does not clear existing transcript
- long input wraps instead of truncating
- Chinese input wraps by display width
- editing in the middle of Chinese text preserves content
- hardware cursor is positioned at the editor marker

## Common Pitfalls

- Using full-screen TUI for chat prompt: wipes the assistant answer on the next input.
- Hiding the hardware cursor and drawing a fake cursor: IME candidate window can appear far from the input.
- Slicing strings by `length`: breaks Chinese display width and ANSI sequences.
- Letting marker escape sequences participate in wrapping: marker bytes can leak into visible output or split across lines.
- Padding inline chat input to terminal height: clears transcript area below the prompt.
- Reimplementing editor cursor behavior in callers: introduces divergent behavior between chat input and standalone editor tests.

# Spec 0018 — Max-steps fallback, error exit contract, and resume-on-"go on"

> Synthesized from a grill-with-docs session (no interview). Companion to
> `docs/adr/0018-max-steps-and-error-exit-contract.md`. Uses the project
> domain vocabulary from `CONTEXT.md` (Agent turn, Max-steps fallback,
> Resume-on-"go on", Error exit contract, turn checkpoint, tool error).

## Problem Statement

When an **Agent turn** hits its `maxSteps` bound, the experience is broken in
three ways the user actually feels:

1. **Model errors silently succeed.** A 500 from the model makes the CLI exit
   `0` instead of non-zero, so automation and the user's "go on" loop cannot
   tell a real failure from success. The existing `model boom` integration test
   already encodes the intended contract (exit 1 + a specific message) and is
   failing because the code violates it.

2. **The max-steps output is "wired".** At the limit the runner fires one more
   model request with `tools: []` to synthesize a final answer. With tools
   disabled the model cannot emit structured tool calls, so it leaks tool-call
   markup into the prose (`<tool_call><invoke name="read">…</invoke></tool_call>`,
   minimax `]<]minimax[>` artifacts, think tags). A hard-coded marker guard
   rejects only exact matches; any variant slips through and is printed as the
   final answer. If synthesis throws (e.g. a 500) or is rejected, the user gets
   a generic "I hit the tool-call step limit" line instead of a useful summary.

3. **"go on" churns.** Because the bound is hit on essentially every real task,
   the user must repeatedly say "go on". Each "go on" is a **cold restart** —
   a fresh turn with a fresh `maxSteps` budget and `workingMessages` rebuilt
   from persisted context — so it re-does the same steps and re-hits the limit.

The `maxSteps` default is also inconsistent across the repo (config says 20,
docs say 8, the user runs 40), so the bound is routinely too low for real work.

## Solution

- **Model errors fail loudly; tool errors and the max-steps fallback do not.**
  A turn that produced no answer (only model errors reach this state) makes the
  CLI exit non-zero. A turn that completed with a tool error or a max-steps
  fallback exits zero — those are recoverable, answer-bearing outcomes.
- **The max-steps limit ends the turn with a local, lossless fallback** built
  from the in-memory `toolExecutions` and `currentGoal` — **no final model
  call**. This removes the `<tool_call>` leakage and the 500 risk in one move,
  and ends the turn immediately.
- **The "reached max steps" signal is user-facing only.** It appears in the
  final answer text (stating the limit was reached, the task is incomplete, and
  prompting `go on` to continue) and in a progress/status event. It is **never
  injected into a message to the LLM** — the next turn resumes from real history
  plus the turn checkpoint, which is sufficient without a meta-instruction.
- **"go on" resumes the same task.** A turn that ended via the `maxSteps` bound
  is marked resumable; a later `go on` (already collapsed onto the previous
  goal by goal resolution) continues from the checkpoint with a fresh budget
  instead of re-running the same steps.
- **`maxSteps` stays as the automatic safety stop** (it is the only guard
  against a runaway tool loop in headless `ask`/CI where no human can press
  escape), but its default is raised so normal tasks fit.

## User Stories

1. As a CLI user running `ask` in CI, I want a model 500 to make the process
   exit non-zero, so that my pipeline treats the run as failed instead of
   silently succeeding.
2. As a CLI user, I want a model 500 to print a clear, friendly server-error
   message on stderr, so that I understand the failure without raw stack noise.
3. As a test author, I want the `model boom` integration test to assert exit 1
   plus the friendly message, so that the error-exit contract is enforced.
4. As an agent user, I want a turn that hits `maxSteps` to end with a summary
   built from the real work done (files read, commands run, calls made), so that
   I see what actually happened instead of a generic line.
5. As an agent user, I want the max-steps answer to contain no leaked
   `<tool_call>` / `<invoke>` markup, so that the output reads as normal prose.
6. As an agent user, I want the max-steps turn to end without an extra model
   request, so that it is fast and cannot fail on a second 500.
7. As an agent user, I want the max-steps answer to tell me the task is not
   complete and to type `go on` to continue, so that I know the next action.
8. As an agent user, I want a visible progress/status event when the limit is
   reached, so that I notice the turn stopped before a final answer.
9. As an agent user, I want `go on` after a max-steps turn to continue the same
   task from where it left off, so that I make forward progress instead of
   repeating work.
10. As an agent user, I want `go on` to resume with a fresh `maxSteps` budget,
    so that the continued task is not immediately re-limited.
11. As a REPL user, I want a tool error during a turn to still produce a
    completed turn (exit 0 in `ask`), so that a single bad tool call does not
    abort the whole session.
12. As a session user, I want the max-steps turn's real progress persisted, so
    that resume and later review can see what was done.
13. As a config user, I want `maxSteps` to default to a value that fits normal
    tasks, so that I do not hit the limit on every real request.
14. As a headless `ask` operator, I want `maxSteps` to remain an automatic hard
    stop, so that a non-terminating tool loop cannot run forever without a human.
15. As a debugging user, I want the raw model error body preview preserved in a
    structured log, so that I can diagnose 500s even though the user-facing
    message is friendly.
16. As a future maintainer, I want the error-exit contract encoded in the turn
    result type (`ok: false` means "no answer produced"), so that the behavior
    is obvious from the type, not just control flow.

## Implementation Decisions

- **Error exit contract (ADR 0018 §1).** Map a non-ok turn result to a
  non-zero process exit inside the one-shot `ask` path only; the REPL/chat path
  keeps catching the non-ok result to survive a failed turn. `ok: false`
  already means "no answer was produced" — only model errors reach it, while
  tool errors are surfaced into a completed turn — so the contract is encoded
  in the type, not added as a new flag.
- **Update the `model boom` test** to expect exit 1 plus the friendly 5xx
  message produced by the dedicated error formatter. The raw body preview
  survives in the structured `chat_turn_failed` log, so nothing is lost for
  debugging. The test was written against the older raw format and is the stale
  artifact; the two formatters (raw vs friendly) are reconciled by asserting
  the friendly one.
- **Remove the mandatory `tools: []` synthesis request at the limit (ADR 0018
  §3).** On `step > maxSteps`, assemble `outputText` locally from
  `toolExecutions` + `currentGoal` (an enhanced Max-steps fallback). No model
  call is made, so there is no 500 risk and no `<tool_call>` leakage. Checkpoint
  reuse and deferred synthesis are explicitly declined — local assembly only.
- **User-facing limit signal only (ADR 0018 §3).** The "reached max steps"
  information lives in (a) the final answer text — stating the limit was
  reached, the task is incomplete, and prompting `go on` — and (b) a
  progress/status event. It is never placed into `workingMessages` /
  `turnMessages`; the next turn resumes from real history plus the turn
  checkpoint.
- **Strip-and-keep is moot while the synthesis call is removed.** If any future
  path re-introduces model synthesis at the limit, leaked `<tool_call>` /
  `<invoke>` / think-tag spans should be stripped from the prose rather than
  rejecting the whole answer.
- **Keep `maxSteps`; raise the default (ADR 0018 §2).** It remains the only
  automatic stop against a runaway tool loop in headless runs. The default is
  raised so normal tasks fit (the repo default currently sits below the user's
  working value).
- **Resume-on-"go on" (ADR 0018 §4).** A turn ending via the `maxSteps` bound
  is marked resumable, carrying a checkpoint (goal + recent steps). A later
  `go on` — already collapsed onto the previous goal by goal resolution —
  resumes the same task from the checkpoint with a fresh `maxSteps` budget,
  instead of a cold restart. The manual `go on` trigger stays; only
  max-steps-bounded turns become resumable, preserving the human checkpoint that
  `maxSteps` exists to provide.
- **Status semantics unchanged.** Resume is carried via a resumable flag
  rather than changing `TurnStatus` / `SessionStatus` to `interrupted`; that
  larger change is deferred.

## Testing Decisions

- **Test external behavior, not implementation.** Assert on `outputText`, the
  turn result (`ok` / resumable flag), the process exit code, and emitted
  progress events — not on internal call order or private helpers.
- **Seam 1 — `test/agent-runner.test.ts`** (highest unit seam; already covers
  max-steps at the `<tool_call>`-leakage assertion). Add cases for: max-steps →
  local fallback assembled from `toolExecutions` + `currentGoal`; **no model call
  fired** at the limit; `outputText` contains no `<tool_call>` / `<invoke>`
  markup and includes the "go on to continue" prompt; turn marked resumable.
- **Seam 2 — `scripts/cli-integration.mjs`** (integration; hosts the existing
  `model boom` test). Assert: model 500 → exit 1 + the friendly
  `The model provider returned a server error (HTTP 500). Retry shortly.`
  message; and that a normal max-steps `ask` exits 0 with the local fallback.
- **Seam 3 — `test/goal-resolution.test.ts` + `test/session-runtime.test.ts`**
  (prior art for Resume-on-"go on"). Assert that `go on` after a max-steps turn
  resumes the same task from the checkpoint (fresh budget, no cold restart of
  the same steps).
- **Prior art:** `agent-runner.test.ts` max-steps tests (lines ~232–284,
  ~594–721), `error-format.test.ts` for the friendly 5xx message, and the
  existing `model boom` block in `cli-integration.mjs` (~line 175).

## Out of Scope

- Adaptive bounds (token budget, wall-clock budget) or tool-call-repetition
  detection as an alternative to `maxSteps` — `maxSteps` stays.
- Changing `TurnStatus` / `SessionStatus` to `interrupted` for the limit —
  deferred; resume uses a resumable flag.
- Injecting a "you hit the limit" system message into the next turn — declined;
  checkpoint + real history suffice.
- Auto-continue without an explicit `go on` — declined, to preserve the human
  checkpoint.
- Reconciling the two model-error formatters beyond asserting the friendly one
  in the test (the raw formatter may remain for logs).

## Further Notes

- The root cause of both the "wired" output and the 500 fragility at the limit
  is the same `tools: []` synthesis call; removing it resolves both at once.
- The `maxSteps` default inconsistency (config 20 / docs 8 / user 40) should be
  reconciled as part of raising the default; the user's 40 is a symptom of the
  default being too low, not a target.
- **Publish note:** this spec could not be published to the project issue
  tracker — `.matt/` has no tracker configuration. Run `/setup-matt-pocock-skills`
  to configure the tracker, then publish with the `ready-for-agent` triage label.
  Until then it lives at `docs/specs/0018-max-steps-error-exit-resume.md`.

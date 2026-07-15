# 0018 — Max-steps fallback, error exit contract, and resume-on-"go on"

Date: 2025-01 (grill-with-docs session)
Status: Accepted

## Context

The `sigpi-feat_max_step` branch bounds each agent turn's tool-call loop by
`maxSteps`. Two recurring problems surfaced in use:

1. **Model errors exit 0.** A 500 from the model propagates as
   `ModelRequestError` → uncaught inside the loop (`runner.ts`) → caught by
   `AgentTurn.runTurn` which returns `{ ok: false, errorMessage }` → `runAsk`
   sees `!result.ok` and `return`s with **exit code 0**. The
   `cli-integration.mjs` "model boom" test expects exit 1 + a specific
   message, so it fails. The CLI also prints `formatModelErrorMessage`'s
   friendly 5xx string (`The model provider returned a server error (HTTP 500).
   Retry shortly.`) rather than the raw `Model request failed: 500 Internal
   Server Error` that the test asserts — there are two formatters in tension
   (`transport.ts:128` raw vs `error-format.ts:60` friendly).

2. **Max-steps output is "wired".** When the bound fires, the runner makes one
   more `provider.generate` call with `tools: []` and
   `MAX_STEPS_SYNTHESIS_PROMPT` to synthesize a final answer. Under `tools: []`
   the model cannot emit structured tool calls, so it "leaks" tool-call markup
   into the prose (`<tool_call><invoke name="read">…</invoke></tool_call>`,
   minimax `]<]minimax[>` artifacts, think tags). `isUsableMaxStepsAnswer`
   rejects text containing a hard-coded marker list, but any variant the list
   misses passes through and is printed as the final answer. If synthesis
   throws (e.g. a 500) or is rejected, it falls back to the generic
   `buildMaxStepsFallbackAnswer` ("I hit the tool-call step limit…"). Because
   the bound is hit on essentially every real task, the user must repeatedly
   say "go on", and each "go on" is a **cold restart** (fresh turn, fresh
   `maxSteps` budget, `workingMessages` rebuilt from persisted context) that
   re-does the same 40 steps and re-hits the limit — the "churn".

`maxSteps` defaults are also inconsistent: `config.ts` = 20, docs = 8, user
runs 40.

## Decision

### 1. Exit-code contract (Q1, Q2, Q3)

- **Model errors → exit 1; tool errors and the max-steps fallback → exit 0.**
  `RunTurnResult.ok === false` already means "no answer was produced" — only
  model errors reach it; tool errors are surfaced *into* a completed turn
  (`ok: true`). So the contract is already encoded in the type.
- **Enforce in `runAsk` (cli.ts).** Map `!result.ok` →
  `process.exitCode = 1` before its `return`. The REPL/chat path keeps
  catching `ok: false` to survive a failed turn.
- **Update the `model boom` test** to expect `exit 1` +
  `The model provider returned a server error (HTTP 500). Retry shortly.`
  (the `error-format.ts` voice). The raw body preview survives in the
  `chat_turn_failed` structured log, so nothing is lost for debugging. The test
  was written against the older raw format and is the stale artifact.

### 2. Keep the bound; raise the default (Q5)

- **Do not remove `maxSteps`.** It is the only automatic stop against a
  runaway tool loop in the headless `ask`/CI path, where no human can press
  escape. Raise the default so normal tasks fit (the repo default is currently
  below the user's working 40).

### 3. Lossless, local max-steps fallback — no final LLM call (Q6, Q9, Q10, Q11)

- **Remove the mandatory `tools: []` synthesis request at the limit.** On
  hitting `maxSteps`, build `outputText` **locally** from the in-memory
  `toolExecutions` + `currentGoal` (an enhanced `buildMaxStepsFallbackAnswer`).
  Zero extra LLM call → zero 500 risk, zero `<tool_call>` leakage, immediate
  turn end.
- **No checkpoint reuse, no deferred synthesis.** Keep it simple: local
  assembly only (option 1 of the grill; option 2/3 explicitly declined).
- **The "max steps reached" signal is user-facing only — never injected into a
  message to the LLM.** It goes into (a) the final `outputText` ("reached the
  maximum tool-call steps (N); the task is not complete; type `go on` to
  continue") plus a real progress list, and (b) a progress/status event
  (`turn_max_steps_reached`) so the user sees it at a glance. It does **not**
  enter `workingMessages`/`turnMessages`; the next "go on" turn resumes from
  real history + checkpoint, which is sufficient without a meta-instruction.
- **Strip-and-keep is moot** once the synthesis call is removed; if any future
  path re-introduces model synthesis at the limit, strip leaked
  `<tool_call>`/`<invoke>`/think-tag spans rather than rejecting the whole
  answer.

### 4. "go on" resumes the same task (Q8)

- When a turn ends via the `maxSteps` bound, mark it **resumable** (carry a
  checkpoint: goal + recent steps). A subsequent "go on"
  (`goal-resolution.ts` already collapses `continue`/`继续`/`go on`/`resume`
  onto the previous goal) **resumes the same task from the checkpoint** with a
  fresh `maxSteps` budget, instead of a cold restart. The manual "go on"
  trigger stays — only max-steps-bounded turns become resumable, preserving
  the human checkpoint that `maxSteps` exists to provide.

## Consequences

- The `model boom` test passes (exit 1 + friendly message); headless `ask`
  correctly signals failure on a 500.
- Max-steps output is a faithful, local progress summary with an explicit
  "go on to continue" prompt — no leaked tool-call HTML, no dependency on a
  fragile `tools: []` synthesis call.
- "go on" after a limit makes forward progress instead of re-running 40 steps.
- `maxSteps` remains the automatic safety stop for headless runs.

## Non-goals / deferred

- Adaptive or token/wall-clock budgets as an alternative bound (Q5 option C) —
  not adopted; `maxSteps` stays.
- Changing `TurnStatus`/`SessionStatus` semantics to `interrupted` for the
  limit (Q6 option C) — deferred; resume is carried via a resumable flag
  rather than a status change.
- Injecting a "you hit the limit" system message into the next turn — declined
  (Q11 option B); checkpoint + real history suffice.

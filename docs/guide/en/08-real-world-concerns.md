# 8. Real-world Concerns (advanced)

A toy agent loops and calls tools. A *usable* agent also handles the things that go wrong. This
chapter covers three guards already present in `runTurn` (`src/agent/runner.ts`). None is large; all
are the difference between a demo and something you can actually run.

## Interruption

Long agent runs should be cancelable. `runTurn` checks an interrupt controller at the top of every
step and after each tool:

```ts
interruptController?.throwIfInterrupted();
```

When the user presses escape, the controller throws a `TurnInterruptedError`. The loop catches it and
calls `finishInterruptedTurn`, which **checkpoints** the work gathered so far
(`context.appendRecoveryMessages`) and returns:

```ts
{
  completionStatus: "interrupted",
  outputText: null,
  toolExecutions,   // everything done so far is preserved
  ...
}
```

No work is lost — the next turn can resume from the checkpoint. This is why the loop threads an
`interruptController` through the model call and every tool execution.

## Verification reminder

After editing files, an agent should check its work. SigPi tracks this with two small sets:

```ts
const MUTATING_TOOL_NAMES = new Set(["write", "edit"]);
const VERIFICATION_TOOL_NAMES = new Set(["bash"]);

if (MUTATING_TOOL_NAMES.has(toolCall.name) && result.ok) {
  needsVerification = true;
} else if (needsVerification && VERIFICATION_TOOL_NAMES.has(toolCall.name)) {
  needsVerification = false;
}
```

When the turn reaches a final answer and `enableVerificationReminder` is on, the runner injects a
reminder telling the model to run a narrow verification command before finishing. **Note the flag
defaults to `false`** — the mechanism exists and is wired, but is opt-in. That is intentional: it
shows the pattern without forcing behavior you may not want.

## Max-steps synthesis

`maxSteps` (default 8) bounds the loop. If it is exhausted without a final answer, SigPi does not
just give up:

```ts
const response = await this.provider.generate({
  messages: [...workingMessages, createSystemMessage(MAX_STEPS_SYNTHESIS_PROMPT)],
  tools: [],
  ...
});
```

The synthesis prompt tells the model to stop requesting tools and answer from what it already
gathered. If even that fails or returns garbage (e.g. leftover tool-call markup),
`buildMaxStepsFallbackAnswer` produces a language-neutral summary of the goal and the tool results
collected — so the user always gets something coherent instead of a crash.

## Key takeaways

- **Interrupt** is a checked signal at every step/tool, with a checkpoint so no work is lost.
- **Verification** is a tiny state flag (mutating tool done → expect a bash check) behind an opt-in
  flag.
- **Max-steps** is a hard bound plus a graceful synthesis fallback.
- Each guard is a few dozen lines. The lesson: agent robustness is mostly a handful of small,
  explicit checks — not a framework.

Next: [Higher-level: TUI / skills / plan-tracker / background](./09-higher-level.md).

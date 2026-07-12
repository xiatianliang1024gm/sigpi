# 2. The Agent Loop

> Anchor file: `src/agent/runner.ts` → `AgentRunner.runTurn()`.
> If you read nothing else, read this method.

## The big picture

A "turn" is one user message and the agent's complete response to it. A turn is **not**
a single model call. It is a loop:

```
user input
   │
   ▼
┌─────────────────────────────────────────────┐
│  LOOP (up to maxSteps times)                 │
│                                              │
│  1. send working context ──►  LLM            │
│  2. did the model ask for tools?             │
│        │ yes ──► run each tool, feed result  │
│        │         back, LOOP again            │
│        └ no  ──► this is the final answer    │
│                                              │
└─────────────────────────────────────────────┘
   │
   ▼
final answer  +  persist context
```

That is the entire skeleton of an agent. Everything else in this guide is detail layered
onto these few lines.

## Entry point

```ts
async runTurn(
  userInput: string,
  interruptController?: TurnInterruptController,
): Promise<RunTurnResult>
```

Inside, the first thing that happens is building the **working context**:

```ts
const workingMessages = this.context.buildMessages(this.systemPrompt, userInput);
const turnMessages: Message[] = [createUserMessage(userInput)];
```

Two lists, two jobs:

- **`workingMessages`** — what is *actually sent to the model*: system prompt + saved summary
  + recent messages + this turn's transcript. This is the model's window.
- **`turnMessages`** — this turn's transcript *only* (user → assistant → tool results). It is
  what gets checkpointed and persisted at the end. Keeping it separate means the model sees a
  rich window while the saved context stays clean.

It also resolves the **current goal** up front:

```ts
const currentGoal = resolveCurrentGoal(userInput, {
  summary: this.context.getSummary(),
  keyFindings: this.context.getExplorationLedger().keyFindings,
  recentMessages: this.context.getRecentMessages(),
});
```

`resolveCurrentGoal` collapses vague continuations ("continue", "go on") back onto the real
goal from the saved summary, so the loop always knows what it is really doing.

## The loop

```ts
for (let step = 1; step <= this.options.maxSteps; step += 1) {
  interruptController?.throwIfInterrupted();
  const response = await this.provider.generate({
    messages: workingMessages,
    tools: this.tools.getSchemas(),
    temperature: this.options.temperature,   // 0.2
    maxTokens: this.options.maxTokens,
    context: { runId, sessionId, turnId, step, purpose: "turn" },
    abortSignal: interruptController?.getAbortSignal(),
  });
  ...
}
```

`maxSteps` (default **8**) is the hard ceiling. Without it, a confused agent could call tools
forever and burn tokens. When the ceiling is hit, the loop does **not** just stop — it asks the
model once more to *synthesize* a best-effort answer from what it gathered (see
[Max-steps & synthesis](#max-steps--synthesis) below).

## Branch A — the model returned tool calls

```ts
if (response.toolCalls.length > 0) {
  const assistantMessage = createAssistantMessage(response.assistantText, response.toolCalls);
  workingMessages.push(assistantMessage);
  turnMessages.push(assistantMessage);

  for (const toolCall of response.toolCalls) {
    // 1. dedup check
    // 2. execute
    // 3. feed result back
  }
  await maybeCompactWorkingMessages();
  continue;   // ← back to the top of the loop
}
```

For each tool call, three things happen in order.

### 1. Deduplication (don't repeat yourself)

Before executing, the runner checks whether an *equivalent* call already happened recently in
this turn:

```ts
const duplicate = findRecentDuplicateToolCall(toolCall, turnMessages);
if (duplicate) {
  const dedupResult = buildDuplicateToolCallResult({ toolName, stepsBack });
  // pushed as a tool result WITHOUT executing the tool again
  continue;
}
```

`findRecentDuplicateToolCall` normalizes the call (sorts argument keys, lowercases/trims string
arguments) and looks back over the last `DEDUP_WINDOW` (**6**) assistant messages. If it finds a
match it returns a synthetic "you already did this" result instead of running the tool a second
time. This is how SigPi avoids the classic agent failure mode of calling `read` on the same file
in a tight loop. Note `read`, `write`, `edit`, and `bash` are *excluded* from dedup
(`DEDUP_SKIPPED_TOOL_NAMES`) — re-reading or re-running a command is often intentional.

### 2. Execution

```ts
const result = await this.tools.execute(toolCall, {
  cwd: this.options.workingDirectory,
  logger, runId, sessionId, turnId,
  abortSignal: interruptController?.getAbortSignal(),
  allowedReadRoots: this.options.allowedReadRoots,
  bash: this.options.bashToolContext,
});
```

`tools.execute` dispatches by name through the `ToolRegistry` to a built-in tool. The result is
recorded both in `toolExecutions` (for the turn summary) and in `context.recordToolExecution`
(so the context layer can update its exploration ledger).

### 3. Feeding the result back

```ts
const toolMessage = createToolMessage(toolCall.id, toolCall.name, result);
workingMessages.push(toolMessage);   // model sees it next iteration
turnMessages.push(toolMessage);      // saved with the turn
```

The result becomes the next model input. **This is the whole loop**: tool output goes back into
`workingMessages`, the loop calls the model again, and the model decides whether it now has
enough to answer or needs another tool.

### Verification tracking

After a tool runs, the runner tracks a small state flag:

```ts
if (MUTATING_TOOL_NAMES.has(toolCall.name) && result.ok) {
  needsVerification = true;          // write/edit succeeded
} else if (needsVerification && VERIFICATION_TOOL_NAMES.has(toolCall.name)) {
  needsVerification = false;         // a bash command ran afterwards
}
```

`MUTATING_TOOL_NAMES = {write, edit}`, `VERIFICATION_TOOL_NAMES = {bash}`. The idea: if the agent
edited files, it should (when verification reminders are enabled) run a command to check its work
before declaring done. This is a small, real safeguard against "the agent said it finished but
never verified."

## Branch B — the model returned a final answer

```ts
const outputText = response.assistantText?.trim() || "No response generated.";
const assistantMessage = createAssistantMessage(outputText);
turnMessages.push(assistantMessage);

const contextUpdated = await this.context.appendMessages(
  turnMessages, this.provider, this.systemPrompt, this.toolSchemas,
  { turnId }, { usage: response.usage },
);

return {
  completionStatus: "completed",
  outputText,
  steps: step,
  toolExecutions,
  contextSummary: this.context.getSummary(),
  contextMessageCount: this.context.getRecentMessages().length,
  contextUpdated,
  ...
};
```

When there are no tool calls, the turn is finished. The transcript (`turnMessages`) is handed to
`context.appendMessages`, which persists it and may **compact** it (summarize older messages) to
stay within the token budget. See [Context Management](./04-context-management.md).

## Max-steps & synthesis

If the loop exhausts `maxSteps` without a final answer, SigPi makes one last attempt:

```ts
const response = await this.provider.generate({
  messages: [...workingMessages, createSystemMessage(MAX_STEPS_SYNTHESIS_PROMPT)],
  tools: [],
  ...
});
```

The synthesis prompt tells the model to stop requesting tools and answer from what it already has.
If even that fails or returns garbage, `buildMaxStepsFallbackAnswer` produces a language-neutral
summary of the goal and the tool results gathered so far, so the user always gets *something*
coherent rather than a crash.

## In-turn checkpoint compaction

During a long turn, `workingMessages` can itself grow past the budget. `maybeCompactWorkingMessages()`
watches the estimated token count and, when it exceeds `contextWindow - reserveTokens`, summarizes
the *early part* of the turn into a checkpoint, keeps only the last `TURN_CHECKPOINT_KEEP_LAST_MESSAGES`
(**4**) messages, and rebuilds `workingMessages` with the checkpoint prepended. The model therefore
keeps working on a long task without losing the thread. (Full context management is covered in the
next chapter.)

## Interruption

`interruptController?.throwIfInterrupted()` is checked at the top of every step and after each tool.
If the user presses escape, the current state is **checkpointed** (not lost) and the turn returns
`completionStatus: "interrupted"` with everything gathered so far. Interruption is covered in
[Real-world Concerns](./08-real-world-concerns.md).

## Key takeaways

- A turn is a **loop**, bounded by `maxSteps`, not a single call.
- Two message lists: `workingMessages` (model's window) vs `turnMessages` (this turn's transcript).
- The loop is driven entirely by whether the model returns `toolCalls`.
- Real safeguards are already present: **dedup**, **verification tracking**, **in-turn
  checkpoint**, **max-steps synthesis**, and **interruption**. None of these are "framework magic" —
  they are a few dozen lines each, and you just read all of them.

Next: [Function Calling](./03-function-calling.md) — what a `toolCall` actually is and how the
model is invited to produce one.

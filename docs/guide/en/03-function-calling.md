# 3. Function Calling

In the [Agent Loop](./02-agent-loop.md) we saw the model return `toolCalls`. This chapter explains
what a tool call *is*, how the model is invited to make one, and how the result comes back.

## The shape of a tool

A tool is described to the model with a JSON schema — a name, a description, and a parameters
schema:

```ts
interface ToolSchema {
  name: string;
  description: string;
  parameters: JSONSchema;   // the arguments the model may fill in
}
```

`ToolRegistry.getSchemas()` returns one of these per built-in tool. Examples in
`src/tools/builtin/`:

| Tool | Purpose |
|------|---------|
| `read` | read a file (with range/offset) |
| `grep` | search file contents |
| `glob` | find files by pattern |
| `edit` | apply a targeted edit |
| `write` | create/overwrite a file |
| `bash` | run a shell command |

The schemas are attached to **every** model request (`tools: this.tools.getSchemas()` in the loop),
so the model always knows what it can do.

## The model decides

The model reads the schemas and the conversation, and *chooses* whether to call a tool. SigPi
never calls a tool itself — it only forwards what the model asked for. This is the crucial
separation: **the model is the brain, the tools are the hands.** SigPi's job is to carry the
model's intent to the hands and bring the result back.

When the model wants a tool, it returns a `toolCall`:

```ts
interface ToolCall {
  id: string;        // correlates the call with its result
  name: string;      // which tool
  arguments: unknown;// the JSON the model filled in
}
```

## Dispatch

Back in the loop, each `toolCall` is executed by name:

```ts
const result = await this.tools.execute(toolCall, {
  cwd, logger, runId, sessionId, turnId, abortSignal,
  allowedReadRoots, bash: this.options.bashToolContext,
});
```

`ToolRegistry.execute` looks the tool up by `name` and runs it. The result has a uniform shape:

```ts
interface ToolExecutionResult {
  ok: boolean;
  data?: unknown;        // structured result for the model
  details?: unknown;     // extra detail
  error?: string;        // present when ok === false
}
```

Uniformity matters: every tool, regardless of what it does, returns the same `ToolExecutionResult`.
That is why the loop can treat all tools identically — dedup, recording, and rendering need no
per-tool code.

## Rendering the result back

The result becomes a tool message:

```ts
const toolMessage = createToolMessage(toolCall.id, toolCall.name, result);
workingMessages.push(toolMessage);
turnMessages.push(toolMessage);
```

The model sees its own `toolCall.id` matched to the result, which is exactly the shape an
OpenAI-compatible API expects (`tool` role messages referencing the call id). How that message is
serialized onto the wire (chat-completions vs responses) is the adapter's job — see
[Model Adapters](./06-model-adapters.md).

## Why this is "function calling"

The phrase just means: **the model emits a structured request to run a named function with
arguments, and the host executes it and returns the output.** Strip away the framing and it is:

```
schema in  ──►  model  ──►  {name, arguments}  ──►  execute  ──►  result  ──►  back in
```

That is the entire mechanism. The loop in Chapter 2 is what turns one such round-trip into a
multi-step task.

## A note on safety

Tools are powerful — `bash` and `write` can change your system. SigPi scopes this with:

- `allowedReadRoots` — restricts where read tools may look.
- `bashToolContext` — carries the working directory and an output directory for command results.
- The **verification tracking** flag from Chapter 2 (`MUTATING_TOOL_NAMES` / `VERIFICATION_TOOL_NAMES`),
  which nudges the agent to check its work after edits.

None of these replace real sandboxing, but they show the shape of the concern every agent must
address.

Next: [Context Management](./04-context-management.md) — what happens when the conversation
(out tool results included) grows past the model's token limit.

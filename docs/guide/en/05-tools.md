# 5. Tools & ToolRegistry (advanced)

Chapter 3 showed the *concept* of function calling. This chapter shows the *machinery*:
`ToolRegistry` (`src/tools/registry.ts`), the uniform result type, and the built-in tools.

## The registry is a dispatch table

Tools are registered once at startup (`createDefaultToolRegistry` in `runtime.ts`). The registry
exposes two things the loop needs:

```ts
getSchemas(): ToolSchema[]      // what the model sees (OpenAI-style tool schemas)
execute(toolCall, context)      // run a tool by name
```

`getSchemas` maps each tool to `{ type: "function", function: { name, description, parameters } }`
— exactly the shape the model API expects. So "what tools exist" is a single array, and adding a
tool means registering one definition.

## A tool definition

```ts
interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;        // shown to the model
  inputSchema: ZodType;          // validated at runtime
  execute(args, context): ...;   // does the work
  describeProgress?(args): {...} // for progress reporting
  recordLedger?(recorder, call, result): void; // updates the exploration ledger
}
```

Note the **two schemas**: `parameters` is a JSON schema the *model* reads to decide how to call the
tool; `inputSchema` is a Zod schema SigPi uses to *validate* the model's arguments before executing.
The model is not trusted — arguments are validated at the boundary.

## Execution is defensive

`execute` never assumes the model behaved. It checks, in order:

1. **Abort** — if the turn was interrupted, throw immediately (see [Chapter 8](./08-real-world-concerns.md)).
2. **Parse error** — if the arguments could not even be parsed as JSON (`toolCall.argumentParseError`),
   return `ok: false` with the reason. No execution.
3. **Unknown tool** — if the name is not registered, return `ok: false`.
4. **Schema validation** — `inputSchema.safeParse(args)`; on failure return `ok: false` with the
   specific issues (`path: message`). The model gets a precise, fixable error.
5. **Run** — `tool.execute(validArgs, context)`; wrap the result as `ok: true, data`.
6. **Tool error** — if the tool throws `ToolExecutionError` (or any error), return `ok: false` with
   the message instead of crashing the turn.

Every branch returns a `ToolExecutionResult` — **the loop never sees a thrown error from a tool.**
That uniformity is why the agent loop in Chapter 2 can treat all tools identically.

## Built-in tools

`src/tools/builtin/`:

| Tool | Role |
|------|------|
| `read` | read a file (range/offset) |
| `grep` | search contents |
| `glob` | find files by pattern |
| `edit` | targeted edit |
| `write` | create/overwrite |
| `bash` | run a shell command |
| `update_plan` | update the plan tracker state |

## Deduplication and the ledger

Two loop-level behaviors touch the registry:

- **Dedup** lives in the runner (Chapter 2): equivalent repeated calls are short-circuited *before*
  `execute` is even called.
- **Ledger recording**: after a successful execution, `context.recordToolExecution` calls
  `registry.recordLedger`, which invokes the tool's optional `recordLedger` adapter so the
  exploration ledger (Chapter 4) learns what was searched/read/changed.

## Key takeaways

- The registry decouples "which tools exist" from "how the loop runs them."
- Tools are described to the model with JSON schema and validated with Zod — **distrust the model's
  arguments**.
- Tools fail gracefully into `ok: false`; the turn continues instead of crashing.
- Adding a tool is one registration; everything else (schemas, dispatch, validation, recording) is
  reused.

Next: [Model Adapters](./06-model-adapters.md).

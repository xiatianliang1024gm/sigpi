# 1. Overview

## What SigPi is

SigPi is a **readable, real-world agent reference implementation** written in TypeScript.
It is not a toy and not a framework. It is a complete, working agent — loop, tool use, and
context management all included — written so you can read it line by line.

The three ideas it makes concrete:

- **Agent loop** — a turn is not one model call; it is a loop that calls the model, may get
  tool calls back, runs them, feeds the results in, and repeats until there is a final answer.
- **Function calling** — the mechanism by which the model decides to invoke a tool, and how
  the result comes back into the conversation.
- **Context management** — the working context (system prompt + history + tool results) has a
  hard token limit, so older material is summarized to make room.

If you understand those three, you understand the skeleton every production agent shares.

## How to run it

See the root [README](../README.md) for the full quickstart. In short:

```bash
pnpm install
pnpm dev init          # writes ~/.sigpi/config.toml
# edit ~/.sigpi/config.toml with your model endpoint, api key, and model name
pnpm dev chat          # interactive session
pnpm dev ask "..."     # one-off question
```

## The source layout

SigPi is roughly 80 source files, but the teaching core is small. The files that matter
for understanding the agent are:

| Path | Role |
|------|------|
| `src/agent/runner.ts` | **The agent loop.** `runTurn()` is the spine of everything. |
| `src/agent/context.ts` | Owns the working context: summary, recent messages, compaction. |
| `src/agent/messages.ts` | Message/tool-call constructors and the transcript rendering used for summaries. |
| `src/model/openai-compatible.ts` | The model provider: HTTP transport + wire-format adapters. |
| `src/tools/registry.ts` | Dispatches tool calls to built-in tools. |
| `src/tools/builtin/*.ts` | The built-in tools: `read`, `grep`, `glob`, `edit`, `write`, `bash`, … |
| `src/runtime.ts` | Wires everything together for one session. |
| `src/types.ts` | The shared types (`Message`, `ToolCall`, `ModelProvider`, …). |

Everything else — TUI, skills, plan tracking, session storage, background tasks — is built
*on top* of this core and is covered in the later (advanced / higher-level) chapters.

## What you will learn

By the end of this guide you should be able to answer, from the code:

- What happens between typing a message and getting an answer?
- Why does the agent sometimes call a tool, and sometimes stop?
- How does it avoid calling the same tool twice, or running forever?
- What happens when the context gets too big?
- How is a conversation saved and resumed?

Start with [The Agent Loop](./02-agent-loop.md).

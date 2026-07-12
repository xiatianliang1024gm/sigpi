# SigPi Guide (English)

This guide explains **how SigPi is implemented**, not just how to use it. It is written
for developers who already write code and want to understand what an agent actually is
under the hood: how it talks to an LLM, how it calls tools, and how the loop keeps running.

Read it in order. Every chapter builds on the one before it, and the whole guide is
anchored on a single file: **`src/agent/runner.ts`** and its `runTurn()` method. If you
only read one file in this repository, read that one.

## Reading path

1. [Overview](./01-overview.md) — what SigPi is and how to run it
2. **[The Agent Loop](./02-agent-loop.md)** ← start here; an annotated walkthrough of `runTurn()`
3. [Function Calling](./03-function-calling.md) — how the model drives tools
4. [Context Management](./04-context-management.md) — staying inside the token budget
5. [Tools & ToolRegistry](./05-tools.md) — the built-in tools (advanced)
6. [Model Adapters](./06-model-adapters.md) — chat-completions vs responses (advanced)
7. [Session & Persistence](./07-session.md) — saving and resuming (advanced)
8. [Real-world Concerns](./08-real-world-concerns.md) — interrupt, verification, max-steps (advanced)
9. [Higher-level: TUI / skills / plan-tracker / background](./09-higher-level.md) — features built on top (higher-level)

For the quickstart (install, configure your model, run chat), see the root
[README](../README.md). This guide assumes you have already done that.

> Conventions: when we point at code we use `path:line` style references. SigPi is small
> enough that you can open the file and read along.

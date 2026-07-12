# 1. 概览

## SigPi 是什么

SigPi 是一个**可读的真实世界 agent 参考实现**，用 TypeScript 写成。它既不是玩具，也不是框架，
而是一个完整、能跑的 agent——循环、工具调用、上下文管理一应俱全——并且写得让你能逐行读懂。

它要讲清楚的三个概念是：

- **Agent loop（代理循环）** — 一轮（turn）不是一次模型调用，而是一个循环：调用模型 → 可能拿回
  工具调用 → 执行它们 → 把结果喂回去 → 重复，直到出现最终答案。
- **Function calling（函数调用）** — 模型决定调用某个工具的机制，以及结果如何回到对话中。
- **Context management（上下文管理）** — 工作上下文（系统提示 + 历史 + 工具结果）有硬性 token 上限，
  所以更早的内容会被摘要以腾出空间。

理解这三样，你就理解了每个生产级 agent 共有的骨架。

## 怎么跑

完整快速开始见根目录 [README](../README.md)。简而言之：

```bash
pnpm install
pnpm dev init          # 写入 ~/.sigpi/config.toml
# 编辑 ~/.sigpi/config.toml，填你的模型 endpoint、api key、model name
pnpm dev chat          # 交互式会话
pnpm dev ask "..."     # 一次性提问
```

## 源码布局

SigPi 约 80 个源文件，但教学核心很小。理解 agent 真正要看的文件是：

| 路径 | 角色 |
|------|------|
| `src/agent/runner.ts` | **Agent loop。** `runTurn()` 是一切的 spine。 |
| `src/agent/context.ts` | 持有工作上下文：摘要、近期消息、压缩（compaction）。 |
| `src/agent/messages.ts` | 消息/工具调用的构造，以及用于摘要的转录渲染。 |
| `src/model/openai-compatible.ts` | 模型 provider：HTTP transport + 线格式适配器。 |
| `src/tools/registry.ts` | 把工具调用派发到内置工具。 |
| `src/tools/builtin/*.ts` | 内置工具：`read`、`grep`、`glob`、`edit`、`write`、`bash` 等。 |
| `src/runtime.ts` | 为一次会话把所有东西装配起来。 |
| `src/types.ts` | 共享类型（`Message`、`ToolCall`、`ModelProvider` 等）。 |

其余一切——TUI、skills、plan tracking、会话存储、后台任务——都**建在**这个核心之上，在后面的
（进阶 / 更高阶）章节讲解。

## 你会学到什么

读完本指南，你应该能从代码回答：

- 从敲下一条消息到拿到答案，中间发生了什么？
- 为什么 agent 有时调用工具，有时停下？
- 它如何避免重复调用同一个工具、或无限跑下去？
- 上下文太大时会发生什么？
- 一次对话如何被保存和续接？

从 [Agent Loop](./02-agent-loop.md) 开始。

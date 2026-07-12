# SigPi 指南（中文）

本指南讲解 **SigPi 是如何实现的**，而不只是怎么用它。它面向已经会写代码、想理解 agent
内部机制的人：它如何与大语言模型交互、如何调用工具、循环究竟是怎么跑起来的。

请按顺序阅读。每一章都建立在前一章之上，整本指南锚定在同一个文件上：**`src/agent/runner.ts`**
及其 `runTurn()` 方法。如果整个仓库你只读一个文件，就读它。

## 阅读路径

1. [概览](./01-overview.md) — SigPi 是什么、怎么跑起来
2. **[Agent Loop](./02-agent-loop.md)** ← 从这里开始；`runTurn()` 的注释式走读
3. [Function Calling](./03-function-calling.md) — 模型如何驱动工具
4. [上下文管理](./04-context-management.md) — 如何待在 token 预算内
5. [工具与 ToolRegistry](./05-tools.md) — 内置工具（进阶）
6. [模型适配器](./06-model-adapters.md) — chat-completions 与 responses（进阶）
7. [会话与持久化](./07-session.md) — 保存与续接（进阶）
8. [真实世界的考量](./08-real-world-concerns.md) — 中断 / 验证提醒 / max-steps（进阶）
9. [更高阶：TUI / skills / plan-tracker / background](./09-higher-level.md) — 建在 agent 之上的功能（更高阶）

快速开始（安装、配置模型、运行对话）见根目录 [README](../README.md)。本指南假设你已完成那一步。

> 约定：引用代码时用 `路径:行号` 风格。SigPi 足够小，你可以打开文件边读边对照。

# 4. Context Management（上下文管理）

agent 循环产生消息。尤其是工具结果，可能很大。放任不管，工作上下文会一直增长，直到超出模型的
token 上限、请求失败。**上下文管理**就是 SigPi 如何待在预算内、又不丢失对话。

## 三件套方案

SigPi 用三个协同的部分把工作上下文控制在 token 窗口内：

1. **摘要（Summary）** — 对更早内容的滚动压缩。
2. **近期消息（Recent messages）** — 模型必须逐字看到的尾部。
3. **轮内 checkpoint** — 当*当前*轮过长时对其压缩（见[第二章](./02-agent-loop.md#轮内-checkpoint-压缩)）。

这三者的所有者都是 `ConversationContext`（`src/agent/context.ts`）。

## 压缩（Compaction）：留出空间

一轮结束时调用 `appendMessages`，上下文会把估计 token 数与预算（`hard_context_limit - reserveTokens`）
比较。若超出，它就**压缩**：

- 更早的近期消息通过一次模型调用（摘要）折叠进**摘要**。
- 近期消息尾部被裁剪到 `keepRecentTokens`。

这就是为什么循环能跑很多步、很多轮：过去被持续压缩进摘要，只有重要的近期窗口保持逐字。

两种触发：

- **Token 触发** — 运行估计越过预算（常见情况）。
- **强制** — 显式的 `/compact` 命令主动要求。

若压缩本身失败（如摘要器报错），SigPi 优雅降级：它裁剪而非抛错，于是本轮仍能完成。见
`runTurn` 里对 `CompactionFailedError` 的处理。

## 为什么是「摘要」而不是「截断」

截断最老的消息会静默丢失信息。摘要则以压缩形式保留*学到的东西*，于是模型仍拥有早先探索的要点。
区别在于「我们忘了开头」与「我们简短地记得开头」。

## 探索 ledger

重复探索同一个文件是经典的浪费。除摘要外，上下文还持有一个**探索 ledger**
（`src/agent/exploration-ledger.ts`）：记录了已搜索、已读、已改、已发现的结构化记录。关键发现
被注入回工作上下文，于是模型更不容易重做已经做过的事。

这是个小而真实的教训：生产级 agent 管理的不仅是*token*，更是*知识*——记住自己已知的东西，
以免烧掉步骤去重新发现。

## 你会看到的数字

来自 `runTurn` 与上下文选项：

- `hard_context_limit` — 模型的总 token 预算（按模型配置；默认 `200_000`）。
- `reserveTokens` — 为下一次请求保留的余量（按模型配置）。
- `keepRecentTokens` — 多少近期尾部保持逐字（按模型配置）。
- `TURN_CHECKPOINT_KEEP_LAST_MESSAGES = 4` — 轮内 checkpoint 保留几条消息。
- `DEDUP_WINDOW = 6` — 工具调用去重向后看多远（第二章）。

这些都是旋钮，不是魔法。调它们，你直接权衡成本、记忆与质量。

## 关键收获

- 循环产生消息；上下文管理把它们控制在 token 预算内。
- **摘要 + 近期消息 + 轮内 checkpoint** 就是整套方案。
- 压缩是「摘要」而非「截断」，以保留已学信息。
- 探索 ledger 对抗重复探索——管理的是*知识*，不止是*token*。

**核心三件套**到此讲完：循环、函数调用、上下文管理。之后都是进阶或更高阶内容。

下一步：[工具与 ToolRegistry](./05-tools.md)。

# 架构决策记录 (Architecture Decision Records)

本目录记录 SigPi 的架构决策。每条记录聚焦**一个**决策，使用统一模板：

- **状态**：决策的当前状态（通常为「已接受」）。
- **背景与问题**：为什么现在要做这个决策、要解决的痛点。
- **考虑过的方案**：评估过的替代方案，含被否决者及其原因。
- **决策结果**：最终选择的方案。
- **后果**：带来的好处、刻意的取舍、行为变化、测试覆盖。

这些记录使用 codebase-design 的词汇：**模块 (module)**、**接口 (interface)**、
**深度 (depth)**、**seam**、**leverage**、**locality**，不引入
component / service / API / boundary 等词。

## 本轮架构评审 pass（2026-07-12）

以下四条决策来自同一次「架构评审 → 找出深化机会 → 逐条 grill + 实现」的 pass，
共享同一组约束：

- 内部 seam 只为隔离复杂度而存在，**不因测试而外泄内部细节**；
- 行为保持不变（除非显式记录差异）；
- 每次提交都满足 `biome` + `tsc` 干净、全量测试通过。

| 编号 | 标题 | 提交 | 一句话 |
|------|------|------|--------|
| [0001](./0001-conversation-context-commit-seam.md) | 折叠会话存储生命周期方法的提交脚手架到私有 commit seam | `6986d53` | 五个方法的「写 session + 写 index」尾部折叠进私有 `commit()` |
| [0002](./0002-config-alias-table.md) | 用单一别名表统一 TOML 与运行时配置字段名 | `5d5a808` | TOML↔运行时双向映射改为单一 `CONFIG_ALIASES` 来源 |
| [0003](./0003-conversation-summarizer-module.md) | 抽出 ConversationSummarizer 作为独立深层模块 | `e3e4e6c` | 提示词拼装/provider 调用/抽取/判错从无状态上下文抽成 `summarize()` |
| [0004](./0004-entry-stream-single-owner.md) | entry stream 单一所有者 | `db809cd` | `resolveEntriesForPersist` 收敛为单一合成 seam，`ConversationContext` 为唯一所有者 |

## SSE 流式响应 pass（2026-07-12）

为缓解「大响应易超时」，将模型请求改为流式 SSE + idle/stall 超时。以下三条决策来自同一次
`/grilling` 会话（grill-with-docs），共享同一组约束：

- 下游消费方契约不变（transport 流式增量读，仍返回完整 `ModelResponse`）；
- transport 保持格式无关，delta 形状知识留在 adapter；
- 行为稳健优先于实现简洁。

| 编号 | 标题 | 提交 | 一句话 |
|------|------|------|--------|
| [0005](./0005-idle-stall-timeout.md) | idle/stall 超时替代总时长死线 | `37f7373` | 单计时器每帧重置，覆盖首字节与中途静默，不再误杀长但稳的响应 |
| [0006](./0006-streaming-unconditional-with-optout.md) | 流式在 transport 无条件开启 + per-model `stream` opt-out + 单段 JSON 容错 | `37f7373` | 因拒绝型 provider 约束，从「不加配置」反转为最小 `stream` 开关 |
| [0007](./0007-both-adapters-delta-folding.md) | 两 adapter 均纯 delta 折叠，`responses` 不依赖 `response.completed` | `37f7373` | 选鲁棒性，否决 `response.completed` 完整 payload 极简捷径 |

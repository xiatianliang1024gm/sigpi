# 0003 — 抽出 ConversationSummarizer 作为独立深层模块

- **状态**：已接受
- **日期**：2026-07-12
- **提交**：`e3e4e6c`

## 背景与问题

`src/agent/context.ts` 约 1079 行，承载了会话上下文的全部职责。其中
compaction 的**摘要生成**相关逻辑被内联在 `ConversationContext` 里：提示词拼装、
`provider.generate` 调用、`extractSummaryFromResponse` 抽取、以及「截断 /
空响应 → `CompactionFailedError`」的判定。

这带来两个问题：

- **深度不足**：摘要生成的全部知识（提示词结构、`summaryMaxTokens` 的预算算法、
  抽取规则）和上下文的「何时触发 compaction」混在一起，模块接口模糊。
- **leverage 低、难测**：提示词 bug 只能走完整的 `compact()` 路径、配合真模型
  才能触达，无法用假 provider 单独验证「提示词是否包含 transcript / 上一份
  summary / exploration ledger」「预算是否按 `reserveTokens` 与 `provider.maxTokens`
  计算」「截断与空响应是否上抛对应错误」。

compaction 的**触发逻辑**（split index、token 阈值、hard-limit trim）属于
`ConversationContext`，应保留。

## 考虑过的方案

1. **抽成无状态 `summarize(provider, args)` 函数 + 新模块** `src/agent/summarizer.ts`
   （采用）。模块拥有上述全部摘要生成行为；上下文退化为薄调用方。
2. 让新的 summarizer 模块也吸收 `microCompactMessages`（先 micro-compact 再摘要）。
   - 否决：`microCompactMessages` 同时被 `buildMessages`（上下文自己）使用；
     若迁入 summarizer，summarizer 就得从 `context.ts` 反向 import，引入
     **循环依赖**。改为「调用方在传入前先 `microCompactMessages`」。

## 决策结果

新模块 `src/agent/summarizer.ts`：

- 对外接口是无状态函数：

  ```ts
  export async function summarize(
    provider: ModelProvider,
    args: SummarizeArgs,
  ): Promise<string>;
  ```

  `SummarizeArgs` 含 `systemPrompt / messages`（调用方已 micro-compact）/
  `previousSummary` / `ledger` / `instructions` / `requestContext` /
  `reserveTokens` / `runId` / `sessionId` / `abortSignal`。`provider` 作为首个
  参数，是**显式 seam**（便于假 provider 注入）。

- 模块拥有：提示词组装（transcript + previousSummary + exploration ledger +
  instructions，按有无 `previousSummary` 选择 create / update 提示词）、
  `summaryMaxTokens` sizing（`Math.max(256, min(0.8*reserveTokens,
  provider.maxTokens ?? 2048))`）、`provider.generate` 调用、
  `extractSummaryFromResponse` 抽取、截断 / 空 → `CompactionFailedError`
  （`reason: "truncated"` / `"empty"`）。

- 三份提示词常量（`SUMMARIZATION_PROMPT` / `UPDATE_SUMMARIZATION_PROMPT` /
  `SUMMARIZATION_SYSTEM_PROMPT`）与 `extractSummaryFromResponse` 一并迁入。

`ConversationContext.compact()` 只保留触发逻辑，成为薄调用方：先
`microCompactMessages(messagesToSummarize)`，再 `await summarize(provider, {...})`。

## 后果

- **接口收窄、深度增加**：摘要生成的全部知识收拢到一个可独立推理、可单测的模块。
- **leverage 提升**：新增 `test/summarizer.test.ts`，用 `MockProvider` 直接验证
  提示词组装、token 预算、截断 / 空错误路径与抽取逻辑——这些此前无法越过
  `compact()` 单独测试。
- 原有的 `compactNow` 集成测试仍经 `compact()` 有效，提示词内容断言随常量迁入
  新模块。
- **行为变化（唯一）**：截断不再单独打 `warn` 日志，而是统一由 `compact()` 的
  `context_summarization_failed` 日志覆盖（截断仍被记录，只是不再有独立的
  `truncated` 级日志）。
- biome + tsc 干净，全量 397→（含新测试）通过。

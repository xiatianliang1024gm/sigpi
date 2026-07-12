# 0007 — 两 adapter 均纯 delta 折叠，`responses` 不依赖 `response.completed`

- **状态**：已接受
- **日期**：2026-07-12
- **提交**：`37f7373`

## 背景与问题

SSE 下每帧 `data:` 只是增量 delta，两个 adapter 的 `parse(data)` 仍要求完整响应对象
（见 `WireFormatAdapter`）。`chat_completions` 只有 `delta` 帧 + `[DONE]`，没有「完整事件」；
`responses` API 则发带类型事件流，其中 `response.completed` 通常直接携带**完整 output**。
如何把增量帧折回完整 `ModelResponse`，是两 adapter 都要回答的问题。

## 考虑过的方案

1. **两 adapter 均纯 delta 折叠**（采用）：`chat_completions` 折 `delta`（含按 `index` 拼接
   `tool_calls[].function.arguments` 碎片、区分 `finish_reason`）；`responses` 折
   `response.output_item.delta` 进对应 item / 嵌套 content-part。`response.completed` 可自然
   收尾，但**不作为**组装的唯一来源。
2. `responses` 偷懒：忽略增量，等 `response.completed` 的完整 payload 直接 `parse` 成最终对象：
   accumulator 极简。但这是**单点脆弱**——只要那一个完成事件被丢/被截，或 provider 不忠实重发
   完整 output，整轮就失败。否决。

## 决策结果

两个 adapter 都走 **纯 delta 折叠**：transport 把每帧 `data:` 交给 `adapter.accumulate(frame)`，
流结束（收到 `[DONE]` 或连接关闭且已 ≥1 帧）调 `adapter.finalize()` 取完整 `ModelResponse`。
`responses` 不把 `response.completed` 当作组装来源，只把它视为可能补全折叠的普通事件之一。

## 后果

- **seam 一致**：两 adapter 共用同一套「累加」心智模型，transport 仍只做通用成帧。
- **鲁棒**：provider 漏发/截短 `response.completed` 时只是少折一点，不会整体失败；对缺事件降级
  而非崩。
- **代价**：`responses` 的 item / 嵌套 content-part delta 折叠更复杂，但 OpenAI 规范下可
  tractable 实现。
- 防止未来工程师把 `responses`「简化」成依赖 `response.completed` 而重新引入单点脆弱。

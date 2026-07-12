# 0006 — 流式在 transport 无条件开启 + per-model `stream` opt-out + 单段 JSON 容错

- **状态**：已接受
- **日期**：2026-07-12
- **提交**：`37f7373`

## 背景与问题

要拿到 idle 超时所需的增量字节，transport 必须请求 `stream: true` 并增量读 body。两个 wire
format（`chat_completions`、`responses`）都支持 SSE。但现实存在不支持流式的 provider，分两类：

- **忽略型**：收到 `stream:true` 但无视，回一个普通单段 JSON。
- **拒绝型**：严格校验入参，看到不认识的 `stream` 直接回 HTTP 错误——这是解析器层面无解的，
  必须压根不把 `stream:true` 放进请求体。

## 考虑过的方案

1. **per-model `stream` 布尔（默认 `true`）+ SSE 解析器对单段 JSON 容错**（采用）：拒绝型靠
   `stream=false` opt-out；忽略型靠容错解析器零配置覆盖。
2. 零配置、transport 永远流式、解析器容错单段 JSON：覆盖忽略型，但**兜不住拒绝型**（发了
   `stream:true` 直接 400，无法靠解析救回）。
3. 运行时自动探测：先试流式、遇 400 再退化非流式：白费一次请求，且搅乱现有 retry/backoff
   语义，否决。

## 决策结果

- `ModelConfig` 新增 `stream: boolean`（默认 `true`），加入 `CONFIG_ALIASES` 单一别名表
  （`stream` ↔ `stream`），env 同步 `MODEL_STREAM`（延续 ADR-0002 纪律）。
- `stream=true`（默认）：transport 经 adapter 的 `toRequestBody` 写入 `stream:true`，按 SSE
  成帧读取。
- `stream=false`：transport **不发送** `stream:true`，直接按单段 JSON 读取，完全走旧路径。
- SSE 成帧器**始终**对单段 JSON 容错退化（按 `content-type`/body 形态判断，非 `data:` 事件流
  则当作唯一一帧）。

## 后果

- **存量配置零改动**：默认 `true`，目标 A 的普适治超时不变。
- **拒绝型 provider** 设 `stream=false` 即可接入；**忽略型**零配置。
- 单一别名表仍唯一来源，未破坏 ADR-0002。
- 代价：比「零配置」多一个字段，但被真实 provider 约束逼出、且默认开启不影响存量。

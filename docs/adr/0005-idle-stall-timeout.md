# 0005 — idle/stall 超时替代总时长死线

- **状态**：已接受
- **日期**：2026-07-12
- **提交**：`37f7373`

## 背景与问题

目标：缓解「大响应容易超时」。当前 `ModelTransport.performRequest` 用一个 `setTimeout`
从 `fetch` 发起的同一刻启动，到时直接 abort 整个请求；计时覆盖「连接 + 等首字节 +
下载整段响应体」全部墙钟时间，且收到响应后 `response.text()` 把整个 body 一次性读进内存
才 `parse`。于是「稳定吐字但总量巨大、总时长超过 `timeoutMs`」的响应会被误杀——SSE 本身
不改变总墙钟，只有改超时**语义**才能治本。

## 考虑过的方案

1. **单一 idle/stall 计时器，复用 `timeoutMs`，每帧重置**（采用）：`fetch` 时启动，每收到
   一个 SSE frame 就重置；连续 `timeoutMs` 无字节才 abort。一个计时器同时覆盖「死服务器
   （永远收不到首帧）」与「流中途卡死」。
2. 保留总时长死线、只调大 `timeoutMs`：治标不治本，仍会被真实的慢模型/卡死打挂，且掩盖
   真正挂死的连接。
3. 拆成 connect 超时 + idle 超时两个独立预算：更多旋钮、更多配置面，当前无必要。

## 决策结果

模型请求的超时改为 **idle/stall 超时**：单计时器，`fetch` 发起时启动，每收到一个 SSE frame
（或任一 body chunk）重置；连续 `timeoutMs` 无字节才触发 `timeout`
（`RequestFailureKind: "timeout"`），走现有 retry/backoff。首字节等待也受同一预算约束，
与改前的总死线相比**无回归**。不新增任何超时配置项。

## 后果

- **治好目标**：稳定吐字但总量巨大的响应不再被总时长死线误杀。
- **失去整轮总预算护栏**：一个每 `timeoutMs-1` 毫秒才吐一字节的病理性响应不会触发该计时器；
  但现有 `maxRetries` + agent `maxSteps` 仍兜底，不会无限挂。
- **中途静默超时 → retry**：与今天超时重试行为一致，会重跑一遍推理（多花 token/延迟），
  由 `maxRetries` 上限约束。
- transport 保持格式无关：idle 计时器只看「有无字节」，不关心帧内容。

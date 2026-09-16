# Handover — micro 压缩改造（T1/T2/T3/T6 已完成，未提交）

**状态**：T1（文档同步）、T2（完整压缩触发改到轮首）、T3（省略可见化）、T6（摘要路径 micro 预算一致性）**已实现并通过测试**；
工作集 pinning 与「被取代副本优先丢」两条规则**按决策删除**，并在 ADR 里记为「待考虑，暂不实现」。
**设计记录已落在** `docs/adr/0026-compaction-refactor.md` 的
"Amendment — micro-compaction: turn freeze, a scaled budget, a turn-head trigger, and visible elision"
（A1–A8 小节；术语表见 `CONTEXT.md` 的 **Micro-compaction**）。

> 本文件现在是**剩余工作**的清单，不再复述设计。设计、证据、实测表、被否决方案一律看 ADR 0026 的 amendment。

---

## 1. 本轮做了什么

| 任务 | 结果 |
|---|---|
| 化简 | 删除工作集 pinning（`selectWorkingSetPins` / `workingSetMemberKey` / `workingSetOwnerKey` / `MICRO_COMPACT_MAX_PINNED_TOKENS_PER_TARGET` / `maxPinnedTokensPerTarget`）与「被取代副本优先丢」（rule 4/4b、`SUPERSEDED_TOOL_RESULT_MARKER`、`formatSupersededToolResult`、`retainSupersededCopies`）——理由与实测代价见 ADR A4 |
| T1 | ADR 0026 新增 amendment（A1 证据 / A2 三条规则 / A3 预算缩放与"为什么 30%" / A4 被暂缓的两条规则 / A5 轮首触发 / A6 省略可见化 / A7 回放实测表 / 被否决的低水位与"材料化省略"）；`CONTEXT.md` 更新 **Compaction** 条目并新增 **Micro-compaction** 术语 |
| T2 | `maybeAutoCompactBeforeRequest` 在 `step > 1` 直接返回：token 触发只在轮首生效，轮内只保留 provider `context_length_exceeded` → force → 重试一次 |
| T3 | 新增 `context_elided` 进度事件（`TurnProgressEventMap`）+ `formatElisionMessage`（`src/session/events.ts` 与 `src/server/web/reducer.js` 两个实现必须同步）+ 状态栏标签 `elided`；只在决策变化时上报 |
| T6 | 摘要路径的 micro 预算一致性：把 A3 的比例从 0.3 上调到 **0.6**（`MICRO_COMPACT_KEEP_TOOL_FRACTION = 0.6`，200k 窗口 → 120k），请求路径与摘要路径共用同一个缩放预算；`execute()` 新增 `keepToolTokens` 入参，`ConversationContext.compact()` 按当前窗口求值后传入，取代原先的 flat 32k 默认（ADR A8 已改写，T5 的 0.3/0.4 之争取定为 0.6） |

保留的行为（未动）：最新批次无条件 pin、当前轮冻结、recency + 预算 + floor(3)、按窗口缩放的预算（请求路径与摘要路径同为 0.6 / 下限 8k）、`[context-elided]` 通知文案。

## 2. 验证现状

```bash
pnpm run test:compile && node --test dist/test/*.test.js   # 706 tests / 0 fail / 33 skipped
pnpm exec biome check .                                     # clean
node scripts/micro-compact-replay.mjs                       # ADR A7 的表（已按 0.6 重算）
```

- 新增/改写的用例：轮内不触发摘要、轮内 400 仍 force 补偿、重复读不再被当作"免费冗余"、预算收紧时按 recency 丢最新副本之外的旧副本、`context_elided` 的 TUI/Web 渲染与状态栏标签、runner 端到端省略事件（含"entry 流仍是完整"的断言）、`microCompactToolTokenBudget` 的 0.6 缩放与 8k 下限/32k 回退、`execute` 按传入的 `keepToolTokens` 省略、`compact()` 端到端按窗口缩放摘要预算（窗口收紧时摘要切片被省略，flat 32k 则不会）。受 0.6 影响而被重设窗口的既有用例：`agent-runner` 的省略事件（20k → 13k，锚定 8k 下限）与 `context` 的 placeholder 用例（改用 100k 显式预算）。
- **未做**：真实 API 上的缓存收益验证（需要用户授权花 token），以及 `context_elided` 在真实浏览器/TUI 里的手工确认。

## 3. 剩余任务

编号沿用上一版交接。

### T4 — 源头限流（先评估再改）
降低单轮累积速度：单步 tool 输出聚合上限、`read` 默认页大小、同 `(path,offset,limit)` 且文件未变的重复读**语义**。
数据前提：单步最大 14,866 tokens（2 个结果），0 步 >16k —— 单步聚合不是瓶颈，累积才是。先离线评估（回放脚本已具备）再决定。

### T5 — 预算策略复核（已随 T6 定案为 0.6）
比例已从 30% 上调到 60%（T6，ADR A3/A7 已按新值重算：末次请求 in-turn loss 0、repeat reads 24 → 1）。剩余开放问题仍记在 ADR A3 末尾：**当本轮自身超过预算时，裁剪会一直走到 3-result floor**，存活的是最新几个结果 —— floor 是否应随预算缩放；可在 0.6 预算下用回放表复核。

### T7 — 真实 API 抽样验证（**需要用户同意花 token**）
用一条新 session 对比 `cacheRead/input` 与重复读次数，确认 A7 里的代理指标。用户已明确"要花 token 就不跑"，未获授权前不要执行。

### T8 — 提交与 PR 拆分
建议提交：
1. `feat(compaction): turn freeze + window-scaled tool-result budget + simpler elision policy`
2. `fix(runner): auto-compact only at the turn head`
3. `feat(web,tui): report micro-compaction as a progress event`
4. `feat(read): page explicit ranges and cache repeated reads`
5. `docs(adr): record the micro-compaction amendment and the deferred rules`
6. `test+tooling: policy tests and the offline replay script`

## 4. 关键文件

| 主题 | 文件 |
|---|---|
| micro 压缩策略（全部规则 + 缩放预算） | `src/agent/compaction.ts`（`planMicroCompaction`、预算常量、`microCompactToolTokenBudget`、`execute`） |
| 请求组装 / 预算来源 / 日志 / 省略回调 | `src/agent/context.ts`（`buildMessages`、`protectedToolCallIds`、`reportMicroCompaction`、`compact` 传 `keepToolTokens`） |
| 轮首触发 / 省略事件 / turn id | `src/agent/runner.ts`（`maybeAutoCompactBeforeRequest`、`TurnState.reportElision`、`buildRequestMessages`） |
| 事件类型 | `src/types.ts`（`context_elided`）、`src/session/events.ts`、`src/server/web/reducer.js`、`src/tui/status-bar.ts` |
| 离线回放 | `scripts/micro-compact-replay.mjs` |
| 设计记录 | `docs/adr/0026-compaction-refactor.md`（amendment A1–A8）、`CONTEXT.md` |

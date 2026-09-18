# Handover — web 端 `update_plan` 展示优化（plan bar + plan 面板）

**状态**：**已实现**（2026-09）。实现与分析一致，仅有一处结构偏离，见下方「实现备注」。
**需求**：目前 web 端对 `update_plan` 只显示一行 `⚙ [7/7] 运行 check/lint 与相关测试验证`（完成态 `✓ …`）。
期望：在 web 输入框上方，若有 plan，显示**当前正在执行的 item**（含进度与实时耗时）；点击可查看**完整计划**（每项状态、执行耗时等）。

---

## 实现备注（相对本文的偏离）

- **T3 拆成两个客户端文件**：`plan-fold.js`（纯折叠，`foldPlanEvent` / `planProgress` /
  `itemElapsedMs` / `planTotalMs` / `parsePlanArgs` 移植，**零 DOM**）+ `plan.js`（bar / 面板
  渲染与交互）。理由：`dom.js` 在模块加载时就摸 `document`，单文件的 `plan.js` 无法在
  Node 里直接单测；拆开后 `test/web-plan.test.ts` 可以像 `test/web-reducer.test.ts` 那样
  直接 `import()` 纯模块，无需 jsdom。`events.js` 从两个文件各取所需。
- **`foldPlanEvent(event, now = Date.now())` 返回 `boolean`**（本次是否改变了 plan），
  调用方据此决定是否重绘：`if (foldPlanEvent(event)) renderPlan();`。
- **`fetchPlan()` 在 `connect()` 之后调用**：`connect()` → `disconnect()` → `resetPlan()`，
  先 fetch 会被紧随其后的 reset 清掉。
- 新客户端文件必须同时登记到 `src/server/static.ts` 的 `ASSET_CONTENT_TYPES` 与
  `scripts/copy-assets.mjs`，否则浏览器 404 / 打包缺文件。

---

## 1. 现状链路分析

### 1.1 事件从工具到浏览器

1. **工具定义** `src/tools/builtin/update-plan.ts`
   - `describeProgress(args)` → `{ summary, detail }`：summary 是
     `formatPlanProgressSummaryLine`（`src/plan-tracker.ts`）产出的
     `[n/m] <当前 in_progress item>`（全部完成时为 `All steps completed`）；
     detail 是多行文本（explanation + 带 glyph 的逐项列表）——**web 端目前完全没用 detail**。
   - `execute` 返回 `withRendered({ explanation, updatedAt, plan }, "ok")`：
     structured `data` 里带**完整 plan 数组**（`{step, status}`），`rendered` 只是 `"ok"`。
2. **runner** `src/agent/runner.ts`（`executeToolCalls`，~L706-745）
   - `tool_execution_started`：带 `toolName / toolCallId / arguments / message(=summary)`。
   - `tool_execution_finished`：带 `ok / elapsedMs / result(截断渲染文本) / data(=structured 结果)`。
   - ⇒ **`data.plan` 在 finished 帧里原样到达浏览器**，这是现成的权威数据源。
3. **SSE 传输** `src/server/event-log.ts` + `src/server/sse.ts` + `multi.ts` 的 `handleSessionEvents`
   - 每帧带单调 `seq`；`SessionEventLog` 缓存最近 2048 帧；重连时
     `replayOpenTurn()` 重放**整个未落盘的 open turn**（含 finished 帧及其 `data`）。
   - ⇒ 直播期间（含断线重连）客户端可从 SSE 帧自行折叠出 plan 状态，无需新 push 通道。
4. **web 渲染** `src/server/web/reducer.js`（`applyTurnProgress` 的浏览器移植）+ `transcript.js`
   - `tool_execution_started` → `.tool.running` 行（`⚙ <summary>`）；finish → `✓ <summary>`。
   - 这是用户今天唯一能看到的 plan 信息。`data` 被丢弃。

### 1.2 会话恢复（历史）的数据可用性

- `GET /projects/:key/sessions/:id/messages`（`multi.ts: handleSessionHistory` →
  `history.ts: projectHistoryPage`）只投影 `user / assistant / tool / compaction` 四种 item。
- 持久化的 tool message **只存渲染文本**（`createToolMessage`，`src/agent/messages.ts`：
  `formatToolExecutionResult` → 对 update_plan 就是 `"ok"`），structured `data` **不持久化**。
- 但 assistant message 的 `toolCalls[].arguments` **持久化了完整 plan 入参**
  （`history.ts: collectToolCalls` 已经在全量 entry 流上按 id 索引 toolCalls，先例现成）。
- `MessageEntry.timestamp`（ISO 8601）逐条存在 ⇒ 相邻两次 update_plan 调用的时间差
  可以推导每个 item 的执行耗时。

### 1.3 结论（缺口）

| 缺口 | 补法 |
|---|---|
| 直播中 plan 状态没人收集 | 客户端从 SSE 帧折叠（`update_plan` 的 started/finished） |
| 恢复会话后 plan 无处取 | 新增 `GET .../plan` 端点，服务端扫 entry 流重建 |
| 无 UI | composer 上方 plan bar + 可展开 plan 面板 |

---

## 2. 目标 UI

```
┌─ transcript ──────────────────────────────┐
│  …                                        │
└───────────────────────────────────────────┘
┌─ #plan-bar ───────────────────────────────┐
│ 📋 [7/7] 运行 check/lint 与相关测试验证  3m12s   ▾ │  ← 点击展开
└───────────────────────────────────────────┘
┌─ #error（现状不变）────────────────────────┐
┌─ #composer ───────────────────────────────┐
```

- **plan bar**（单行，常驻）：当前 `in_progress` item 文本 + `[n/m]` 进度 + 已耗时
  （进行中每秒跳动）；全部完成时显示 `📋 全部完成 (n/n) · 总耗时 …`。无 plan 时整个隐藏。
- **plan 面板**（点击 bar 弹出的 popover，位于 bar 上方，复用 `tasks-panel` 的交互模式：
  外点关闭、`hidden` 切换、无 build step）：
  - 逐项列表：状态 glyph（✅/🔄/⬜，沿用 `formatPlanStatusGlyph` 语义）+ step 文本 + 状态
    + 该项耗时（in_progress 项实时跳动）；
  - 底部 meta：`explanation`、`updatedAt`；
  - 列表可滚动（plan 上限 12 项，schema 已限制）。

---

## 3. 设计决策

- **D1 — 数据源：SSE 帧自折叠，不加 push 通道。**
  客户端监听 `tool_execution_started` / `tool_execution_finished`（`toolName === "update_plan"`）：
  started 帧的 `arguments` 抢先更新 UI，finished 帧的 `data.plan` 为权威覆盖。
  折叠函数必须是**幂等纯函数**（按帧覆盖），这样重连重放 open turn 时结果一致。
- **D2 — 会话恢复：独立 `GET /projects/:key/sessions/:id/plan` 端点。**
  不塞进 `/messages` 分页响应——plan 可能比最新一页更老，分页扫不到；独立端点
  （像 `messages` 一样放在 `resolveSession` 之前、用 `manager.readSessionEntries` 读全量 entry 流）
  对 live / 离线会话都成立，且离线会话也能展示。
- **D3 — 耗时语义：item 耗时 = 「被置为 in_progress 的那次 update_plan 调用」→
  「被置为 completed 的那次调用」之间的时间。**
  `tool_execution_finished.elapsedMs` 是 update_plan 工具自身执行时长（毫秒级），**不是** item 工时。
  两套时钟：直播期间用客户端收帧时钟（`Date.now()`）；恢复会话用持久化 `MessageEntry.timestamp`
  差值。两者只是近似值，UI 不承诺精度。
- **D4 — 生命周期：plan 状态跨 turn 保留**（模型可能隔几个 turn 才更新一次 plan）；
  切换会话时清空并 fetch `/plan` 恢复；turn 结束不清。全部完成保留展示（用户要能回看）。
- **D5 — transcript 里那行 `⚙ [7/7] …` 保留不动。** 它是 TUI/web 共享 reducer
  （`src/session/events.ts` ↔ `src/server/web/reducer.js`）的产物，为 web 单独改它会破坏
  两个前端同构。plan bar 是 web 专属增量。（可选增强，本版不做：web 端 update_plan 工具行
  点击也展开面板。）
- **D6 — sub-agent 边界：** 子代理运行也带自己的 tools，forwarded 帧带 `subAgent` 标记。
  plan 折叠**只吸收无 `subAgent` 标记的帧**——子代理的 plan 不上主 bar（与 context 估计、
  transcript 归属的处理惯例一致）。

### 被否决的方案

- *服务端为 plan 增加独立进度事件*（如 `plan_updated`）：需要动 `TurnProgressEventMap`、
  runner、TUI、event-log、两个 reducer 同步——D1 用现有帧即可达成，不值得动协议。
- *把 plan 塞进 `/messages` 响应*：见 D2。
- *plan 面板做成 `<details>` 常驻 DOM*：占 transcript 空间且与 tasks-panel 交互不一致；
  popover 模式复用现成样式与外点关闭逻辑。

---

## 4. 实现任务

### T1 — 服务端：从 entry 流重建 plan（`src/server/plan-state.ts`，新文件）

```ts
export interface PlanItemSnapshot {
	step: string;
	status: "pending" | "in_progress" | "completed";
	startedAt: string | null;   // 被置为 in_progress 的那次调用的 entry.timestamp
	completedAt: string | null; // 被置为 completed 的那次调用的 entry.timestamp
	elapsedMs: number | null;   // 两者差值；in_progress 项为 null（UI 实时算）
}
export interface PlanSnapshot {
	explanation: string | null;
	updatedAt: string | null;   // 最后一次 update_plan 调用的 entry.timestamp
	items: PlanItemSnapshot[];
}
export function derivePlanFromEntries(entries: readonly SessionEntry[]): PlanSnapshot | null;
```

- 从**后往前**扫：找最后一条带 `name === "update_plan"` toolCall 的 assistant entry，
  `parsePlanArgs(call.arguments)`（复用 `src/plan-tracker.ts`，导出 `PlanView` 类型即可）。
- 再往回找每个 item 的 in_progress 起点（逐次往前比对 status 变化，最多扫到 plan 生命周期内；
  简化实现：顺序扫一遍，维护 `Map<step, startedAt>`，遇到同 step 重新 in_progress 就覆盖）。
- 解析失败 / 无 update_plan → `null`。纯函数，直接单测。

### T2 — 路由：`GET /projects/:key/sessions/:id/plan`（`src/server/multi.ts`）

- 仿照 `handleSessionHistory`：`segments.length === 5 && sub === "plan" && method === "GET"`，
  放在 `resolveSession` **之前**（离线会话可读），`manager.readSessionEntries` →
  `derivePlanFromEntries` → `writeJson(res, 200, { plan })`（无 plan 时 `{ plan: null }`）。

### T3 — web 客户端：plan 状态折叠 + 渲染（`src/server/web/plan.js`，新文件）

- `state.js`：加 `plan: null`（`PlanSnapshot` 形状 + 运行时附加字段
  `localStartedAt`（in_progress 项的客户端时钟起点））。
- `foldPlanEvent(state, event)`：处理 `tool_execution_started/finished`
  （`toolName === "update_plan"` 且无 `subAgent`）：
  - started：`parsePlanArgs(event.arguments)`（浏览器侧复制 `plan-tracker` 的解析逻辑，
    或抽一个共享纯模块——见 T5 备注）→ 覆盖 items，记录 `localStartedAt`；
  - finished：`event.data?.plan` 权威覆盖 + `elapsedMs` 记账 + 完成项冻结耗时。
- 渲染：`renderPlanBar()`（bar 文本/进度/计时）+ `renderPlanPanel()`（列表/meta），
  1s ticker 只在有 in_progress 项时更新 bar 与面板里的耗时显示。
- 交互：bar 点击 toggle 面板（复用 tasks 的外点关闭模式，`app.js` 的 document click
  里补 `closePlanPanel()`）；面板关闭态不轮询。
- 接线：
  - `events.js: handleEvent` → 在 `applyTurnProgress` 旁调用 `foldPlanEvent`；
  - 会话切换（`sessions.js` 选中会话处，与 `resetTasks` 同点）→ `resetPlan()` + `fetchPlan()`
    （`GET .../plan`，失败静默为 null）；
  - `disconnect()`（`events.js`）→ `resetPlan()`。

### T4 — DOM + 样式

- `index.html`：`#transcript` 与 `#error` 之间插入
  `<div id="plan-bar" hidden>` 与 `<div id="plan-panel" role="dialog" hidden>`
  （panel 内结构仿 tasks-panel：head/title/close + list + meta）。
- `dom.js`：注册新元素句柄。
- `styles.css`：新块放在 tasks-panel 附近，复用其变量/圆角/阴影语言；
  in_progress 项高亮（沿用 `.tool.running` 的 pulse 动画风格）。

### T5 — 测试（`node --test`，沿用 `test/web-reducer.test.ts` 模式）

- `plan-state` 纯函数：多轮 update_plan、item 重开（同 step 再次 in_progress）、
  无 plan / 参数畸形 → null、耗时推导正确。
- `foldPlanEvent`：started 抢先更新、finished 权威覆盖、subAgent 帧忽略、
  非 update_plan 帧忽略、重放幂等（同帧序列跑两遍结果一致）。
- 路由：离线会话 `GET /plan` 200 + `{plan: null}` / 有 plan 会话的快照。
- **备注**：`src/plan-tracker.ts` 的 `parsePlanArgs` 若要被浏览器 import，需保持其零依赖
  （现在就是纯 TS；web 端要么编译进 bundle，要么在 `plan.js` 复制一份并在注释里声明
  与源同步——按 `reducer.js` 对 `events.ts` 的先例，**复制 + 注释声明**更符合现状管线）。

### T6 — 文档收尾

- 本文件状态改为「已实现」；`CONTEXT.md` 视需要补一条 **Plan bar** 术语。

---

## 5. 边界情况

- **畸形帧**：`arguments`/`data.plan` 解析失败 → 忽略该帧，保留上一状态。
- **模型跳步**（一次把多项从 pending 改 completed）：按最终状态渲染，耗时取
  最近一次可见的 in_progress→completed 区间，取不到就 `null`（显示 `—`）。
- **plan 被换成完全不同的列表**：整表覆盖（fold 语义天然如此），旧耗时丢弃。
- **多会话并发**：`fetchPlan` 用与 `loadHistory` 相同的「session 切换丢弃陈旧响应」守卫
  （比对 `state.projectKey / state.sessionId`）。
- **时钟漂移 / 重放**：直播计时用客户端时钟，恢复后用服务器 timestamp，二者不混算；
  重放幂等由 fold 纯函数保证。

## 6. 验证清单（实现后）

```bash
pnpm run test:compile && node --test dist/test/*.test.ts 2>/dev/null || node --test dist/test/*.test.js
pnpm exec biome check .
```

手工：开一个会话让模型走多步任务（会调 update_plan）→ 观察 bar 逐项推进、计时跳动、
点击展开面板；断网重连后 open turn 重放 plan 不乱；切到历史会话 bar 能恢复上一 plan；
切到无 plan 会话 bar 隐藏。

## 7. 关键文件

| 文件 | 动作 |
|---|---|
| `src/server/plan-state.ts` | 新增（T1） |
| `src/server/multi.ts` | +`GET .../plan` 路由（T2） |
| `src/server/web/plan-fold.js` | 新增：纯折叠（T3） |
| `src/server/web/plan.js` | 新增：bar / 面板渲染与交互（T3） |
| `src/server/web/state.js` / `events.js` / `sessions.js` / `app.js` / `dom.js` | 接线（T3） |
| `src/server/static.ts` / `scripts/copy-assets.mjs` | 登记新资产（T3） |
| `src/server/web/index.html` / `styles.css` | UI（T4） |
| `test/plan-state.test.ts`、`test/web-plan.test.ts`、`test/chat-server-multi.test.ts` | T5 |
| `src/plan-tracker.ts` | 只读复用（导出 `PlanStatus` / `PlanItem` / `PlanView` 类型） |
| `CONTEXT.md` | 新增 **Plan bar** 术语（T6） |

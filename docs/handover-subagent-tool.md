# 交接文档：子 Agent 工具（`SubAgent`）实现步骤

> 状态：**已实现**（步骤 1–7）。步骤 7 采用"标记 + 桥接层过滤"：子 agent 的活动事件带
> `SubAgentProgressMarker` 透传到父 runner，TUI 与 Web 各自渲染为缩进、带 `sub-agent`
> 标签的行；子 agent 自己的 turn 生命周期事件**不透传**。设计见
> `docs/design-subagent-tool.md`。本文只给落地顺序、要改的文件/符号、测试与验证命令。
> 工具名 `SubAgent`（**不要**叫 `task`，避免与 `BackgroundTaskManager` 后台任务混淆）。

## 0. 前置：确认边界

- 子 agent 层（`src/agent/sub-agent.ts`）**不得**引入 TUI / 终端 / git；只依赖
  `AgentRunner` / `ConversationContext` / `ToolRegistry` / `ModelProvider`
  （遵守 `docs/handover-multi-frontend.md` 第 2 节底线）。
- 子 agent **不落盘**：不 `bindSession`、不 `setPersistContext`、不碰 `SessionStore`。
- 父 agent 回灌给模型的文本 = 子 agent 的 `outputText`（走工具结果的 `rendered` 字段）。

## 1. 步骤一：子 agent 运行器（纯组装，可单测）

新增 `src/agent/sub-agent.ts`：

- `SubAgentTask`、`SubAgentResult`、`SubAgentRunner` 三个类型（见设计 §5.1）。
- `createSubAgentRunner(deps)`：每次 `run()` 新建 `ConversationContext`
  （`src/agent/context.ts:80`）+ `AgentRunner`（`src/agent/runner.ts:319`），
  把 `task.signal` 桥接到 `TurnInterruptController`（`src/interrupt.ts:21`），
  调 `runner.runTurn(task.description, controller)`（`runner.ts:383`），
  返回 `outputText / steps / completionStatus`。
- `onProgress` 时用 `runner.onProgress(...)`（`runner.ts:366`）转发。

**测试** `test/sub-agent.test.ts`：

- 用 mock `ModelProvider` + mock `ToolRegistry`，断言：
  - 返回的 `outputText` 来自子 agent 最后一轮的 assistant 文本；
  - **未触碰** session store（子 agent 无 store 依赖，构造即无副作用）；
  - 传入已 `abort` 的 `signal` 时 `run()` 以 interrupted 结束。

## 2. 步骤二：`SubAgent` 工具

新增 `src/tools/builtin/sub-agent.ts`（见设计 §5.3）：

- `createSubAgentTool(runSubAgent: SubAgentRunner): ToolDefinition<SubAgentArgs>`。
- schema：`{ description: string }`（zod）。
- `execute`：`runSubAgent.run({ description, signal: context.abortSignal })`，
  返回 `withRendered({ steps, status, summary }, result.outputText)`
  （`src/tools/render.ts:3`）。
- `describeProgress` 返回 `delegate to sub-agent: …`。

**测试** `test/sub-agent-tool.test.ts`：

- mock `SubAgentRunner`，断言 `execute` 的返回对象含 `rendered`，且等于 `outputText`；
- 断言 `formatToolExecutionResult("SubAgent", result)`（`render.ts:13`）输出就是结论
  文本（验证 `rendered` 优先生效）；
- 断言超长结论被 `createToolMessage` 截断（`src/agent/messages.ts:14`）。

## 3. 步骤三：注册表接入

改 `src/tools/index.ts`（`:14`）：`createDefaultToolRegistry` 增加可选第三参
`extras?: { subAgent?: SubAgentRunner }`，仅在提供时
`registry.register(createSubAgentTool(extras.subAgent))`。

**测试**：断言不传 `extras` 时 schema 列表**不含** `SubAgent`；传入时**含**。

## 4. 步骤四：子 agent systemPrompt

新增 `buildSubAgentSystemPrompt({ cwd })`（`src/defaults.ts` 或新文件）：

- 明确输出契约：单任务、结构化短结论 `结论 / 证据(路径:行) / 未解问题`、字符上限。
- 与主 prompt 分离，不共享 skills 等主对话专属内容。

## 5. 步骤五：runtime 装配

改 `src/runtime.ts`（现有顺序：`:235` 建 tools，`:294` 建 runner）：

- 建 `subTools`（只读：`globTool` / `grepTool` / `createReadTool(new ReadTracker())`，
  **不含** `SubAgent` / edit / write / bash）。
- 建 `runnerRef: { current: AgentRunner | null }`（仿 `activeModelRef`，`runtime.ts:239`）。
- `createSubAgentRunner({ provider, tools: subTools, systemPrompt, workingDirectory,
  maxSteps, runId, sessionId, logger, onProgress: (e) => runnerRef.current?.emitProgress(...) })`。
- `createDefaultToolRegistry(shellRuntime, config.tools.bash, { subAgent: enabled ? runner : undefined })`。
- 建完 `runner` 后 `runnerRef.current = runner`。

**测试**：可用 `createAgentRuntime({ config: { tools: { subAgent: { enabled: true } } } })`
断言 `runtime.toolSchemas` 含 `SubAgent`；关闭时不含。

## 6. 步骤六：配置

改 `src/config.ts`：

- 新增 `subAgentConfigSchema = z.object({ enabled: z.boolean().default(false),
  maxSteps: z.number().int().positive().default(20), model: z.string().optional() })`。
- 把它加进 `tools` 段（`config.ts:101` 附近的 tool schema）与 `ToolsConfig`
  （`config.ts:275`）、`PartialToolsConfig`（`config.ts:290`）。
- 补 `snake_case` 别名映射（仿 `BASH_ALIASES`，`config.ts:147`）：`maxSteps → max_steps`。
- 更新 `src/default-config.toml`：加 `[tools.sub_agent]` 段，`enabled = false`。

**测试**：`test/config*.test.ts` 里断言默认关闭、`max_steps` 别名解析、`enabled` 覆盖。

## 7. 步骤七：进度透传与两端渲染（已实现）

子 agent 的事件与父事件同名（`TURN_PROGRESS_EVENTS`，`src/types.ts:278`），
`runtime.ts`（§5）已把它们桥接到父 runner，所以**不需要为新事件名改任何前端分支**。
这一步要解决的是另一个问题：别让子 agent 的活动看起来像父 turn 的活动。

### 7.1 标记：`SubAgentProgressMarker`（`src/types.ts`）

```ts
interface SubAgentProgressMarker { id: string; task: string }   // 一次 run 一个 id
```

`TurnProgressPayload` 与 `TurnProgressEvent` 上各加一个可选
`subAgent?: SubAgentProgressMarker`（与 `estimatedContextTokens` 同样的挂载方式）。

### 7.2 桥接层：只透传"活动"，绝不透传 turn 生命周期（`src/agent/sub-agent.ts`）

`createSubAgentRunner().run()` 每次 run 生成一个 marker，只有
`FORWARDED_SUB_AGENT_EVENTS` 白名单里的事件才带上 marker 转发：

- **透传**：`model_request_started` / `model_delta` / `model_request_finished` /
  `assistant_message` / `tool_calls_received` / `tool_execution_started` /
  `tool_execution_finished` / `context_compacted` / `context_elided`。
- **不透传**：`turn_started` 与四个终态事件。所有前端都用这些名字表示"父 turn 开始/结束"
  ——`cli.ts` 的 turn 时钟与 run stats、`server/web/events.js` 的 `clearTurnNodes` +
  `setTurnActive`、`SessionEventLog` 的 open-turn 追踪。透传会让一次子 agent run 看起来
  像一整个额外 turn；最严重的是子 agent 的 `turn_started` 会让 Web 端清空父 turn 已渲染
  的内容、让 `replayOpenTurn` 从子 turn 开始重放。父 turn 里本来就有 `SubAgent` 工具行
  （`tool_execution_started` → `tool_execution_finished`）把整段 run 夹住，子 agent 的失败
  也以那条工具行的错误结果呈现，因此不透传不丢信息。

### 7.3 归约器：只加"作用域"，不加分支（`src/session/events.ts` + `src/server/web/reducer.js`）

`TurnTranscriptView` 的三个方法各多一个可选参数 `TranscriptLineOptions`
（`{ subAgent?: SubAgentProgressMarker }`）：`beginAssistantMessage(options?)`、
`beginToolLine(id, label, options?)`、`appendSystem(text, tone?, options?)`。归约器把事件
携带的 marker 原样作为 `scope` 传给 view，**由 view 决定怎么画**；归约器只负责判断哪些行
属于子 agent。除此之外归约器里还有两处必须记住的细节：

1. **终态分支的 toolLines 清理对带 marker 的事件跳过**：子 agent 的
   `model_request_finished` 只是它自己一步的边界，照旧清理会把父 turn 里仍在运行的
   `SubAgent` 工具行标成 `interrupted`（写完第一版就踩到了）。
2. **assistant 组件按作用域隔离**（`assistantScopes` WeakMap）：`model_delta` 落到作用域
   不同的在飞组件上时，先 `finalize()` 再新建一个，避免子 agent 的文本混进父 turn 的回答
   （或反过来）。按 marker 的 `id` 比较而非对象身份——浏览器每帧都是新解析的 JSON 对象。

### 7.4 两端的渲染

- **TUI**（`src/tui/messages.ts` + `chat-renderer.ts`）：子 agent 的行缩进多一级
  （4 空格），换用 `↳`（工具行）/ `○`（回答）字形，并加暗色 `sub-agent ` 标签；
  宽度计算用 `SUB_AGENT_TAG_WIDTH` 常量，不要用带 ANSI 的字符串长度。
- **Web**（`src/server/web/transcript.js` + `styles.css`）：加 `.sub` 类（多一级缩进 +
  左侧细线）与 `.sub-tag` chip；子 agent 的回答不挂"复制 / 保存为 md"工具条（它永远不是
  本 turn 的答案）。
- **状态栏**（`src/tui/status-bar.ts`）：带 marker 的事件标签为
  `sub-agent · thinking|working`，`getTurnPhaseLabel` 保持不变。
- **上下文读数**：两端的 in-flight token 估计都跳过带 marker 的事件（`chat-repl.ts`
  的 `formatStatusBarForEvent`、`web/events.js` 的 `setContextUsedTokens`）——子 agent 的
  context 是独立且用后即弃的，混进主会话读数只会误导。
- **日志**（`src/progress-logging.ts`）：带 marker 的记录多 `subAgentId` /
  `subAgentTask` 两个字段，否则子 agent 的 step 号看起来像父 turn 多出来的步骤。

改动对齐要求：`src/session/events.ts` 与 `src/server/web/reducer.js` 必须逐行同步，渲染
细节可以各自不同。`test/web-reducer.test.ts` 是这两份实现的对拍。

## 8. 验证命令

- 全量：`pnpm run test`（先 `test:compile`，再 `node --test dist/test/*.test.js`）。
- 静态检查：`pnpm run lint` / `pnpm run check`。
- 手工冒烟（§7）：`pnpm run dev`（`~/.sigpi/config.toml` 里 `[tools.sub_agent] enabled = true`），
  给主 agent 一个跨文件调研任务，确认：
  1. transcript 里只多出 `SubAgent` 的一次 tool 结果、主 agent 窗口未被原始读取填满；
  2. `delegate to sub-agent: "…"` 行下方出现缩进的 `sub-agent …` 行（子 agent 的
     read/grep 与它的结论），run 结束后该行变 `✓`；
  3. 整个 run 期间状态栏的 turn 时钟与 `{used}/{limit}` 读数不跳变（时钟不归零、
     token 读数不被子 agent 的小窗口替换）。
- Web 端冒烟：`pnpm run dev serve`，浏览器里重复上面第 2、3 条（子 agent 的行有
  chip 与左侧细线；子 agent 的回答没有"复制 / 保存为 md"按钮）。

## 9. 落地顺序小结

1. `sub-agent.ts` + 单测（纯组装，无外部依赖）。
2. `sub-agent.ts`（工具）+ 单测（`rendered` 生效、截断）。
3. `tools/index.ts` 接入 + 单测。
4. 子 agent systemPrompt。
5. `runtime.ts` 装配 + 单测。
6. `config.ts` + `default-config.toml` + 单测。
7. 进度标记 + 桥接层过滤 + 两端渲染（§7；`test/sub-agent.test.ts` 的转发白名单断言、
   `test/cli-turn-progress.test.ts` / `test/web-reducer.test.ts` 的归约器对拍、
   `test/web-app.test.ts` 的 DOM 断言、`test/tui.test.ts` 的组件渲染断言）。

前 3 步完成即可端到端跑通；4–6 是把它接进真实运行时的必要项；7 是"用户看得见"的部分。

## 10. 已识别的风险 / 待定项

- **回灌长度**：64k 兜底截断（`messages.ts:14`）会腰斩长结论——必须靠输出契约 + 工具层
  主动截断控制。
- **可写子 agent**：需要与主 agent 共享 `ReadTracker` 并处理 `bash` 并发写；本期不做。
- **嵌套子 agent**：子注册表默认不含 `SubAgent`，天然不递归；如需嵌套再加 `depth`。
  `SubAgentProgressMarker` 的 `id` 已能区分多个 run，接嵌套时只需把父子事件都打上标记。
- **独立模型**：`createSubAgentRunner` 已允许传独立 `provider`，但本期默认复用主 provider。
- **SSE 事件量**（§7 引入）：一次子 agent run 的增量/工具事件都会进 SSE 广播与
  `SessionEventLog` 的环形缓冲。缓冲区 2048 条（`event-log.ts:33`）足够容纳
  `maxSteps=20` 的一次 run，但把 `max_steps` 调很大时值得重新估算。

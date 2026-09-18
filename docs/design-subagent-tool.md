# 设计：子 Agent 工具（`SubAgent`）

> 状态：**设计稿，尚未实现**。配套实现步骤见 `docs/handover-subagent-tool.md`。
> 所有结论以当前源码为准，改动点均标注文件与符号。

## 1. 背景与目标

主 agent 的上下文是稀缺资源。一次"探索/调研"任务往往要读十几个文件、跑几轮 grep，
这些 `read`/`grep` 的原始输出全部堆进主 agent 的 `recentMessages`，即使最终只需要
一句结论。结果是主 agent 的窗口被探索过程挤满，真正的实现/推理反而没有空间。

**目标**：允许主 agent 把一个独立的探索/调研任务**委派**给一个子 agent。子 agent 用
自己的上下文做所有的读/搜，**只有它的最终结论**作为一次普通工具调用的结果回灌给主
agent。主 agent 节省的上下文 ≈（子 agent 内部读取的原始 token）−（回灌结论的 token）。

## 2. 命名决定：工具叫 `SubAgent`

工具名定为 **`SubAgent`**。

理由：仓库里已经有"任务"语义——`BackgroundTaskManager`（`src/tools/background.js`，
由 `bash` 的 `run_in_background` 使用，见 `src/types.ts` 的 `BashToolContext.tasks`）
以及 `src/task-selector.ts`。若把委派工具也叫 `task`，会与后台 shell 任务的"任务"
混淆。用 `SubAgent` 明确表达"委派给一个子 agent"，与后台任务无关。

> 注：现有内建工具名多为小写（`glob`/`grep`/`read`/`write`/`edit`/`update-plan`/`bash`）。
> `SubAgent` 的驼峰命名是**有意为之**，以拉开与后台任务的距离；模型对工具名大小写不敏感，
> 不影响调用。

## 3. 核心机制

子 agent 本质上是：

```
独立的 ConversationContext  +  独立的 AgentRunner  +  受限的 ToolRegistry
                          ↓
        只有 RunTurnResult.outputText 作为父 agent 的一次 tool 结果回灌
```

- 子 agent 的所有中间消息（assistant 工具调用、read/grep 结果）留在**它自己的**
  `ConversationContext` 里，随 `runTurn` 结束即被丢弃。
- 父 agent 只在 transcript 里多出一条 `assistant → tool_calls=[SubAgent]` 和一条
  `tool` 结果（即子 agent 结论）。
- 每次调用都新建 context + runner，天然支持多次调用与并发（各子 agent 状态隔离）。

## 4. 关键接缝约束（决定了接口怎么设计）

`ToolDefinition.execute(args, context)` 只拿到 `ToolExecutionContext`
（`src/types.ts:99`），其中**没有 provider、没有 config、没有能力自己 new runner**。
`ToolExecutionContext` 只有 `cwd / shell / logger / runId / sessionId / turnId /
abortSignal / bash`。

因此子 agent 的依赖（provider、受限工具、systemPrompt、maxSteps）**必须在构建工具
时用闭包注入**，而不是运行时从 `context` 取。这正是现有 `createDefaultToolRegistry`
（`src/tools/index.ts:14`）的形态——它已经用闭包注入了 `ReadTracker` 和 `ShellRuntime`。

另一个约束：`src/agent/**` 与 `src/session/**` 必须保持 UI/终端无关（见
`docs/handover-multi-frontend.md` 第 2 节底线）。子 agent 层**不得**引入 TUI/toast
之类的东西，进度的透传只能走 `AgentRunner` 的事件流。

## 5. 组件设计

### 5.1 子 agent 运行器 —— `src/agent/sub-agent.ts`

新增文件，提供一个把"独立 context + runner"打包成一次性调用的工厂。

```ts
import type { AgentRunner } from "./runner.js";
import type { ConversationContext } from "./context.js";
import type { ModelProvider, TurnProgressEvent, ModelUsage, RunTurnResult } from "../types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { RuntimeLogger } from "../types.js";

export interface SubAgentTask {
  /** 交给子 agent 的任务描述（自然语言）。 */
  description: string;
  /** 父级工具调用的中止信号，用于把父 agent 的 Esc 透传给子 agent。 */
  signal?: AbortSignal;
}

export interface SubAgentResult {
  outputText: string;
  steps: number;
  completionStatus: RunTurnResult["completionStatus"];
  usage: ModelUsage | null;
}

/** 一次性子 agent 运行入口。 */
export interface SubAgentRunner {
  run(task: SubAgentTask): Promise<SubAgentResult>;
}

export function createSubAgentRunner(deps: {
  provider: ModelProvider;          // 与主 agent 共享（generate 无状态）
  tools: ToolRegistry;              // 受限注册表（一般只含只读工具）
  systemPrompt: string;             // 子 agent 专用 prompt（含输出契约）
  workingDirectory: string;
  maxSteps: number;
  runId?: string;
  sessionId?: string | null;
  logger?: RuntimeLogger;
  /** 可选的进度透传回调：把子 agent 的 TurnProgressEvent 转给父 runner。 */
  onProgress?: (event: TurnProgressEvent) => void;
}): SubAgentRunner;
```

`run()` 的实现要点：

```ts
const context = new ConversationContext({
  summaryEnabled: true,
  getContextBudget: getContextBudget,   // 复用主 agent 的 budget getter
  logger: deps.logger,
  runId: deps.runId,
  sessionId: deps.sessionId ?? null,
  // 关键：绝不 bindSession、绝不 setPersistContext → 永不写 session store
});

const runner = new AgentRunner({
  provider: deps.provider,              // 共享 provider 实例
  tools: deps.tools,                    // 受限注册表
  context,
  systemPrompt: deps.systemPrompt,
  options: {
    maxSteps: deps.maxSteps,
    workingDirectory: deps.workingDirectory,
    runId: deps.runId,
    sessionId: deps.sessionId ?? null,
  },
});

if (deps.onProgress) runner.onProgress(deps.onProgress);   // runner.ts:366

// 把父级 abortSignal 桥接到子级 TurnInterruptController
const controller = new TurnInterruptController();
task.signal?.addEventListener("abort", () => controller.requestInterrupt());

const result = await runner.runTurn(task.description, controller);   // runner.ts:383
return {
  outputText: result.outputText ?? "",
  steps: result.steps,
  completionStatus: result.completionStatus,
  usage: null, // 如需统计，可在 onProgress 里累计 model_request_finished 的 usage
};
```

要点说明：

- **provider 复用主 agent 的实例即可**——`ModelProvider.generate`
  （`src/model/provider.ts:24`）是无状态的 per-request 调用。若要用更便宜的模型，
  在 runtime 里用 `createModelProvider(subConfig, logger)` 另建一个实例传入。
- **不落盘**：不调用 `sessionRuntime` / `store`，不 `bindSession`，不
  `setPersistContext`。子 agent 会话完全在内存，随 `run()` 结束回收。
- 每次 `run()` 新建 context + runner，避免跨调用状态污染。

### 5.2 受限工具注册表

在 runtime 里为子 agent **另建**一个只读注册表，而不是复用主注册表：

```ts
const subTools = new ToolRegistry([
  globTool,
  grepTool,
  createReadTool(new ReadTracker()),
]);              // 不含 edit / write / bash / update-plan / SubAgent
```

- **不注册 `SubAgent` 本身** → 天然防止无限递归。若确实想要嵌套子 agent，则改为
  传一个 `depth` 参数，超过阈值时从子注册表里剔除 `SubAgent`。
- 探索/调研类任务通常只给 `read / grep / glob`，最省心、也最省上下文。
- 若要让子 agent 具备**改文件**能力，需要与主 agent **共享同一个 `ReadTracker`**
  （read-before-edit 语义），并谨慎处理 `bash` 的并发写；否则建议保持只读。

### 5.3 `SubAgent` 工具 —— `src/tools/builtin/sub-agent.ts`

```ts
export function createSubAgentTool(
  runSubAgent: SubAgentRunner,
): ToolDefinition<SubAgentArgs> {
  return {
    name: "SubAgent",
    description:
      "把一个独立的探索/调研任务委派给子 agent 执行。子 agent 有自己的上下文，" +
      "会自行决定读取哪些文件/搜索什么；只有它的最终结论会返回给你，它的中间读取" +
      "过程不会占用你的上下文。适合：定位实现、跨文件调研、收集证据、给出结论。" +
      "不适合：需要与主对话保持连续上下文的编辑。",
    inputSchema: z.object({ description: z.string().min(1) }),
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "要委派给子 agent 的完整任务描述，包含目标与期望输出。",
        },
      },
      required: ["description"],
      additionalProperties: false,
    },
    execute: async ({ description }, context) => {
      const result = await runSubAgent.run({
        description,
        signal: context.abortSignal,   // 透传父级中断
      });
      return withRendered(
        {
          steps: result.steps,
          status: result.completionStatus,
          summary: result.outputText,
        },
        result.outputText,             // rendered → 回灌给主模型的文本
      );
    },
    describeProgress: (args) => ({
      summary: `delegate to sub-agent: ${asQuoted(getString(args.description) ?? "")}`,
    }),
  };
}
```

关键点：

- **`withRendered` + `rendered`**（`src/tools/render.ts:3`、`:61`）：`formatToolExecutionResult`
  （`render.ts:13`）会**优先使用 `rendered` 字段**，所以主模型看到的 `tool` 消息就是
  子 agent 的结论本身，而不是 `{steps,status,summary}` 的 JSON。这是"省上下文"落地的
  关键一步。
- **主动限制结论长度**：回灌文本仍会走 `createToolMessage` 的截断
  （`src/agent/messages.ts:14`，`TOOL_MESSAGE_CONTENT_MAX_CHARS = 65_536`，头 20k /
  尾 20k）。所以应在子 agent 的输出契约里要求短结论，或在工具层再截断一次，不要把
  截断交给 64k 兜底。
- `describeProgress` 让 TUI/Web 的 transcript 显示"委派子任务：…"，与现有工具一致。

### 5.4 装配 —— `src/runtime.ts`（+ `src/tools/index.ts`）

`createDefaultToolRegistry`（`src/tools/index.ts:14`）增加一个可选参数，仅在提供时
`register(createSubAgentTool(...))`，保证未配置场景/测试不受影响：

```ts
export function createDefaultToolRegistry(
  shellRuntime?: ShellRuntime,
  bashConfig: RunShellConfig = {},
  extras?: { subAgent?: SubAgentRunner },
): ToolRegistry {
  const readTracker = new ReadTracker();
  const registry = new ToolRegistry([
    globTool, grepTool,
    createReadTool(readTracker), createWriteTool(readTracker), createEditTool(readTracker),
    createUpdatePlanTool(),
    createBashTool(shellRuntime ?? detectShellRuntime(), bashConfig, readTracker),
  ]);
  if (extras?.subAgent) registry.register(createSubAgentTool(extras.subAgent));
  return registry;
}
```

runtime 装配顺序有个先后依赖：现有代码里 **tools 先于 runner 创建**
（`src/runtime.ts:235` 建 tools，`:294` 建 runner），而进度透传需要 runner 引用。
用与 `activeModelRef`（`runtime.ts:239`）相同的可变 holder 解决：

```ts
const runnerRef: { current: AgentRunner | null } = { current: null };

const subTools = new ToolRegistry([
  globTool, grepTool, createReadTool(new ReadTracker()),
]);
const subAgentRunner = createSubAgentRunner({
  provider,
  tools: subTools,
  systemPrompt: buildSubAgentSystemPrompt({ cwd }),   // 新增专用 prompt
  workingDirectory: cwd,
  maxSteps: config.tools.subAgent.maxSteps,
  runId,
  sessionId: sessionState.session?.sessionId ?? null,
  logger: runtimeLogger,
  onProgress: (e) => runnerRef.current?.emitProgress(e.type, e),   // 可选
});

const tools = createDefaultToolRegistry(shellRuntime, config.tools.bash, {
  subAgent: config.tools.subAgent.enabled ? subAgentRunner : undefined,
});

// ... 现有构建流程 ...

const runner = new AgentRunner({ /* ... */ });
runnerRef.current = runner;   // 回填，供进度透传
```

### 5.5 子 agent 专用 systemPrompt

新增 `buildSubAgentSystemPrompt({ cwd })`（放在 `src/defaults.ts` 或新文件）。与主
prompt 分离，明确**输出契约**（这是"省上下文"能否成立的核心）：

- 只做受命的那一个任务，不要发散。
- 输出结构化短结论，例如：`结论 / 证据(路径:行) / 未解问题`。
- 引用证据务必带 `路径:行号`，便于主 agent 直接使用而无需再读。
- 设定一个字符上限（例如 ≤ 2k 字符），避免回灌被 64k 兜底截断。

## 6. 需要一并处理的点

- **进度 / UI**：子 agent 的 `TurnProgressEvent` 默认无人订阅。最简做法是只走 logger；
  想让 TUI/Web 显示"子 agent 正在读 X"，用 §5.4 的 `onProgress` 桥接到父 runner。
  子事件与父事件**复用同一套事件名**（`TURN_PROGRESS_EVENTS`，`src/types.ts:278`），
  现有前端 reducer 无需改动即可渲染。若担心污染父 transcript，可在桥接时过滤，只透传
  `tool_execution_started/finished` 或加一个 `subAgent: true` 标记。
  **已按后者实现**（`SubAgentProgressMarker` + 桥接层过滤子 turn 生命周期事件 + 两端
  缩进/标签渲染），落地细节见 `docs/handover-subagent-tool.md` §7。
- **中断**：`ToolExecutionContext.abortSignal` 就是父级 `TurnInterruptController` 的
  信号（`runner.ts:724`）。桥接到子 `TurnInterruptController`（`src/interrupt.ts:21`）
  后，Esc 能取消子 agent。注意 `requestInterrupt`（`interrupt.ts:58`）只在处于
  model/tool 阶段时生效，阶段间隙会稍晚响应——可接受。
- **返回值语义**：`runTurn` 在 `maxSteps` 用尽时返回的是合成 fallback 文案
  （`runner.ts:793` / `:879`），空响应时返回 `"No response generated."`
  （`runner.ts:765`）。`SubAgent` 工具应把 `completionStatus` / `steps` 一起透出，
  让主 agent 能判断"结论是否完整"，避免把未完成的探索当成定论。
- **配置**：在 `src/config.ts` 增加 `[tools.sub_agent]`（`enabled` / `max_steps` /
  可选 `model`），同步更新 `ToolsConfig`（`config.ts:275`）、`agentConfigSchema`
  同级的 tool schema、`TOOLS_ALIASES`/snake_case 映射、`default-config.toml`、
  `PartialToolsConfig`（`config.ts:290`）。**默认关闭**最安全。
- **`SubAgent` 结果在 turn summary 里的归属**：`summarizeToolExecutions`
  （`runner.ts:897`）只登记 `read/edit/write`，`SubAgent` 天然被排除，无需改动。

## 7. 权衡

| 维度 | 选项 A | 选项 B | 建议 |
| --- | --- | --- | --- |
| provider | 共享主 agent 实例 | 子 agent 独立（更便宜的模型） | 先用共享，配置化后再拆 |
| 子 agent 权限 | 只读（read/grep/glob） | 可写（共享 ReadTracker + 谨慎 bash） | 先只读 |
| 进度透传 | 只写日志（简单） | 桥接到父 runner（体验好，需 runnerRef） | 视需要 |
| 递归 | 子注册表不含 `SubAgent` | 带 `depth` 允许有限嵌套 | 先不递归 |

核心取舍：**只读 + 独立 context + 只回灌结论**，用最小的机制换取最大的上下文节省；
可写、嵌套、独立模型都留作后续可选项。

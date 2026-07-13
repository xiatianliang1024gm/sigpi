# CLI Process Output 显示流程

`ask` 和 `chat` 的过程输出用来展示用户输入、模型进度、工具调用、工具结果和最终回答。过程输出有两种模式，程度由低到高排列：`compact` → `detailed`。

## 1. 配置项

配置位于 `[agent]`：

```toml
[agent]
process_output = "detailed"
```

支持两种模式：

| 模式 | 行为 |
|------|------|
| `compact` | 精简、类 Claude Code 风格：展示用户与助手消息，把一次模型响应里返回的多个并行工具调用**分组**展示，工具结果做精简 |
| `detailed` | 默认模式，`compact` 的全部内容，外加 turn / model-run 分割线和计数，并展示更完整的工具结果 |

`detailed` 为默认模式。其他取值（包括旧名称 `quiet` / `clear` / `full`）一律视为非法，加载配置时直接报错，并提示合法取值与修改方式。

环境变量：

```bash
AGENT_PROCESS_OUTPUT=compact|detailed
```

非法环境变量取值同样直接报错，不会静默回退到默认值。

## 2. Progress 事件

`TurnProgressEvent` 携带展示字段：

- `userInput`：在 `turn_started` 中携带当前用户输入
- `toolResult`：在 `tool_execution_finished` 中携带已渲染的工具结果
- `toolCallCount`：在 `tool_calls_received` 中携带本次模型响应返回的工具调用数量（用于 `compact` 分组）

工具原始结构化结果仍然保存在 `ExecutedToolCall` 中。Progress 事件只放展示用文本，避免把无界原始数据直接塞进过程事件。

## 3. Runner 侧处理

`AgentRunner` 在以下位置发出更完整的事件：

- turn 开始时发出 `userInput`
- 每个工具执行完成后，用 `formatToolExecutionResult()` 生成展示文本
- `detailed` 模式下对工具结果做长度截断（`compact` 模式同样做精简，只是不展示分割线与计数）

日志和 session 持久化逻辑不变。需要完整工具结果做诊断时，使用 `detailed` 模式配合 `[logging].level = "debug"`，日志会保留完整的工具结果。

## 4. CLI 显示策略

`createCliProgressReporter()` 根据 `process_output` 选择渲染方式。

`detailed` 模式的主要样式：

```text
> 用户输入
• Assistant: ...
• Ran shell pwd
  /path/to/project
• Done (1234ms)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ turn 1 ━━━━━━━
```

`compact` 模式为类 Claude Code 的紧凑风格：展示用户与助手消息，并把同一次模型响应里的多个工具调用缩进归为一组，方便看清"模型怎么想、调了哪些工具、结果如何"：

```text
> 用户输入
⏺ Assistant: 我先看几个文件
  ⏺ Ran shell pwd
    /path/to/project
  ⏺ Ran grep x
    <精简结果>
  ⏺ Ran read f
    <精简结果>
✔ Done (1234ms)
```

颜色约定（`detailed` 与 `compact` 共用，`compact` 以更轻量的字形为主）：

| 内容 | 颜色 |
|------|------|
| `Ran` / `Done` | 绿色 |
| `Assistant` | 紫色 |
| checkpoint | 蓝色 |
| interrupt / max steps | 黄色 |
| failed | 红色 |
| shell 命令摘要 | 青色 |
| 分割线 | 暗色 |

## 5. Shell 结果精简

`bash` 的完整渲染结果包含：

- `TOOL`
- `STATUS`
- `Command`
- `Mode`
- `Shell`
- `Exit code`
- `STDOUT`
- `STDERR`

这些信息对诊断有用，但默认展示太啰嗦。因此：

- `detailed` / `compact` 模式都只展示有效 `STDOUT` / `STDERR`
- 成功且没有输出时显示 `ok`
- 失败时保留错误摘要

其他工具也会去掉通用 `TOOL/STATUS/RESULT` 外壳，只展示结果主体。`compact` 模式的工具结果进一步精简（按终端宽度截断），避免刷屏。

## 6. 分割线策略

为了避免用户问题和回答被切开，turn 分割线放在最终答案之后，而不是下一轮开始时。turn 分割线只在 `detailed` 模式出现。

同一个 turn 内如果有多次模型请求，会用较轻的模型 run 分割线标记（`detailed` 模式）：

```text
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ model run 2 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
```

同一个 turn 内多个工具调用之间会增加空行，方便区分不同工具块。`compact` 模式不做分割线，而是用缩进把同一次模型响应的工具调用归为一组。

## 7. Chat 输入保护

`chat` 模式下用户提交的输入可能已经由交互输入组件显示。为避免重复：

- `turn_started` 在有 active running input 时不再重复打印用户输入
- 所有过程输出继续通过 `writeWithActiveRunningInput()` 包裹，避免破坏正在输入的草稿

## 8. 验证

相关测试覆盖：

- config 解析、环境变量覆盖、非法取值直接报错
- runner progress 事件包含 `userInput` 和 `toolResult`
- `compact` / `detailed` 两种 CLI 输出
- `compact` 模式对同一次模型响应的多个工具调用做分组缩进
- `compact` 模式展示助手消息
- shell 结果精简
- 工具之间空行
- `detailed` 模式下 turn 完成后分割线、同一 turn 内多次 model run 分割线
- chat draft input 不被过程输出破坏

验证命令：

```bash
pnpm run test:provider
pnpm test
```

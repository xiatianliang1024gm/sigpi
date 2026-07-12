# CLI Process Output 显示流程

本次改动为 `ask` 和 `chat` 增加了更清晰的过程输出，用来展示用户输入、模型进度、工具调用、工具结果和最终回答。

## 1. 配置项

配置位于 `[agent]`：

```toml
[agent]
process_output = "clear"
```

支持三种模式：

| 模式 | 行为 |
|------|------|
| `clear` | 默认模式，显示清晰的过程输出，工具结果会精简和截断 |
| `quiet` | 保留旧的最小 `[agent] working/done` 输出 |
| `full` | 显示完整工具结果，适合诊断 |

环境变量：

```bash
AGENT_PROCESS_OUTPUT=clear|quiet|full
```

## 2. Progress 事件

`TurnProgressEvent` 增加了两个展示字段：

- `userInput`：在 `turn_started` 中携带当前用户输入
- `toolResult`：在 `tool_execution_finished` 中携带已渲染的工具结果

工具原始结构化结果仍然保存在 `ExecutedToolCall` 中。Progress 事件只放展示用文本，避免把无界原始数据直接塞进过程事件。

## 3. Runner 侧处理

`AgentRunner` 在以下位置发出更完整的事件：

- turn 开始时发出 `userInput`
- 每个工具执行完成后，用 `formatToolExecutionResult()` 生成展示文本
- `clear` 模式下对工具结果做长度截断
- `full` 模式保留完整渲染结果

日志和 session 持久化逻辑不变。

## 4. CLI 显示策略

`createCliProgressReporter()` 根据 `process_output` 选择渲染方式。

`clear/full` 模式的主要样式：

```text
> 用户输入
• Assistant: ...
• Ran shell pwd
  /path/to/project
• Done (1234ms)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ turn 1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

颜色约定：

| 内容 | 颜色 |
|------|------|
| `Ran` / `Done` | 绿色 |
| `Assistant` | 紫色 |
| checkpoint | 蓝色 |
| interrupt / max steps | 黄色 |
| failed | 红色 |
| shell 命令摘要 | 青色 |
| 分割线 | 暗色 |

`quiet` 模式不加这些样式，继续输出旧格式。

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

- `clear` 模式只展示有效 `STDOUT` / `STDERR`
- 成功且没有输出时显示 `ok`
- 失败时保留错误摘要
- `full` 模式仍展示完整工具结果

其他工具在 `clear` 模式下也会去掉通用 `TOOL/STATUS/RESULT` 外壳，只展示结果主体。

## 6. 分割线策略

为了避免用户问题和回答被切开，turn 分割线放在最终答案之后，而不是下一轮开始时。

同一个 turn 内如果有多次模型请求，会用较轻的模型 run 分割线标记：

```text
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ model run 2 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
```

同一个 turn 内多个工具调用之间会增加空行，方便区分不同工具块。

分割线宽度优先使用当前终端宽度；非 TTY 环境默认 80 列。

## 7. Chat 输入保护

`chat` 模式下用户提交的输入可能已经由交互输入组件显示。为避免重复：

- `turn_started` 在有 active running input 时不再重复打印用户输入
- 所有过程输出继续通过 `writeWithActiveRunningInput()` 包裹，避免破坏正在输入的草稿

## 8. 验证

相关测试覆盖：

- config 解析、环境变量覆盖
- runner progress 事件包含 `userInput` 和 `toolResult`
- clear / quiet / full 三种 CLI 输出
- shell 结果精简
- 工具之间空行
- turn 完成后分割线
- 同一 turn 内多次 model run 分割线
- chat draft input 不被过程输出破坏

验证命令：

```bash
pnpm run test:provider
pnpm test
```

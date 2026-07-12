# 3. Function Calling（函数调用）

在 [Agent Loop](./02-agent-loop.md) 里我们看到模型返回了 `toolCalls`。本章解释一个工具调用
*是什么*、模型如何被邀请产生它、以及结果如何回来。

## 工具的形状

一个工具用 JSON schema 描述给模型——名字、描述、参数 schema：

```ts
interface ToolSchema {
  name: string;
  description: string;
  parameters: JSONSchema;   // 模型要填的参数
}
```

`ToolRegistry.getSchemas()` 为每个内置工具返回一个这样的 schema。`src/tools/builtin/` 中的例子：

| 工具 | 用途 |
|------|------|
| `read` | 读文件（可按范围/偏移） |
| `grep` | 搜文件内容 |
| `glob` | 按模式找文件 |
| `edit` | 做定向编辑 |
| `write` | 创建/覆盖文件 |
| `bash` | 跑 shell 命令 |

这些 schema 附在**每一次**模型请求上（循环里的 `tools: this.tools.getSchemas()`），
所以模型始终知道自己能做什么。

## 模型来决定

模型读取 schema 与对话，并*选择*是否调用工具。SigPi **从不**自己调用工具——它只转发模型要求的。
这是关键的分隔：**模型是大脑，工具是手。** SigPi 的工作是把模型的意图送到手上、再把结果带回来。

当模型想要一个工具时，它返回一个 `toolCall`：

```ts
interface ToolCall {
  id: string;        // 把调用与其结果关联起来
  name: string;      // 哪个工具
  arguments: unknown;// 模型填好的 JSON
}
```

## 派发

回到循环里，每个 `toolCall` 按名字执行：

```ts
const result = await this.tools.execute(toolCall, {
  cwd, logger, runId, sessionId, turnId, abortSignal,
  allowedReadRoots, bash: this.options.bashToolContext,
});
```

`ToolRegistry.execute` 按 `name` 查到工具并运行它。结果有统一形状：

```ts
interface ToolExecutionResult {
  ok: boolean;
  data?: unknown;        // 给模型的结构化结果
  details?: unknown;     // 额外细节
  error?: string;        // ok === false 时存在
}
```

统一性很重要：每个工具，不论做什么，都返回同一个 `ToolExecutionResult`。正因如此，循环才能
一视同仁地对待所有工具——去重、记录、渲染都不需要针对特定工具的代码。

## 把结果渲染回去

结果变成一条工具消息：

```ts
const toolMessage = createToolMessage(toolCall.id, toolCall.name, result);
workingMessages.push(toolMessage);
turnMessages.push(toolMessage);
```

模型看到自己的 `toolCall.id` 与结果匹配——恰好就是 OpenAI 兼容 API 期望的形状
（`tool` 角色消息引用调用 id）。这条消息如何序列化到线上（chat-completions 还是 responses）
是适配器的事——见 [模型适配器](./06-model-adapters.md)。

## 为什么这叫「function calling」

这个词只是指：**模型发出一个结构化请求，要求以某些参数运行某个命名函数，宿主执行它并把输出返回。**
剥掉包装，它就是：

```
schema 进  ──►  模型  ──►  {name, arguments}  ──►  执行  ──►  结果  ──►  回到上下文
```

这就是整套机制。第二章的循环，正是把这样一次往返变成多步任务的东西。

## 关于安全

工具很强大——`bash` 和 `write` 能改动你的系统。SigPi 用以下方式划定边界：

- `allowedReadRoots` — 限制读工具能看的范围。
- `bashToolContext` — 携带工作目录与命令输出的存放目录。
- 第二章的**验证跟踪**标志（`MUTATING_TOOL_NAMES` / `VERIFICATION_TOOL_NAMES`），在编辑后
  提示 agent 检查自己的工作。

这些都不能替代真正的沙箱，但它们展示了每个 agent 都必须面对的问题的形状。

下一步：[上下文管理](./04-context-management.md) — 当对话（含工具结果）超出模型 token 上限时
会发生什么。

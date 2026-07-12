# 5. 工具与 ToolRegistry（进阶）

第三章讲了 function calling 的*概念*。本章讲*机制*：`ToolRegistry`（`src/tools/registry.ts`）、
统一的返回类型，以及内置工具。

## 注册表就是派发表

工具在启动时注册一次（`runtime.ts` 里的 `createDefaultToolRegistry`）。注册表暴露循环需要的
两件事：

```ts
getSchemas(): ToolSchema[]      // 模型看到的（OpenAI 风格工具 schema）
execute(toolCall, context)      // 按名字执行一个工具
```

`getSchemas` 把每个工具映射成 `{ type: "function", function: { name, description, parameters } }`
——正是模型 API 期望的形状。所以「有哪些工具」就是一个数组，加一个工具就是注册一条定义。

## 一条工具定义

```ts
interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;        // 给模型看
  inputSchema: ZodType;          // 运行时校验
  execute(args, context): ...;   // 干活
  describeProgress?(args): {...} // 进度上报
  recordLedger?(recorder, call, result): void; // 更新探索 ledger
}
```

注意**两套 schema**：`parameters` 是 JSON schema，*模型*读它来决定怎么调用工具；
`inputSchema` 是 Zod schema，SigPi 在*执行前*用它校验模型的参数。模型不被信任——参数在边界处
就被校验。

## 执行是防御式的

`execute` 从不假设模型表现正常。它按顺序检查：

1. **中断** — 若本轮被中断，立即抛出（见[第八章](./08-real-world-concerns.md)）。
2. **解析错误** — 若参数根本无法解析为 JSON（`toolCall.argumentParseError`），返回 `ok: false`
   并附原因。不执行。
3. **未知工具** — 若名字未注册，返回 `ok: false`。
4. **Schema 校验** — `inputSchema.safeParse(args)`；失败则返回 `ok: false` 并给出具体问题
   （`path: message`）。模型拿到精确、可修的错误。
5. **运行** — `tool.execute(validArgs, context)`；把结果包成 `ok: true, data`。
6. **工具错误** — 若工具抛出 `ToolExecutionError`（或任何错误），返回 `ok: false` 并带消息，
   而不是让本轮崩溃。

每个分支都返回 `ToolExecutionResult`——**循环永远不会从工具看到抛出的异常。** 这种统一性，正是
第二章的 agent 循环能一视同仁对待所有工具的原因。

## 内置工具

`src/tools/builtin/`：

| 工具 | 角色 |
|------|------|
| `read` | 读文件（范围/偏移） |
| `grep` | 搜内容 |
| `glob` | 按模式找文件 |
| `edit` | 定向编辑 |
| `write` | 创建/覆盖 |
| `bash` | 跑 shell 命令 |
| `update-plan` | 更新 plan tracker 状态 |

## 去重与 ledger

两个循环级行为会触及注册表：

- **去重** 在 runner 里（第二章）：等价的重复调用在 `execute` 被调用*之前*就被短路。
- **Ledger 记录**：成功执行后，`context.recordToolExecution` 调用 `registry.recordLedger`，
  它触发工具可选的 `recordLedger` 适配器，让探索 ledger（第四章）学到搜了/读了/改了什么。

## 关键收获

- 注册表把「有哪些工具」与「循环怎么跑它们」解耦。
- 工具用 JSON schema 描述给模型、用 Zod 校验——**不信任模型的参数**。
- 工具优雅失败为 `ok: false`；本轮继续而非崩溃。
- 加一个工具就是一次注册；其余（schema、派发、校验、记录）都被复用。

下一步：[模型适配器](./06-model-adapters.md)。

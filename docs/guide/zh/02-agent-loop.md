# 2. Agent Loop（代理循环）

> 锚定文件：`src/agent/runner.ts` → `AgentRunner.runTurn()`。
> 如果别的都不读，就读这个方法。

## 全景

一个「轮」（turn）是一条用户消息以及 agent 对它的完整响应。一轮**不是**一次模型调用，而是一个循环：

```
用户输入
   │
   ▼
┌─────────────────────────────────────────────┐
│  循环（最多 maxSteps 次）                      │
│                                              │
│  1. 发送工作上下文 ──►  大模型                  │
│  2. 模型要求调用工具了吗？                     │
│        │ 是 ──► 执行每个工具，把结果喂回        │
│        │         再循环一次                    │
│        └ 否  ──► 这就是最终答案                │
│                                              │
└─────────────────────────────────────────────┘
   │
   ▼
最终答案  +  持久化上下文
```

这就是一个 agent 的完整骨架。本指南其余内容，都是叠在这几行之上的细节。

## 入口

```ts
async runTurn(
  userInput: string,
  interruptController?: TurnInterruptController,
): Promise<RunTurnResult>
```

方法内部，第一件事是构建**工作上下文**：

```ts
const workingMessages = this.context.buildMessages(this.systemPrompt, userInput);
const turnMessages: Message[] = [createUserMessage(userInput)];
```

两个列表，两个职责：

- **`workingMessages`** — *真正发给模型*的东西：系统提示 + 已保存摘要 + 近期消息 + 本轮转录。
  这是模型的窗口。
- **`turnMessages`** — 仅本轮的转录（user → assistant → tool 结果）。它用于 checkpoint 与持久化。
  两者分离，意味着模型看到的是丰富的窗口，而保存的上下文保持干净。

它还会先解析出**当前目标**：

```ts
const currentGoal = resolveCurrentGoal(userInput, {
  summary: this.context.getSummary(),
  keyFindings: this.context.getExplorationLedger().keyFindings,
  recentMessages: this.context.getRecentMessages(),
});
```

`resolveCurrentGoal` 把模糊的续做输入（"continue"、"接着"）折叠回摘要里的真实目标，
这样循环始终知道自己在做什么。

## 循环

```ts
for (let step = 1; step <= this.options.maxSteps; step += 1) {
  interruptController?.throwIfInterrupted();
  const response = await this.provider.generate({
    messages: workingMessages,
    tools: this.tools.getSchemas(),
    temperature: this.options.temperature,   // 0.2
    maxTokens: this.options.maxTokens,
    context: { runId, sessionId, turnId, step, purpose: "turn" },
    abortSignal: interruptController?.getAbortSignal(),
  });
  ...
}
```

`maxSteps`（默认 **40**）是硬性上限。没有它，一个困惑的 agent 可能无限调用工具、烧光 token。
触顶时循环**不会**直接丢下用户——它会用本轮已经跑过的工具（`toolExecutions`）加上当前目标，
在本地拼出一个**兜底答案**（见下方[触顶本地兜底](#max-steps--本地兜底)），**不再**发起最后一次模型调用。

## 分支 A — 模型返回了工具调用

```ts
if (response.toolCalls.length > 0) {
  const assistantMessage = createAssistantMessage(response.assistantText, response.toolCalls);
  workingMessages.push(assistantMessage);
  turnMessages.push(assistantMessage);

  for (const toolCall of response.toolCalls) {
    // 1. 去重检查
    // 2. 执行
    // 3. 把结果喂回
  }
  await maybeCompactWorkingMessages();
  continue;   // ← 回到循环顶部
}
```

对每个工具调用，按顺序发生三件事。

### 1. 去重（别重复自己）

执行前，runner 先检查本轮里最近是否发生过*等价*的调用：

```ts
const duplicate = findRecentDuplicateToolCall(toolCall, turnMessages);
if (duplicate) {
  const dedupResult = buildDuplicateToolCallResult({ toolName, stepsBack });
  // 作为工具结果推送，但不真正再执行一次工具
  continue;
}
```

`findRecentDuplicateToolCall` 把调用规范化（对参数键排序、把字符串参数转小写并去空白），
向后回溯最近 `DEDUP_WINDOW`（**6**）条 assistant 消息。若找到匹配，就返回一个合成的
「你已经做过这个了」结果，而不是把工具再跑一遍。这正是 SigPi 避免经典失败模式
（对同一个文件在紧循环中反复 `read`）的方式。注意 `read`、`write`、`edit`、`bash` 被*排除*在去重之外
（`DEDUP_SKIPPED_TOOL_NAMES`）——重新读或重跑命令往往是故意的。

### 2. 执行

```ts
const result = await this.tools.execute(toolCall, {
  cwd: this.options.workingDirectory,
  logger, runId, sessionId, turnId,
  abortSignal: interruptController?.getAbortSignal(),
  allowedReadRoots: this.options.allowedReadRoots,
  bash: this.options.bashToolContext,
});
```

`tools.execute` 按名字通过 `ToolRegistry` 派发到某个内置工具。结果同时记录进 `toolExecutions`
（用于本轮摘要）和 `context.recordToolExecution`（让上下文层更新其探索 ledger）。

### 3. 把结果喂回

```ts
const toolMessage = createToolMessage(toolCall.id, toolCall.name, result);
workingMessages.push(toolMessage);   // 下一轮迭代模型就能看到
turnMessages.push(toolMessage);      // 随本轮一起保存
```

结果变成下一次模型输入。**这就是整个循环**：工具输出回到 `workingMessages`，循环再次调用模型，
模型据此决定是已有足够信息作答、还是还需要另一个工具。

### 验证跟踪

工具执行后，runner 跟踪一个小状态标志：

```ts
if (MUTATING_TOOL_NAMES.has(toolCall.name) && result.ok) {
  needsVerification = true;          // write/edit 成功了
} else if (needsVerification && VERIFICATION_TOOL_NAMES.has(toolCall.name)) {
  needsVerification = false;         // 之后跑了一次 bash 命令
}
```

`MUTATING_TOOL_NAMES = {write, edit}`，`VERIFICATION_TOOL_NAMES = {bash}`。思路是：如果 agent
改了文件，它应当（在启用验证提醒时）跑一条命令来检查自己的工作，再宣告完成。这是一个小而真实的
防护，防止「agent 说做完了但从未验证」。

## 分支 B — 模型返回了最终答案

```ts
const outputText = response.assistantText?.trim() || "No response generated.";
const assistantMessage = createAssistantMessage(outputText);
turnMessages.push(assistantMessage);

const contextUpdated = await this.context.appendMessages(
  turnMessages, this.provider, this.systemPrompt, this.toolSchemas,
  { turnId }, { usage: response.usage },
);

return {
  completionStatus: "completed",
  outputText,
  steps: step,
  toolExecutions,
  contextSummary: this.context.getSummary(),
  contextMessageCount: this.context.getRecentMessages().length,
  contextUpdated,
  ...
};
```

当没有工具调用时，本轮结束。转录（`turnMessages`）交给 `context.appendMessages`，
它把内容持久化，并可能**压缩**（compaction，把更早的消息摘要化）以保持在 token 预算内。
详见 [上下文管理](./04-context-management.md)。

## Max-steps 与合成

如果循环耗尽了 `maxSteps` 仍无最终答案，SigPi 会在本地用已跑过的 `toolExecutions`（读过的文件、
跑过的命令、调用过的工具）加上 `currentGoal` 拼出兜底答案——`buildMaxStepsFallbackAnswer`。
**不再**发起最后一次模型调用，因此答案不会泄漏 `<tool_call>` 标记，也不会在第二次调用时因
服务商报错而失败。兜底答案会说明已达到上限、任务未完成，并提示输入 `go on` 继续；同时发出
`turn_max_steps_reached` 进度事件给出相同信号。该轮会被标记为可恢复（resumable），因此之后
输入 `go on` 会从已持久化的 checkpoint 续做同一任务（带着全新的 `maxSteps` 预算），而不是重跑
同样的步骤（ADR 0018）。

## 轮内 checkpoint 压缩

在一轮较长时，`workingMessages` 自身也可能超出预算。`maybeCompactWorkingMessages()`
监视估计 token 数，一旦超过 `hardContextLimit - reserveTokens`，就把本轮的*早段*摘要成 checkpoint，
只保留最后 `TURN_CHECKPOINT_KEEP_LAST_MESSAGES`（**4**）条消息，并以 checkpoint 为前缀重建
`workingMessages`。于是模型能在长任务上持续工作而不丢线索。（完整的上下文管理在下一章。）

## 中断

`interruptController?.throwIfInterrupted()` 在每步顶部、每个工具之后都被检查。若用户按下
escape，当前状态会被**checkpoint**（不会丢失），本轮返回 `completionStatus: "interrupted"`，
并带上迄今收集的一切。中断详见 [真实世界的考量](./08-real-world-concerns.md)。

## 关键收获

- 一轮是一个**循环**，由 `maxSteps` 限定上限，而不是一次调用。
- 两个消息列表：`workingMessages`（模型的窗口）vs `turnMessages`（本轮转录）。
- 循环完全由「模型是否返回 `toolCalls`」驱动。
- 真实的防护已经就位：**去重**、**验证跟踪**、**轮内 checkpoint**、**触顶本地兜底**、**中断**。
  它们都不是「框架魔法」——各自只有几十行，而你刚刚把全部读完了。

下一步：[Function Calling](./03-function-calling.md) — 一个 `toolCall` 到底是什么，以及模型如何
被邀请产生它。

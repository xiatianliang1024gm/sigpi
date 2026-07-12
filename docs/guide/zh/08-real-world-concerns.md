# 8. 真实世界的考量（进阶）

玩具 agent 会循环、会调用工具。*能用*的 agent 还会处理出错的事。本章覆盖 `runTurn`
（`src/agent/runner.ts`）里已经存在的三道防护。都不大；但正是它们区分了 demo 与你能真正跑的东西。

## 中断（Interruption）

长 agent 运行应当可取消。`runTurn` 在每步顶部、每个工具之后都检查一个中断控制器：

```ts
interruptController?.throwIfInterrupted();
```

用户按下 escape 时，控制器抛出 `TurnInterruptedError`。循环捕获它并调用 `finishInterruptedTurn`，
该方法**checkpoint** 迄今收集的工作（`context.appendRecoveryMessages`），并返回：

```ts
{
  completionStatus: "interrupted",
  outputText: null,
  toolExecutions,   // 迄今所做的一切都被保留
  ...
}
```

没有工作丢失——下一轮可以从 checkpoint 续上。这就是为什么循环把 `interruptController` 穿过模型调用
和每次工具执行。

## 验证提醒（Verification reminder）

改完文件后，agent 应当检查自己的工作。SigPi 用两个小集合跟踪这件事：

```ts
const MUTATING_TOOL_NAMES = new Set(["write", "edit"]);
const VERIFICATION_TOOL_NAMES = new Set(["bash"]);

if (MUTATING_TOOL_NAMES.has(toolCall.name) && result.ok) {
  needsVerification = true;
} else if (needsVerification && VERIFICATION_TOOL_NAMES.has(toolCall.name)) {
  needsVerification = false;
}
```

当本轮抵达最终答案且 `enableVerificationReminder` 开启时，runner 注入一条提醒，告诉模型在结束前
跑一条窄的验证命令。**注意这个标志默认是 `false`**——机制已存在且接好线，但是 opt-in。这是有意的：
它展示了这个模式，又不强迫你可能不想要的行为。

## Max-steps 合成

`maxSteps`（默认 8）限定循环。若它被耗尽而仍无最终答案，SigPi 不会直接放弃：

```ts
const response = await this.provider.generate({
  messages: [...workingMessages, createSystemMessage(MAX_STEPS_SYNTHESIS_PROMPT)],
  tools: [],
  ...
});
```

合成提示告诉模型停止请求工具、基于已收集内容作答。若连这也失败或返回垃圾（例如残留的工具调用标记），
`buildMaxStepsFallbackAnswer` 生成一份语言无关的「目标 + 已收集工具结果」摘要——于是用户总能拿到
某种连贯回复，而不是崩溃。

## 关键收获

- **中断** 是在每步/每个工具处检查的信号，并带 checkpoint，于是没有工作丢失。
- **验证** 是一个小状态标志（改了文件 → 期望一次 bash 检查），藏在 opt-in 标志后。
- **Max-steps** 是硬上限加优雅的合成兜底。
- 每道防护都只有几十行。教训是：agent 的健壮性大多是 handful 的小而明确的检查——不是一个框架。

下一步：[更高阶：TUI / skills / plan-tracker / background](./09-higher-level.md)。

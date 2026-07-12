# Loop Prevention 与确定性工作记忆

## 背景

复杂代码库任务中，agent 容易出现反复搜索、反复读文件、压缩后忘记已探索内容的问题。根因通常不是模型能力不足，而是上下文系统缺少稳定的工作记忆：

- 搜索和读文件结果以大块文本进入 `recentMessages`
- 大块工具输出触发上下文压缩
- 压缩摘要不稳定保存“搜过什么、读过哪些文件、哪些路径是候选、下一步是什么”
- 恢复后模型只能重新探索，形成搜索/压缩循环

本项目的 loop-prevention 改动目标是：不单纯扩大上下文窗口，而是给模型可见上下文增加硬上限，并把探索状态保存为确定性的结构化状态。

## 从 pi 学到的经验

`pi` 的关键经验是工具层先控流，再谈摘要质量：

- `read` 类工具有硬上限，例如行数和字符数限制。
- `grep`/搜索类工具默认限制匹配数，并截断长行。
- 大输出不直接进入模型上下文，而是提供 continuation 或下一步建议。
- compaction 不是只保存一段自然语言摘要，还要保留 `readFiles`、`modifiedFiles` 等结构化 details。
- 子任务输出需要 cap，主 agent 只接收压缩结论。

对应到 `SigPi`，这次优先落地了工具输出预算和结构化探索 ledger，而不是先引入完整的 append-only compaction tree。

## 从 codex 学到的经验

`codex` 的关键经验是所有模型可见上下文必须有边界，并且上下文片段要有明确类型：

- 工具结果、summary、系统注入片段都要有硬上限。
- 长期目标和进度状态不应依赖模型自己从完整历史中重新推断。
- `update-plan` 更适合作为 UI/进度状态，不应把完整计划反复塞回模型上下文。
- subagent fork 时要过滤工具历史、reasoning 和大输出，默认只传必要上下文。
- 模型上下文中的状态片段应有明确 marker，方便压缩和调试。

对应到 `SigPi`，这次新增了短的 `Exploration state` system fragment，并把完整工具历史之外的探索事实写进 session state。

## SigPi 的落地实现

### 1. 工具输出预算

相关文件：

- `src/tools/builtin/grep.ts`
- `src/tools/builtin/bash.ts`
- `src/agent/messages.ts`

`grep` 的改动：

- 默认 `output` 从 `lines` 调整为 `files`，鼓励先找候选文件，再局部读文件。
- 返回 `totalMatchCount`、`returnedMatchCount`、`truncated`、`nextSuggestedQuery`。
- 对搜索结果做总字符数限制、单行长度限制、每文件匹配数限制。
- 截断时提示继续收窄 query/glob，或先使用 `output:"files"`。

`bash` 的改动：

- 长 stdout/stderr 改成 head/tail 截断。
- 测试日志、diff、大命令输出不会只保留开头而丢失结尾错误。

通用 tool message 的改动：

- `createToolMessage()` 增加最终硬上限。
- 即使未来某个工具忘记自己限流，也不会把无界文本直接写进模型上下文。

### 2. ExplorationLedger

相关文件：

- `src/agent/exploration-ledger.ts`
- `src/types.ts`
- `src/agent/context.ts`
- `src/agent/runner.ts`

新增 `ExplorationLedger`，保存：

- `searchedQueries`
- `candidateFiles`
- `readRanges`
- `rejectedPaths`
- `keyFindings`
- `modifiedFiles`

更新方式是确定性的：

- `AgentRunner` 每次工具执行后调用 `context.recordToolExecution()`
- `ConversationContext.appendMessages()` 和 `appendRecoveryMessages()` 会从消息中补建 ledger
- 旧 session 即使没有显式 ledger 字段，也能从 assistant tool call 和 tool message 中恢复部分探索状态

这避免了把“是否搜过、是否读过”完全交给 LLM summary 生成。

### 3. 模型上下文注入

相关文件：

- `src/agent/context.ts`
- `src/agent/exploration-ledger.ts`

`buildMessages()` 会在 summary 之后注入短的 system fragment：

```text
Exploration state:
Searches already run:
- ...
Candidate files:
- ...
Files/ranges already read:
- ...
Use this state to avoid repeating equivalent searches or rereading the same ranges unless the file may have changed.
```

这个片段有字符上限，只保留最近和最有用的结构化事实。它的目的不是替代 summary，而是给模型一个稳定的“不要重复探索”的工作记忆。

### 4. Compaction 保留探索事实

相关文件：

- `src/agent/context.ts`
- `src/agent/messages.ts`

summary prompt 增加 `<exploration-ledger>`，要求摘要保留：

- searched queries
- candidate files
- read ranges
- modified files
- rejected paths

fallback summary 也会追加 `## Exploration Details`，避免 summary 模型输出被截断或失败时丢失关键探索状态。

同时，`renderMessagesForSummary()` 原本已经对 tool message 做 2k 截断，这次保留该策略，并在更前面的 tool message 层增加硬上限。

### 5. Session 持久化

相关文件：

- `src/session/store.ts`
- `src/session/runtime.ts`
- `src/types.ts`

session state 增加可选 `explorationLedger`：

- `markTurnCompleted()` 保存 ledger
- `updateSnapshot()` 保存恢复快照中的 ledger
- failed / interrupted turn 也保留已有 ledger
- `sessionToContextState()` 恢复 ledger

schema 中该字段是 optional，旧 session 文件仍可读取。

## 当前没有做的部分

这次改动先解决主循环中的重复探索和大输出污染，没有一次性实现完整方案中的所有层：

- 没有重写 session 存储为 pi 风格 append-only entry tree。
- 没有新增持久 `task_state` 独立层。
- 没有实现 `spawn_explorer` / `parallel_explore` 子 agent 工具。
- 没有改变 `update-plan` 的 UI 状态定位。

这些可以作为后续阶段继续做。当前版本已经把最容易导致死循环的两个问题压住：工具输出无界和压缩后遗忘探索状态。

## 验证覆盖

相关测试：

- `test/tools.test.ts`
  - `grep` 截断元数据
  - `bash` head/tail 截断
- `test/context.test.ts`
  - ledger 从工具消息中提取
  - `Exploration state` 注入
  - summary prompt 包含 exploration ledger
- `test/session-store.test.ts`
  - ledger 持久化与恢复
- `test/session-runtime.test.ts`
  - failed-turn recovery 在新增 system fragment 后仍可继续

验证命令：

```bash
pnpm test
git diff --check
```


## 第二轮修复（2026-07-08）

本轮进一步压住编码任务场景下的「压缩 → 丢事实 → 重新读 → 再压缩」循环。这里只列概要。

### 关键改动

- **单条 tool message 上限 60k → 8k**：`src/agent/messages.ts` 用 head/tail 各 3k 拼接 + 中间省略段。
- **`keepLastMessages` 默认 8 → 16**：`src/agent/context.ts`、`src/config.ts`。production 路径从 config 注入默认 16。
- **Turn-level checkpoint split 边界修复**：`src/agent/runner.ts` 中 `findTurnCheckpointSplitIndex` 不再保留孤立 tool 消息。
- **客户端 dedup 拦截**：`src/agent/runner.ts` 中 `findRecentDuplicateToolCall` 在最近 6 条 assistant 消息内查找 `(toolName, normalizedArgs)` 重复，跳过 mutating/read 类工具，避免 read-after-compaction 被误杀。命中时返回 `repeated: true` 占位结果。
- **summary prompt 加硬约束**：`src/agent/context.ts` 中 `SUMMARIZATION_PROMPT` / `UPDATE_SUMMARIZATION_PROMPT` 末尾追加 `REQUIRED FACTS` 段，要求 verbatim 输出文件路径+区间、命令、错误、符号、用户决策。
- **fallback summary 增强**：`src/agent/context.ts` 中 `buildFallbackSummary` 从 `ledger.keyFindings` 和 `rejectedPaths` 抽取具体细节写入 Critical Context。
- **`resolveCurrentGoal` 多源校验**：`src/agent/runner.ts` 在 continuation 场景下检查 summary Goal / ledger keyFindings / 最近 user 消息，过滤掉与当前 input 相同或 continuation 类的候选。
- **`VERIFICATION_REMINDER` 改为 opt-in**：`src/types.ts` 新增 `enableVerificationReminder?: boolean`，默认 `false`，避免上下文紧张时多走一轮 `bash`。

### 顺手修掉的 bug

- `findRecentDuplicateToolCall` 原本会把刚 push 的当前 assistant 消息也算进扫描窗口，命中自己的 tool call，导致 step=1 全部被标记重复。新增 `findLastAssistantMessageIndex` 从前一条开始扫描。
- `findTurnCheckpointSplitIndex` 边界推进算法错误，会保留以孤立 tool 消息开始的「尾段」。

### 验证

```bash
pnpm test
```

267 / 267 通过。

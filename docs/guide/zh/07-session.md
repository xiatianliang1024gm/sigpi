# 7. 会话与持久化（进阶）

循环产出一轮；一个*会话*是一轮轮的序列，被保存下来，于是你可以关掉终端、以后再续。本章讲 SigPi
如何持久化与重建上下文。

## 两个状态所有者

- **`ConversationContext`**（`src/agent/context.ts`）持有*活动*状态：摘要、近期消息、entry stream、
  以及探索 ledger。运行时它是唯一真相来源。
- **`SessionStore`**（`src/session/store.ts`）持有*持久化*：把状态写入磁盘、再读回来。

循环只和 `ConversationContext` 对话。持久化是通过一个序列化模块处理的副作用。

## Entry stream

活动状态与磁盘之间的桥梁是 **entry stream**——一个只追加的条目列表（摘要条目、消息条目、压缩条目）。
一个模块独占它：

```ts
// src/session/format.ts — EntryStreamSerializer
buildEntriesFromContextState(state)      // 状态 -> 条目（从头建）
resolveEntriesForPersist(state, entries) // 状态 -> 条目（只追加合并）
deriveContextStateFromEntries(entries)   // 条目 -> 状态
```

`ConversationContext` 与 `SessionStore` 都委托给这里，于是转换逻辑只存在于一个地方。上下文始终是
唯一真相来源；store 只是记录它的 stream。

## 东西放哪

会话全局存储在 `~/.sigpi/projects/<project-key>/sessions/`。每个会话有一个 `index.json` 加它的
entry stream。`SESSION_VERSION`（当前为 `4`）标记格式，于是更老的会话文件能被检测/迁移。

## 续接（Resume）

续接时（REPL 里的 `/resume`，或 `chat --session <id>`），`SessionStore.loadSession` 读取 entry
stream，`deriveContextStateFromEntries` 重建活动上下文。两个指纹防止静默失配：

- **system-prompt 指纹** — 若系统提示自会话保存后变了，旧转录可能与新提示不匹配。
- **skills 指纹** — 对已加载 skills 同理。

失配不会崩溃；它产生一条**警告**（`loadedSession.warnings`），让你知道续接的上下文可能已过时。

## 关键收获

- 活动状态（`ConversationContext`）与持久化状态（`SessionStore`）是分离的关注点。
- entry stream + 一个序列化模块，是两者之间唯一的转换处。
- 续接就是「从保存的 entry stream 重建活动状态」，并用指纹标记漂移。
- 一个会话只是「持久化的轮次转录 + 压缩条目」——不需要专门的「agent 记忆」子系统。

下一步：[真实世界的考量](./08-real-world-concerns.md)。

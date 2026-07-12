# 0004 — entry stream 单一所有者

- **状态**：已接受
- **日期**：2026-07-12
- **提交**：`db809cd`

## 背景与问题

会话的 on-disk entry stream（`SessionEntry[]`）是会话持久化的核心。它的序列化
发生在 `src/session/format.ts` 的 `resolveEntriesForPersist`。该函数原先有
**两套**产生 entries 的逻辑：

1. 信任 `contextState.entries`（运行时路径，由 `ConversationContext` 维护的累积
   stream）；
2. 当调用方只给 `{summary, recentMessages}` 时，用一段 **ad-hoc 的 merge**
   （按 id 去重 + 随机补 id + 自行拼 compaction / 消息条目）从 `session.entries`
   延伸出新 stream。

第 (2) 套是第二生产者，且和 `hydrateState` 用来从 `{summary, recentMessages}`
合成 stream 的 `buildEntriesFromContextState` 逻辑**不一致**——同一个输入有两种
合成实现，违反了「entry stream 单一所有者」。

## 考虑过的方案

1. **收敛为单一合成 seam**（采用）：
   - 无 `contextState` → 返回 `session.entries`（调用方自有 stream）；
   - 有 `contextState` 且带 `entries` → 信任其累积 stream（运行时路径）；
   - 仅当调用方**未维护** `entries` 时，用 `hydrate` 同款 `buildEntriesFromContextState`
     合成「新窗口」，再**追加**到既有累积 `session.entries` 上。

2. 直接删除 fallback，换成 `buildEntriesFromContextState` **重建**窗口：
   `return buildEntriesFromContextState({summary, recentMessages})`。
   - 否决：这会在多轮场景**丢掉历史**。根因是 `store.writeSession` 的落盘方式是
     按 `entries.slice(prevCount)` 做**增量追加**，要求 `session.entries` 始终是
     **累积全量**。重建窗口（只含最新一轮）会使 `entries` 不再累积，delta 追加失效
     （`entries.length` 不增、不报错也不落盘新行）。多轮集成测试（`session store
     writes append-only transcript`）当场红——这是评审当初没料到的隐蔽契约。

## 决策结果

```ts
export function resolveEntriesForPersist(args): SessionEntry[] {
  if (!args.contextState) return args.session.entries;          // 调用方自有
  if (args.contextState.entries?.length) return args.contextState.entries; // 运行时：信任
  const base = args.session.entries ?? [];                      // 未维护 entries 的兼容路径
  const window = buildEntriesFromContextState({                 // 单一合成器（与 hydrate 同款）
    summary: args.contextState.summary ?? null,
    recentMessages: args.contextState.recentMessages ?? [],
    timestamp: args.timestamp,
  });
  return [...base, ...window];                                 // 追加，保 append-only
}
```

删除了原 ad-hoc merge / id 去重 / 自行拼条目的重复逻辑。`hydrateState` 与
`resolveEntriesForPersist` 现在共用同一个合成 seam（`buildEntriesFromContextState`）。

## 后果

- **单一所有者**：运行时路径始终相信 `ConversationContext` 的累积 `entries`；
  非 stream-aware 调用方（legacy / 测试）经 `buildEntriesFromContextState` 合成
  窗口并追加，保持 append-only。
- **合成逻辑去重**：hydration 与 persistence 共用一处合成实现，不再各自维护一套。
- **行为不变**：运行时始终走「信任 `entries`」路径；legacy / test 调用方仍得到
  累积且 append-only 的 stream（多轮集成测试、restore 测试均保持原断言）。
- `session-format` 测试更新为断言「旧 transcript 保留 + 新窗口追加」的语义。
- biome + tsc 干净，全量 398/398 通过。

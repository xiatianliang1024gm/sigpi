# 0001 — 折叠会话存储生命周期方法的提交脚手架到私有 commit seam

- **状态**：已接受
- **日期**：2026-07-12
- **提交**：`6986d53`

## 背景与问题

`src/session/store.ts` 里有五个几乎同构的生命周期方法：

- `markTurnStarted`
- `markTurnCompleted`
- `updateSnapshot`
- `markTurnFailed`
- `markTurnInterrupted`

它们各自在方法尾部重复同一段「组装 `updated` → `writeSession(updated)` →
`writeIndex(upsertSummary(readIndex(), updated))」脚手架。这段落盘序列是会话
存储的**真实提交点**，却散落在五个地方，违反了 locality：任何关于「一次成功提交
必须同时刷新 meta 与 index」的不变量，都得在五处同步修改，漏一处就出现不一致。

新建会话（`createSession`）与恢复分支（`loadSession` 的损坏恢复）是语义上不同
的路径，不应被统一。

## 考虑过的方案

1. **提取私有 `commit(session)` 拥有 writeSession + writeIndex**（采用）。
   五个方法只负责「组装 `updated`，然后 `return this.commit(updated)`」。
2. 把 `createSession` / `loadSession` 的恢复分支也套进 `commit`。
   - 否决：`createSession` 要先写 meta 再建空 index，`loadSession` 的恢复分支
     是在读损坏数据时兜底重建，**语义不同**；套用会掩盖这些差异，反而降低可读性。

## 决策结果

新增私有方法：

```ts
private async commit(session: PersistedSession): Promise<PersistedSession> {
  await this.writeSession(session);
  await this.writeIndex(await this.upsertSummary(await this.readIndex(), session));
  return session;
}
```

它只负责「写 + 索引」这一件事（不是读-改-写）。五个生命周期方法的尾部从
~5 行脚手架替换为 `return this.commit(updated)`。`createSession` 与
`loadSession` 的恢复分支保持显式、不接入 `commit`。

## 后果

- **locality 提升**：提交点的不变量只在一处定义，新加生命周期方法只需组装
  `updated` 后 `return this.commit(updated)`。
- **未新增测试**：既有套件已经覆盖每个生命周期方法的落盘行为，重构未改变外部
  可观察行为，无需为 `commit` 单独加测试（避免为测试而外泄内部）。
- 行为不变。

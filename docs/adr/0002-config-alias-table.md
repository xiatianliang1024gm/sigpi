# 0002 — 用单一别名表统一 TOML 与运行时配置字段名

- **状态**：已接受
- **日期**：2026-07-12
- **提交**：`5d5a808`

## 背景与问题

`src/config.ts` 解析 TOML 配置时，需要把 `snake_case` 的 TOML 键映射到运行时
`camelCase` 的字段名，同时把运行时 schema 反向序列化成 `snake_case` 的示例
TOML。原先这套双向映射是**手写**的，与运行时 schema 的字段名**分离**在两处：

- 运行时 schema（`appConfigSchema` 的各子 schema）定义字段；
- TOML 解析/序列化时又另写一份 camel↔snake 对应表。

两处各自维护，字段一旦改名，映射表不会编译报错，只会在运行时静默错位——这是
典型的「单一事实来源」缺失。

## 考虑过的方案

1. **单一别名表驱动双向映射**（采用）。
   `appConfigSchema` 的子 schema 保持权威（字段类型与运行时的唯一来源）；
   新增 `MODEL_ALIASES` / `AGENT_ALIASES` / `LOGGING_ALIASES` /
   `STORAGE_ALIASES` / `SHELL_ALIASES` / `BASH_ALIASES`（camel↔snake，单一来源）。
   - `snakeFields(subSchema, aliases, strict=false)`：从子 schema 的 `.shape`
     取**类型**，从别名表取**键名**，派生出 TOML 侧的 schema。
   - `mapSection(raw, aliases)`：反转别名表，把 `snake_case` 原始段映射回
     运行时字段。
   - `tomlRootSchema` 由各子 schema 的 `snakeFields` 组合派生。
   - 反向守卫：若某个子 schema 字段在别名表里没有对应项，`strict` 模式在加载时
     抛错（防止「schema 有字段、别名表漏了」的漂移）。
   - 导出 `CONFIG_ALIASES`，让调用方（如默认配置渲染）复用同一来源。
2. 让 TOML schema 本身成为权威，运行时再映射过去。
   - 否决：会**重复定义**配置结构（运行时一份、TOML 一份），与「子 schema 权威」
     的设计目标相悖，反而增加漂移面。

## 决策结果

- 运行时 `appConfigSchema` 及其子 schema 继续作为类型与字段的**唯一权威**。
- 一份 `CONFIG_ALIASES` 同时驱动「TOML→运行时」与「运行时→示例 TOML」两个方向，
  消除第二套手写映射。
- `parseTomlConfig` 重写为基于 `mapSection` 的统一路径。
- `agent` / `model` / `models` 段保持 `.strict()`（未知键报错）；`logging` /
  `storage` / `shell` / `tools.bash` 不 strict（允许透传 provider 专属键）。

## 后果

- **单一事实来源**：字段改名只改一处（子 schema + 别名表），双向映射自动一致。
- 新增「别名表有、schema 无」或反之的守卫测试，防止漂移。
- 运行时行为完全不变；+205 / −107 行主要来自删除重复映射并补测试。
- biome + tsc 干净，390/390（当时）测试通过。

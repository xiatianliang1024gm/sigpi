# 9. 更高阶：TUI / skills / plan-tracker / background（更高阶）

前面几章讲了 agent 的*核心*——循环、函数调用、上下文、工具、模型层、会话、安全护栏。那些都不需要
用户界面、skill 系统、计划视图或后台任务。这四样是**建在核心之上的功能**，集中放在这里，以免它们
干扰主线。

本章的要点：一个小的、可读的 agent 核心，是一个你可以不断扩展、却不必动 `runTurn` 的稳定地基。

## TUI（`src/tui/`）

终端 UI 是 agent 的*前端*，不是 agent 逻辑的一部分。它提供：

- `Tui` — 帧/浮层管理器。
- `Editor` — 输入编辑器，使用光标标记（`CURSOR_MARKER`，一个 OSC 转义序列），于是 agent 能精确放置
  硬件光标。
- `SelectList` — 键盘在选项间导航。
- `ProcessTerminal` — 封装底层终端。

agent 核心与 UI 无关：`chat` 带不带 TUI 都能跑；循环不在乎哪个前端调用它。

## Skills（`src/skills/`）

Skills 是**指令文档**，遵循 [Agent Skills 规范](https://agentskills.io/specification)：一个带
`SKILL.md` 的目录，agent 读取并照做，通过 `bash` 工具自己运行其中引用的脚本。这里**没有单独的
skill 执行引擎**——skill 只是注入系统提示的一段文本。

发现机制（`loadSkillCatalog`）：

1. 项目 `.sigpi/skills` — 从工作目录向上走到文件系统根
2. 项目 `.agents/skills` — 同样的向上遍历
3. 全局 `~/.sigpi/skills`
4. 全局 `~/.agents/skills`

SigPi 自己的 `.sigpi` 命名空间优先于 `.agents`，且项目根优先于全局根。冲突会作为警告上报。

## Plan tracker（`src/plan-tracker.ts`）

一个轻量的、**内存中**的当前计划视图：一段说明加一组条目，每条带状态
（`pending` / `in_progress` / `completed`）。它驱动一个一目了然的 TUI 状态栏
（`formatPlanProgressSummary`，例如 `📋 2/5 ✅✅🔄⬜⬜`）。它刻意不持久化——它是当前运行的工作辅助，
不是保存上下文的一部分。

## 后台任务（`src/tools/background.ts`）

`bash` 工具可以把任务放到后台跑。`BackgroundTaskManager` 跟踪它们，**在运行时进程的生存期内只存于
内存**——续接或重启的会话不会恢复上一个进程的任務。每个任务把日志写到会话 `bash-outputs` 目录下
的每任务文件。

## 关键收获

- TUI、skills、plan tracker、后台任务都是*附加*在能跑的 agent 核心之上的。
- Skills 不增加执行引擎——它们只是提示里的指令。
- plan tracker 与后台任务都被刻意限定范围（内存中、不持久化），以保持核心简单。
- 这就是可读核心的真正回报：你能在上面建出惊人的多，而不必 fork 循环。

本指南到此结束。你已按顺序读完了 agent 循环、函数调用、上下文管理、工具、模型适配器、会话、真实世界
考量，以及更高阶功能。最好的下一步是打开 `src/agent/runner.ts`，把 `runTurn()` 从头到尾读一遍——
你会发现全都对得上。

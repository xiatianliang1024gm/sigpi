# 交接文档：多前端（TUI + Web）与会话控制器

> 状态：基于 ADR 0028 的改动之后。本文给出**现状、边界原则、以及两条待办的落地设计**：
> (A) git 只在 TUI 支持；(B) Web 端多目录 + 多会话。
> 全部结论都以当前源码为准，改动点均标注了文件与符号。

## 1. 背景与目标

需求：**底层 agent loop 统一**，支持多个交互前端（TUI、Web）。已完成的 ADR 0028
把"终端编排"从 `cli.ts` 抽成了无 UI 的会话层，这是本条线的地基。

**已就位（可直接依赖）**

- `AgentRunner`（`src/agent/runner.ts`）：纯事件驱动，零 UI 依赖，早已 headless。
- `SessionController`（`src/session/controller.ts`）：拥有一个 turn 的生命周期与
  `TurnInterruptController`，对外暴露 `submit()` / `requestInterrupt()` /
  `onProgress()`，并在 `setRuntime()` 时自动重绑 runner 订阅。**这是所有前端唯一
  需要持有的对象。**
- UI 中立表现层（`src/session/events.ts`）：`applyTurnProgress` 归约器 +
  `TurnTranscriptView` 接口 + run-stats。`ReplView`（TUI）`extends TurnTranscriptView`。
- `createAgentRuntime({ cwd, homeDir, store, config })`（`src/runtime.ts`）：已可注入
  cwd / home / store，不再只有 `process.cwd()` 一种形态。
- 会话按 cwd 归档：`resolveSessionStoragePaths`（`src/session/paths.ts`）用
  `createProjectKey(cwd)`（`<slug>-<sha256前16>`）把会话存到
  `~/.sigpi/projects/<projectKey>/sessions/`。**天然支持多目录** —— 每个 cwd 一个
  projectKey。
- 最小 HTTP/SSE 传输（`src/server/http.ts`、`src/server/sse.ts`）：`POST /message`、
  `POST /interrupt`、`GET /events`。目前是**单会话**的验证版。

## 2. 前端边界原则（务必遵守）

```
AgentRunner (纯事件, 无 UI)
   ↑ 被
SessionController  ← 每个会话一个；不 import 任何 tui/、不碰 process.*、不含 git
   ├── TUI:  ChatRenderer (ReplView) ← applyTurnProgress   [+ git 分支显示]
   └── Web:  createChatServer → SSE frames                  [无 git]
```

**底线**：`src/session/**` 与 `src/agent/**` 里**不得**出现终端、`pi-tui`、git 分支
采样、`process.cwd()/env` 的隐式读取。任何前端专属能力都必须留在该前端的接线层
（TUI 的 `cli.ts`；Web 的 `server/`），或抽象成可选的、由前端注入的扩展点。

## 3. 任务 A —— git 只在 TUI 支持

### 现状

git 分支能力已经**没有**进入共享层，位置是对的：

- 采样器 `src/git.ts` 是**模块级单例**：`startBranchWatcher(cwd)` /
  `getCachedBranch()` / `onBranchChange(listener)`（**只支持单个 listener**）。
- 只在 `runChatReplLoop`（`src/cli.ts`）里接线：`startBranchWatcher` / `onBranchChange`
  / `stopBranchWatcher`，把分支送进状态栏的 branch 段。
- `SessionController`、`session/events.ts`、`server/` 都**不引用** git。✅

### 结论与要求

1. **不要把 git 放进 `SessionController` 或 SSE 事件流。** Web 前端不显示分支，
   也就不需要为了它让共享层引入 `child_process` / chokidar 依赖。
2. git 属于 **TUI 的状态栏装饰**，保持它只由 `cli.ts` 驱动即可。若未来想让 Web 也
   显示分支，应做成**可选注入**（见下），而不是硬塞进 controller。
3. **不要**为了多会话去"改造 git 单例以支持多个 cwd"——那是 TUI-only 的展示需求，
   Web 不需要，属于无谓复杂度。多会话只会在 Web 端出现（见任务 B）。

### 可选的扩展点（仅当将来真需要跨前端显示状态时）

若要让"状态栏数据"成为前端可插拔的，而不是把 git 直接搬进去，建议：

- 定义一个纯数据接口，例如 `SessionStatusProvider { snapshot(): Promise<StatusSnapshot> }`，
  由 `cli.ts` 传入一个"含 git 分支"的实现，Web 传入一个"不含 git"的实现。
- `SessionController` 只透传/聚合该 provider 的结果，不感知 git 的存在。
- 现有 `getCachedBranch()` 的同步读取语义可保留在 TUI 的 provider 实现里。

> 本期**不必实现**该扩展点；只要保证 git 不越界即可。

## 4. 任务 B —— Web 端多目录 + 多会话

### 目标

Web 服务可以：(1) 让用户**添加多个项目目录**；(2) 在每个目录下**并行跑多个会话**；
(3) 会话之间互不串扰（各自的 runtime、工具、上下文、SSE 流、中断）。

### 关键设计：会话注册表（SessionRegistry）

引入一个**进程级**的注册表，按 `(cwd, sessionId)` 管理活跃会话，每个会话持有一个
`SessionController`：

```
SessionManager
 ├─ projects: Map<cwd, ProjectEntry>          // 已添加的目录
 └─ sessions: Map<sessionKey, SessionEntry>   // sessionKey = `${cwd}\u0000${sessionId}`
      SessionEntry = {
        controller: SessionController
        runtime: AgentRuntime
        cwd: string
        createdAt: number
        subscribers: Set<SSEClient>   // 每个打开的 /events 连接
      }
```

- **一个目录 = 一个 projectKey**（已在 `paths.ts` 实现），所以"添加目录"= 把 cwd
  登记进 `projects`，其会话文件自动落到该目录对应的 project 下。无需改存储层。
- **一个目录多个会话**：`createAgentRuntime({ cwd, createSession: true, store })` 每次
  产出独立 runtime + sessionId。用 `createRuntimeSessionStore({ cwd, homeDir })`
  复用同一 store。已支持，无需改 runtime。
- **懒创建**：会话在首次 `POST /message`（或显式 `POST /sessions`）时创建，避免
  空会话占用资源。
- **清理**：会话空闲超时 / 最后一个 SSE 连接关闭后一段时间，销毁 controller 并
  从 map 移除。**注意：当前 `AgentRuntime` 没有 `dispose()`**，`BackgroundTaskManager`
  也只有按 id 的 `stop(id)`（`src/tools/background.ts`），**没有批量释放**。所以
  多会话清理需要**先补齐**一个 runtime 级 `dispose()`（停后台任务、关文件 watch、
  释放 provider/HTTP 连接），否则每个结束的会话都会泄漏句柄。加 TTL 与并发上限。

### HTTP 路由改造

当前 `src/server/http.ts` 是单会话的（`options.session`）。改为按会话路由：

| 方法 | 路由 | 作用 |
| --- | --- | --- |
| `GET` | `/projects` | 列出已添加目录 |
| `POST` | `/projects` | 添加目录 `{ path }`（校验存在/可访问） |
| `GET` | `/projects/:key/sessions` | 列出该目录会话（可复用 session store 的 index） |
| `POST` | `/projects/:key/sessions` | 新建会话，返回 `{ sessionId }` |
| `GET` | `/sessions/:key/events` | 该会话的 SSE 流（`key` 用 sessionKey 或其编码） |
| `POST` | `/sessions/:key/message` | 提交一轮 |
| `POST` | `/sessions/:key/interrupt` | 中断当前轮 |
| `DELETE` | `/sessions/:key` | 结束并清理会话 |

- 路由里通过 `SessionManager.get(sessionKey)` 拿到该会话的 `SessionController`，
  `handleEvents` / `handleMessage` / `handleInterrupt` 的逻辑与现状一致，只是**从
  registry 取 controller** 而非读单个 `options.session`。
- SSE 帧格式不变（`TurnProgressEvent` 直传）——前端归约器无需改。

### 并发与隔离要点

- **每个会话独立 runtime**：工具注册表、上下文、后台任务管理器都是 per-runtime，
  天然隔离。（`BackgroundTaskManager` 已 per-runtime；见 `src/runtime.ts`。但缺
  bulk `dispose()`，见上。）
- **注意模块级单例**：`src/git.ts` 是全局单例——**Web 不启用 git，所以不受影响**；
  但这也正是"git 不进共享层"的另一个理由：一旦共享层用了单例，多会话就会互相覆盖。
  接 Web 时**不要**调用 `startBranchWatcher`。
- **cwd 注入**：`createAgentRuntime({ cwd })` 已参数化。工具本身**不直接接收 cwd**：
  工具由 `createDefaultToolRegistry(shellRuntime, config.tools.bash)`
  （`src/runtime.ts`）创建，**工作目录经 `AgentRunner` 的 `options.workingDirectory`
  绑定**（同为 `cwd`），工具的路径解析以它为根。因此多目录只需给每个 runtime 传
  正确的绝对 cwd，工具即自动以该目录为工作区。
- **背压/限流**：一个会话同时只允许一轮（`SessionController.isTurnActive()` 已可用于
  返回 `409 turn_in_flight`）；SSE 每连接一个 listener，断开必须 `unsubscribe`。
- **鉴权**：Web 服务默认只绑 `127.0.0.1`；若对外暴露，必须加认证，因为工具能执行
  bash/写文件（当前无沙箱，见系统提示）。

### 前端归约复用

浏览器端**照抄** `applyTurnProgress`（`src/session/events.ts`）即可：SSE 的 `message`
帧就是 `TurnProgressEvent`，按 `type` 分发到 `beginAssistantMessage` /
`beginToolLine` / `appendSystem`。这意味着 Web reducer 与 TUI reducer 同源，行为一致。

## 5. 建议实施顺序

1. **SessionManager（内存）**：`projects` + `sessions` 两张 map，`create/get/dispose`。
   先写单元测试，用 fake `createAgentRuntime` 依赖注入。✅
2. **路由改造**：把 `server/http.ts` 从单会话改为按 `sessionKey` 取 controller；
   保留旧接口作为"默认会话"的便捷入口（可选）。✅（旧单会话 `createChatServer`
   保留；新增按 `projectKey`/`sessionId` 路由的多会话服务）
3. **多目录 API**：`/projects` 增删查 + 目录校验；会话列表复用 session store index。✅
4. **生命周期**：空闲 TTL、连接关闭清理、`dispose()` 串接。✅
5. **前端**：最小页面，`EventSource` 订阅 + `applyTurnProgress` 移植。✅
   （`src/server/web/`，由多会话服务同源托管，详见 §5.2）
6. **安全**：鉴权、绑定回环、cwd 白名单。部分：默认绑定 `127.0.0.1` 且有警告；
   鉴权 / 白名单仍未实现。

## 5.1 本次落地现状（与 §4 设计的差异）

- **runtime `dispose()` 已补齐**（§4/§6 的前置）：
  `BackgroundTaskManager.dispose()` 批量 SIGTERM→SIGKILL 所有运行中的后台任务并清空；
  `AgentRuntime.dispose()` 串接它。多会话退役时会调用。
- **`SessionManager`**（`src/server/manager.ts`）：进程级 `projects`/`sessions` 注册表，
  `addProject`/`listProjects`/`removeProject`、`createSession`/`getSession`/`listSessions`、
  `disposeSession`/`disposeAll`/`sweepIdle`。`createRuntime`/`createController`/
  `listStoredSessions`/`now` 均可注入（测试用 fake）。`maxSessions` 限并发；`idleTtlMs`
  驱动 `sweepIdle`（跳过 `isTurnActive()` 的会话）。会话语义 key 为 `${cwd}\u0000${sessionId}`，
  但 HTTP 层不把 `cwd` 放进 URL（见下）。
- **HTTP 路由（`src/server/multi.ts`）**：按 `projectKey` 定位目录，避免 `cwd`/NUL 进入 URL：
  `GET/POST /projects`、`POST /projects/pick`（在**服务端主机**弹出原生文件夹选择框，
  返回 `{ path }`；取消为 `{ path: null }`；主机无可用选择器时 `501 picker_unavailable`）、
  `DELETE /projects/:key`、`GET/POST /projects/:key/sessions`、
  `GET /projects/:key/sessions/:id/events`、`GET /projects/:key/sessions/:id/messages`
  （分页读取持久化历史，最新一页在前：`?limit=` 默认 30、`?before=` 为游标，
  返回 `{ items, cursor }`，`cursor` 为 `null` 表示已到最早；只读存储，不要求会话在活跃）、
  `POST .../message`、`POST .../interrupt`、
  `DELETE /projects/:key/sessions/:id`。SSE/消息处理直接复用 `http.ts` 导出的
  `handleSessionEvents` / `handleSessionMessage`，帧格式不变。原生选择器实现见
  `src/server/directory-picker.ts`（win32 现代 `IFileDialog`+`FOS_PICKFOLDERS` / macOS
  `choose folder` / Linux `zenity`→`kdialog`），通过 `pickDirectory` 选项注入以便测试。
- **CLI**：新增 `sigpi serve [--host] [--port] [--idle-ttl <ms>] [--max-sessions <n>]`
  （`src/server/serve.ts`），默认绑定 `127.0.0.1:7878`，Ctrl+C/SIGTERM 时
  `disposeAll()` + 关服务；非回环地址打印警告。
- **测试**：`test/session-manager.test.ts`、`test/chat-server-multi.test.ts`、
  `test/serve-args.test.ts`，以及既有的 `test/chat-server.test.ts`。

## 5.2 Web 浏览器客户端

`src/server/web/` 是零构建的原生 ES module 页面，由多会话服务**同源**托管（无 CORS）：

- `index.html` / `styles.css` / `app.js`：极简 UI —— 项目列表 + `Choose folder…` 按钮 +
  新建/恢复会话 + 聊天流 + 输入框 + 中断按钮。添加项目时不再手输路径：点击按钮让服务端
  弹出原生文件夹选择框（`POST /projects/pick`），选中后 `POST /projects` 登记。SSE 用
  `EventSource` 订阅 `.../sessions/:id/events`。点击某个会话时会先拉取**最近一页**历史
  （`GET .../messages?limit=30`，服务端 `src/server/history.ts` 把持久化的 entry 流投影成
  可渲染的 `user`/`assistant`/`tool`/`compaction` 项），滚动到顶部或点击 `Load earlier
  messages` 再按 `cursor` 分页向前加载更早的内容（prepend，保持阅读位置）。
- `reducer.js`：`applyTurnProgress` 的**逐行移植**（`src/session/events.ts`），并导出
  `isTurnTerminalEvent` / `formatCompactionMessage`。因为 SSE 的 `message` 帧就是
  `TurnProgressEvent`，浏览器归约器与 TUI 同源、行为一致。
- `src/server/static.ts`：只服务**固定白名单**路径（`/`、`/index.html`、`/app.js`、
  `/reducer.js`、`/styles.css`），无目录穿越面。由 `multi.ts` 的 `route()` 在进入
  `projects` 路由前处理。
- 资源通过 `scripts/copy-assets.mjs` 复制到 `dist/src/server/web/`，`import.meta.url`
  在构建产物与测试中都解析得到。
- 测试：`test/web-reducer.test.ts`（归约器语义）、`test/chat-server-multi.test.ts`
  （静态资源托管 + 404）、`test/web-app.test.ts`（jsdom 文档 + 伪造 `fetch`/
  `EventSource` 驱动 `app.js`：项目/会话接线、流式 transcript、发送/中断）。
- 局限：页面与 API 同源，`sigpi serve` 默认仅绑 `127.0.0.1`。鉴权/白名单仍未实现
  （见 §6）。浏览器 DOM 接线已由 `test/web-app.test.ts`（jsdom）覆盖，但**不是**真实
  浏览器渲染——CSS/布局与真实 `EventSource` 重连语义仍未验证。

## 6. 风险与未决问题

- **命令层仍读 view**：`chat-commands.ts` 的 `/resume`、`/new` 会摸
  `context.getState().view` 与 TUI 选择器。Web 端**不要复用**这些命令路径，或多会话
  下把它们改成返回"数据 + 动作"，由前端渲染。这是 Web 落地前需要单独处理的一块。
- **git 单例**：确认 Web 路径永不调用 `startBranchWatcher`（见 §4）。
- **runtime `dispose()` 缺失**：见 §4，需要先补齐 runtime 级批量释放（后台任务、
  watch、连接），否则多会话会泄漏句柄。
- **单进程 vs 多进程**：本设计是单进程内多会话。若规模大，可退化为"每会话一子进程"，
  但会增加 IPC 复杂度；先按单进程验证。
- **会话文件并发写**：同一 cwd 下多会话写各自 session 文件，互不冲突；但共享的
  `index.json` 写入需确认 `DiskSessionStore` 的并发安全（必要时加锁/队列）。

## 7. 关键文件索引

- 会话控制器：`src/session/controller.ts`
- UI 中立归约/事件/统计：`src/session/events.ts`
- 前端格式工具：`src/format.ts`
- Web 传输（单会话）：`src/server/http.ts`、`src/server/sse.ts`
- 会话注册表（多目录/多会话）：`src/server/manager.ts`
- Web 传输（多会话路由）：`src/server/multi.ts`
- 历史分页/投影：`src/server/history.ts`
- 原生文件夹选择框（跨平台，可注入）：`src/server/directory-picker.ts`
- Web 服务启动命令：`src/server/serve.ts`
- Web 浏览器客户端（零构建，同源托管）：`src/server/web/`、`src/server/static.ts`
- runtime 组装（cwd/store 注入点）：`src/runtime.ts`
- 会话归档（projectKey）：`src/session/paths.ts`、`src/session/store.ts`
- git（**TUI-only**，模块单例）：`src/git.ts`
- 决策记录：`docs/adr/0028-frontend-agnostic-session-controller.md`

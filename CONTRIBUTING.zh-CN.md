# 为 SigPi 做贡献（Contributing to SigPi）

欢迎来到 SigPi。这个项目是一个参考实现（reference implementation）——「built to be borrowed（生来就是拿来改的）」是设计目标，不是口号。整个仓库小到一个下午就能读完，任何让代码更小、更清晰、测试更完善的努力都受欢迎。同样欢迎批评：如果 agent 循环、工具接口或上下文管理里有什么地方难以理解，那是设计上的缺陷，把它写成一个 issue 本身就是实打实的贡献。

- [先读这些](#先读这些)
- [开发环境](#开发环境)
- [常用命令](#常用命令)
- [找活干](#找活干)
- [提交 issue](#提交-issue)
- [提交改动](#提交改动)
- [编码约定](#编码约定)
- [网站与文档](#网站与文档)
- [Review 与合并](#review-与合并)
- [许可证](#许可证)

## 先读这些

打开 issue 或 PR 之前，先花一个下午走一遍阅读路径——这正是这个项目存在的意义：

1. **README.md** — SigPi 能做什么、怎么跑起来。
2. **AGENTS.md** — 关键入口和代码分布。
3. **CONTEXT-MAP.md** — 项目统一术语表。**在 issue、PR 和代码里请使用这些术语。** 如果引入了新概念，把它加进这份文档，而不是自己发明同义词。
4. **src/agent/** — 只有 8 个小文件。这是核心：agent 循环、上下文、压缩（compaction）、回合失败处理。
5. **src/tools/** — 工具如何声明、校验、分发。

## 开发环境

- **Node.js ≥ 22.19.0**（见 `package.json` 的 `engines` 字段）
- **pnpm 11.x**（具体版本锁定在 `packageManager` 字段里——用错大版本 pnpm 会警告）
- **zsh** — 部分 shell 测试会直接调用 `zsh`，所以它必须在你的 `PATH` 里（CI 也会安装它）

```bash
git clone https://github.com/xiatianliang1024gm/sigpi
cd sigpi
pnpm install
```

就这样。没有代码生成，除了 `tsc` 之外没有额外构建步骤。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm check` | Biome 格式化 + lint + 全量测试。**这是门槛**——push 之前必须跑，pre-commit 钩子也会跑它。 |
| `pnpm test` | 先用 `tsc` 编译，再用 `node --test` 跑 `test/*.test.ts`。 |
| `pnpm test:provider` | 只跑 OpenAI 兼容 provider 的测试（针对假模型服务器）。改了 `src/model/` 时跑这个。 |
| `pnpm dev` | 构建并启动 REPL——用真实模型试你的改动。 |
| `pnpm fix` | 用 Biome 自动修复格式和 lint 问题。 |
| `pnpm release:check` | 完整 CI 门槛（check + provider 测试 + 打包冒烟测试）。本地一般不需要跑。 |

`pnpm test` 会先把代码编译进 `dist/`，所以测试跑的是编译产物——如果你改了类型而测试从 `../src/...` 导入，`tsc` 一步会帮你兜住。

## 找活干

- 先看**已开的 issue**。重点关注这些标签：`good first issue`、`bug`、`feature`、`docs`。
- 没有合适的 issue？下面这些事都确实有用：
  - **补一个测试。** 测试框架是 `node:test` + `assert/strict`，`test/helpers.ts` 里已经备好了 `MockProvider`——给某个边界情况补测试，就是一个完整的小 PR。
  - **修文档缺口。** 如果 README、CONTEXT-MAP 或官网哪里让你困惑了，那个困惑就是 bug。修掉它，并在 PR 里说明当初是什么绊住了你。
  - **写一份你的阅读心得。** 在 issue 里评论「`src/agent/` 里最难跟的是哪块」，往往能变成一份文档 PR。
  - **评审设计。** 开一个标题为「Design question: …」的 issue，谈谈你对循环、工具接口或压缩逻辑的看法。在这里，诚实的批评是一等贡献。
- 小改动不必先征求许可。较大的、方向不明确的改动，先开 issue 对齐方向再动手。

## 提交 issue

请使用模板（`.github/ISSUE_TEMPLATE/`）：bug 用 `bug_report.yml`，功能建议用 `feature_request.yml`。几点说明：

- **Bug 报告：** 请包含 SigPi 版本（`node dist/src/cli.js --version`）、Node.js 版本、所用的模型/provider，以及复现步骤。如果 agent 行为异常，`~/.sigpi/logs/agent.log` 里通常有记录——把相关段落贴上来。**如果涉及聊天会话，附上对应的 `.jsonl` 文件是最有价值的一件事：** 运行 `pnpm dev session list` 找到 session id，然后附上 `~/.sigpi/projects/<project>/sessions/<sessionId>.jsonl`。有了它我们可以精确回放整段对话。⚠️ 注意：这个文件包含完整对话内容，包括你粘贴过的代码或密钥——**先脱敏再上传**。
- **功能建议：** 请说明你想解决什么问题，而不是只报一个功能名。「我想直接对接 Anthropic」不如「我想用一个不兼容 OpenAI API 的模型」有价值。
- 如果涉及安全问题（比如提示注入、沙箱逃逸方面的担忧），**不要**开公开 issue——请发邮件给维护者，或用 GitHub 的私有漏洞报告。

## 提交改动

1. **Fork + 分支。** 分支名跟着工作走：`fix/compaction-trigger`、`feat/anthropic-adapter`、`docs/reading-path`。
2. **小而聚焦的提交。** 一次提交只做一件事；提交信息要说明做了什么、为什么。项目对提交信息没有额外约定——不需要 `fix!` 前缀，不需要 ticket 编号。
3. **让钩子替你干活。** `husky` 在提交时会跑 `pnpm check`。Biome 可能会顺手格式化你的文件，钩子会自动把它们重新暂存。
4. **补测试。** 新行为要有 `test/` 下的测试。如果修的是 bug，加一个能抓住它的回归测试。
5. **最后再跑一次 `pnpm check`**，然后开 PR。
6. **不要改 `package.json` 里的版本号**——版本由维护者用 `scripts/release.sh` 管理。PR 里改版本只会制造冲突，请留给我们。
7. **对 `main` 开 PR**，用 PR 模板，并关联它关闭的 issue（例如 `Closes #12`）。

### Import 与测试约定

- 测试放在 `test/*.test.ts`（平铺，对应 `pnpm test` 里的 `node --test` 通配符）。
- 全项目 ESM：导入源码写作 `import { x } from "../src/config.js"`——注意即使文件是 `.ts`，后缀也是 **`.js`**；`tsc` 会按同样的目录结构输出到 `dist/`。
- 用 `node:assert/strict`。`test/helpers.ts` 提供了 `MockProvider` 和临时 session 辅助函数——优先复用，别自己重造。

## 编码约定

- **格式与 lint 全部由 Biome 自动化**（作用于 `src/**/*.ts`、`test/**/*.ts`）。别跟它较劲——跑 `pnpm fix` 然后把结果提交。
- **小文件、可见的接缝。** 如果一个模块大到「一口气读不完」，它多半在干两件事。在引入新抽象之前，先检查项目是否已有现成的接缝（工具注册表、`ModelProvider`、session store）。
- **使用 CONTEXT-MAP 术语。** 引入新概念时，在 `CONTEXT.md` / `CONTEXT-MAP.md` 里定义一次并从代码链接过去，而不是到处散落解释。
- **纯 TypeScript，无框架。** 项目刻意不引入 agent 框架。新代码应当和它加入的地方一样少依赖；新增运行时依赖必须有充分理由。

## 网站与文档

`web/` 是同一个 pnpm workspace 里的 Astro 站点。

```bash
cd web
pnpm dev       # 本地预览
pnpm build     # 生产构建
```

文档类 PR 改动的是 `README.md`、`CONTEXT-MAP.md` 或 `web/src/pages/`。官网语气应与项目一致：短句、不吹嘘、数字与仓库保持一致。

## Review 与合并

- CI 会在每次 push 和 PR 上跑 `pnpm release:check`（Node 24）。**CI 必须全绿。**
- 维护者会 review PR；期待的是提问而不是敌意。如果 reviewer 追问为什么，多半说明代码没有看起来那么显然。
- 首次贡献者：你的第一个 PR 对项目来说是一个里程碑——谢谢你。它也会让你出现在发布说明的贡献者名单里。

## 许可证

SigPi 采用 MIT 协议。提交贡献即表示你同意你的贡献以 MIT 协议授权（见 [LICENSE](./LICENSE)）。

# Contributing to SigPi

> **中文版：[CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)**

Thanks for being here. SigPi is a reference implementation — "built to be borrowed" is a design goal, not a slogan. The repo is small enough to read in an afternoon, and every contribution that makes it smaller, clearer, or better tested is welcome. Critique is welcome too: if something in the agent loop, tool interface, or context management is hard to follow, that is a bug in the design, and an issue describing it is a real contribution.

- [Reading first](#reading-first)
- [Development setup](#development-setup)
- [Commands](#commands)
- [Finding work](#finding-work)
- [Filing issues](#filing-issues)
- [Submitting changes](#submitting-changes)
- [Code conventions](#code-conventions)
- [Website & docs](#website--docs)
- [Review & merging](#review--merging)
- [License](#license)

## Reading first

Before opening an issue or a PR, spend one afternoon on the reading path — it is the whole point of the project:

1. **README.md** — what SigPi does and how to run it.
2. **AGENTS.md** — key entry points and where things live.
3. **CONTEXT-MAP.md** — the ubiquitous language. **Use these terms in your issues, PRs, and code.** If you need a new concept, add it there rather than inventing a synonym.
4. **src/agent/** — eight small files. This is the heart: the agent loop, context, compaction, turn failures.
5. **src/tools/** — how tools are declared, validated, and dispatched.

## Development setup

- **Node.js ≥ 22.19.0** (see `engines` in `package.json`)
- **pnpm 11.x** (the exact version is pinned in the `packageManager` field — pnpm will warn if you use another major)
- **zsh** — some shell tests invoke `zsh` directly, so it must be on your `PATH` (CI installs it too)

```bash
git clone https://github.com/xiatianliang1024gm/sigpi
cd sigpi
pnpm install
```

That's it. No codegen, no build step beyond `tsc`.

## Commands

| Command | What it does |
|---|---|
| `pnpm check` | Biome format + lint + full test suite. **This is the gate** — run it before pushing, and the pre-commit hook runs it too. |
| `pnpm test` | Compiles via `tsc`, then runs `test/*.test.ts` with `node --test`. |
| `pnpm test:provider` | Runs only the OpenAI-compatible provider tests against a fake model server. Run this when you touch `src/model/`. |
| `pnpm dev` | Builds and starts the REPL — try your change against a real model. |
| `pnpm fix` | Auto-fixes formatting and lint issues with Biome. |
| `pnpm release:check` | The full CI gate (check + provider tests + pack smoke test). You normally don't need this locally. |

`pnpm test` compiles into `dist/` first, so tests run against compiled output — if you change a type and a test imports from `../src/...`, the `tsc` step will catch it for you.

## Finding work

- Look for **open issues** first. Labels to watch: `good first issue`, `bug`, `feature`, `docs`.
- No issue matches? All of these are genuinely useful:
  - **Add a test.** The suite is `node:test` + `assert/strict`, and `test/helpers.ts` ships a `MockProvider` — adding coverage for an edge case is a complete, small PR.
  - **Fix a doc gap.** If the README, CONTEXT-MAP, or website confused you, that confusion is a bug. Fix it and say what tripped you up in the PR.
  - **Write up your reading path.** A comment on an issue ("here's what was hardest to follow in `src/agent/`") often turns into a docs PR.
  - **Review a design.** Open an issue titled "Design question: …" with your critique of the loop, tool seam, or compaction. Honest critique is a first-class contribution here.
- Don't feel you need to ask permission before starting small work. For larger or ambiguous work, open an issue first so the direction is agreed before the code.

## Filing issues

Use the templates (`.github/ISSUE_TEMPLATE/`): `bug_report.yml` for bugs, `feature_request.yml` for features. A few notes:

- **Bug reports:** include your SigPi version (`node dist/src/cli.js --version`), Node.js version, the model/provider you used, and reproduction steps. If the agent misbehaved, the log at `~/.sigpi/logs/agent.log` usually has the receipts — paste the relevant section. **If a chat session was involved, attaching its `.jsonl` file is the single most useful thing you can do:** run `pnpm dev session list` to find the session id, then attach `~/.sigpi/projects/<project>/sessions/<sessionId>.jsonl`. We can replay the exact conversation from it. ⚠️ That file contains the full conversation, including any code or secrets you pasted — redact it before attaching.
- **Feature requests:** explain the problem you're solving, not just the feature name. "I want to talk to Anthropic directly" is weaker than "I want to use a model that doesn't speak the OpenAI-compatible API".
- If you're reporting a security issue (e.g. a prompt-injection or sandbox-escape concern), **don't** file a public issue — email the maintainers or open a private vulnerability report on GitHub.

## Submitting changes

1. **Fork + branch.** Name the branch after the work: `fix/compaction-trigger`, `feat/anthropic-adapter`, `docs/reading-path`.
2. **Small, focused commits.** One logical change per commit; the message should say *what* and *why*. The project uses no commit-message convention beyond that — no `fix!` prefixes, no ticket IDs required.
3. **Let the hooks work for you.** `husky` runs `pnpm check` on commit. Biome may reformat your files; the hook re-stages them automatically.
4. **Add or update tests.** New behavior needs a test in `test/`. If you fixed a bug, add a test that would have caught it.
5. **Run `pnpm check`** one last time before opening the PR.
6. **Don't bump the version** in `package.json` — maintainers version via `scripts/release.sh`. Version bumps in PRs cause merge conflicts, so leave it alone.
7. **Open the PR** against `main` using the PR template. Link the issue it closes (e.g. `Closes #12`).

### Import & test conventions

- Tests live in `test/*.test.ts` (flat, mirroring the `node --test` glob in `pnpm test`).
- ESM throughout: import source as `import { x } from "../src/config.js"` — note the **`.js` suffix** even though the file is `.ts`; `tsc` emits the same layout into `dist/`.
- Use `node:assert/strict`. `test/helpers.ts` provides `MockProvider` and temp-session helpers — reuse them instead of rolling your own.

## Code conventions

- **Formatting & linting are automated by Biome** (`src/**/*.ts`, `test/**/*.ts`). Don't fight it — run `pnpm fix` and commit the result.
- **Small files, visible seams.** If a module grows past "readable in one sitting", it's probably doing two things. Before adding a new abstraction, check whether the project already has a seam for it (tool registry, `ModelProvider`, session store).
- **Use CONTEXT-MAP terms.** When you introduce a concept, define it once in `CONTEXT.md` / `CONTEXT-MAP.md` and link it from code, instead of scattering explanations.
- **Plain TypeScript, no framework.** The project deliberately has no agent framework. New code should be as dependency-free as the code it joins; a new runtime dependency needs a strong reason.

## Website & docs

`web/` is an Astro site in the same pnpm workspace.

```bash
cd web
pnpm dev       # local preview
pnpm build     # production build
```

Docs PRs touch either `README.md`, `CONTEXT-MAP.md`, or `web/src/pages/`. The website's tone should match: short sentences, no marketing fluff, numbers that match the repo.

## Review & merging

- CI runs `pnpm release:check` on Node 24 for every push and PR. **Green CI is required.**
- Maintainers review PRs; expect questions, not hostility. If a reviewer asks why, there's a good chance the code isn't as obvious as it looked.
- First-time contributors: your first PR is a milestone for the project — thank you. It also gets you a `contributor` credit in the release notes.

## License

SigPi is MIT. By contributing you agree that your contributions are licensed under the MIT License (see [LICENSE](./LICENSE)).

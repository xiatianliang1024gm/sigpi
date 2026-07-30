# SigPi

> **An open-source coding agent you can actually read.**  
> Built in TypeScript. Runs in your terminal. Works with any OpenAI-compatible LLM.

SigPi is like Claude Code or Codex CLI — it reads your codebase, edits files, runs shell commands, and manages multi-turn sessions. The difference: **every line is written to be understood**. No framework magic, no sprawling abstractions. If you've ever wondered how a coding agent actually works under the hood, you can open the source and follow it from `cli.ts` all the way down to the agent loop.

SigPi's design is inspired by [Pi](https://github.com/earendil-works/pi), and its terminal UI is built on `pi-tui`, the TUI package from the same project.

---

## What it does

| | |
|---|---|
| 💬 **Chat with an LLM about your code** | Interactive REPL with session persistence |
| 🔍 **Search & navigate** | Built-in grep, glob, and file reading tools the agent uses autonomously |
| ✏️ **Edit files** | Exact string replacement + full-file writes |
| ⚡ **Run shell commands** | Bash with timeout, background tasks, and output streaming |
| 🧠 **Multi-turn memory** | Sessions survive restarts; long conversations auto-summarize to fit context windows |
| 🎯 **Plan tracking** | The agent tracks multi-step tasks so you can see progress at a glance |

---

## Quick start

```bash
# 1. Install
git clone https://github.com/xiatianliang1024gm/sigpi
cd sigpi
pnpm install

# 2. Configure
pnpm dev init
# Edit ~/.sigpi/config.toml with your API key and model

# 3. Chat
pnpm dev chat
```

That's it. You're talking to an agent that can see your code.

```bash
# One-shot question
pnpm dev ask "Explain how auth works in this project"

# Resume a previous session
pnpm dev chat --session <id>
```

---

## Why SigPi?

**It's a reference implementation, not a black box.** Most coding agents stack framework upon framework until the core loop is buried. SigPi keeps the agent loop, tool calling, and context management in plain sight. If you're building agents yourself or just want to understand how they tick, this is for you.

- **Minimal dependencies** — just OpenAI SDK, a TOML parser, and a terminal UI library
- **~60 source files** — small enough to read in an afternoon
- **Reading path** — start with [AGENTS.md](./AGENTS.md) for the key entry points, then [CONTEXT-MAP.md](./CONTEXT-MAP.md) for the ubiquitous language

---

## Requirements

- **Node.js ≥ 22.19.0**
- **pnpm**

---

## Configuration

SigPi works with any provider that speaks the OpenAI chat completions API (OpenAI, Anthropic via proxy, Ollama, LiteLLM, etc.).

```toml
# ~/.sigpi/config.toml
[models.default]
base_url = "https://api.openai.com/v1"
api_key  = "sk-..."
name     = "gpt-4o"
```

Overrides: `.sigpi/config.toml` in your project, or environment variables.

---

## More

- **Sessions**: `pnpm dev session new --title "fix login bug"` / `pnpm dev session list`
- **Inside chat**: `/summary`, `/compact`, `/history`, `/resume`, `/model`
- **Skills**: Drop a `SKILL.md` into `.sigpi/skills/` — the agent loads it automatically. Follows the [Agent Skills spec](https://agentskills.io/specification).
- **Logging**: `~/.sigpi/logs/agent.log` with daily rotation

---

## License

MIT. See [LICENSE](./LICENSE).

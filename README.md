# SigPi

<p align="center">
  <img src="assets/banner.png" alt="SigPi" width="100%">
</p>

> **中文版：[README.zh-CN.md](./README.zh-CN.md)**

> **An open-source coding agent you can actually read.**  
> Built in TypeScript. Runs in your terminal or your browser. Works with any OpenAI-compatible LLM.

SigPi is like Claude Code or Codex CLI — it reads your codebase, edits files, runs shell commands, and manages multi-turn sessions. The difference: **every line is written to be understood**. No framework magic, no sprawling abstractions. If you've ever wondered how a coding agent actually works under the hood, you can open the source and follow it from `cli.ts` all the way down to the agent loop.

The same agent core drives **two interchangeable frontends**: a terminal UI and a local web UI. They share one session controller and one turn-progress event stream, so a conversation behaves identically no matter which one you open. See [Frontends](#two-frontends-one-agent-core) below.

SigPi's design is inspired by [Pi](https://github.com/earendil-works/pi), and its terminal UI is built on `pi-tui`, the TUI package from the same project.

---

## Two frontends, one agent core

The agent loop, tool calling, and session control are UI-neutral. Two frontends sit on top of them:

| Frontend | Command | What it gives you |
|---|---|---|
| 🖥️ **Terminal (TUI)** | `pnpm dev chat` | An interactive REPL built on `pi-tui` — live status bar with git branch, scrollable transcript, IME-aware input |
| 🌐 **Web** | `pnpm dev serve` | A local browser UI (default `http://127.0.0.1:7878`) — add multiple project directories, run sessions in parallel, stream turns over SSE |

Because both consume the **same `TurnProgressEvent` stream**, the web client reuses the TUI's progress reducer verbatim — a turn plays out the same way in either frontend. The web server binds to loopback by default and uses a native folder picker to add projects.

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
| 🖥️🌐 **Multiple frontends** | The same agent runs in your terminal (TUI) or in a browser (web), with identical behavior |

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

# 3a. Chat in your terminal (TUI)
pnpm dev chat

# 3b. …or run the web UI instead
pnpm dev serve        # then open http://127.0.0.1:7878
```

That's it. You're talking to an agent that can see your code.

```bash
# Resume a previous session in the terminal
pnpm dev chat --session <id>

# Web options: bind address, port, idle TTL, concurrency cap
pnpm dev serve --host 127.0.0.1 --port 7878 --idle-ttl 600000 --max-sessions 8
```

---

## Why SigPi?

**It's a reference implementation, not a black box.** Most coding agents stack framework upon framework until the core loop is buried. SigPi keeps the agent loop, tool calling, and context management in plain sight. If you're building agents yourself or just want to understand how they tick, this is for you.

- **Minimal dependencies** — just OpenAI SDK, a TOML parser, and a terminal UI library; the web frontend is a zero-build browser client with no extra tooling
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
base_url = "https://api.deepseek.com"
api_key  = "sk-..."
name     = "deepseek-v4-flash"
```

Overrides: `.sigpi/config.toml` in your project, or environment variables.

---

## More

- **Sessions**: `pnpm dev session new --title "fix login bug"` / `pnpm dev session list`
- **Inside chat**: `/compact`, `/resume`, `/model`
- **Web frontend**: `pnpm dev serve [--host <host>] [--port <port>] [--idle-ttl <ms>] [--max-sessions <n>]` — a multi-directory, multi-session browser UI that streams turns over SSE and remembers your project folders across restarts
- **Skills**: Drop a `SKILL.md` into `.sigpi/skills/` — the agent loads it automatically. Follows the [Agent Skills spec](https://agentskills.io/specification).
- **Logging**: `~/.sigpi/logs/agent.log` with daily rotation

---

## License

MIT. See [LICENSE](./LICENSE).

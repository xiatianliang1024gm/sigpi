# SigPi

SigPi is a readable, real-world TypeScript agent reference implementation inspired by Pi's design. It shows the complete chain of an agent — agent loop, function calling, and context management — written with minimal abstraction layers so you can read it line by line. It is built for developers with a coding foundation who want to understand how an agent is actually implemented, not for zero-setup beginners.

- agent loop
- function calling
- context management (summarization)

## Quick start

1. Install dependencies:

```bash
pnpm install
```

2. Initialize config:

```bash
pnpm dev init
```

Then edit `~/.sigpi/config.toml` with your real model endpoint, API key, and model name.

You can optionally add a project-local override at `.sigpi/config.toml`.

3. Run interactive chat:

```bash
pnpm dev chat
```

`chat` now creates and attaches a session automatically. If you only want a one-off prompt without saving a session, use `pnpm dev ask`.

To create and resume a persistent session:

```bash
pnpm dev session new --title "investigate parser bug"
pnpm dev chat --session <session-id>
```

You can also switch to another saved session from inside the REPL:

```text
/resume
```

Inside chat, use `/summary`, `/compact`, `/session`, `/history`, `/resume`, `/exit`.

4. Run a single question:

```bash
pnpm dev ask "What time is it in UTC?"
```

## Commands

- `pnpm dev init`
- `pnpm dev init --force`
- `pnpm dev config validate`
- `pnpm dev chat`
- `pnpm dev chat --new`
- `pnpm dev chat --session <id>`
- `pnpm dev ask "your prompt"`
- `pnpm dev ask --session <id> "your prompt"`
- `pnpm dev session new [--title "..."]`
- `pnpm dev session list`
- `pnpm dev session show <id>`
- `pnpm build`
- `pnpm test`

## Session behavior

- Sessions are stored globally under `~/.sigpi/projects/<project-key>/sessions/`
- Each project gets its own bucket under `~/.sigpi/projects/<project-key>/`, with `index.json` stored alongside the `sessions/` directory
- A session file stores both a recovery snapshot and the full turn history
- The snapshot contains the compressed summary and recent messages needed to continue work later
- `recentMessages` is not the full conversation history; it is only the recovery window
- Full conversation history is stored in `turns[]` and surfaced by `/history` in chat or `pnpm dev session show <id>` for JSON/debug output
- `chat --session <id>` and `ask --session <id>` continue using the saved context
- `pnpm dev chat` creates a new session automatically unless you pass `--session <id>`
- `pnpm dev chat --new` is an explicit alias for starting a fresh session-backed chat
- Starting `chat` prunes session files that never recorded any turns, so abandoned empty sessions do not accumulate
- Inside the chat REPL, use `/summary`, `/compact`, `/session`, `/history`, `/resume`, `/exit`
- `/resume` opens the session selector and switches the current REPL to the selected saved session
- If a process stops mid-turn, the next resume marks that turn as interrupted and restores only the last completed turn
- Sessions are scoped to the current working directory
- Project-local `.sigpi/` holds config and skills files; session storage lives under the global project bucket

## Logging

- Default log base path: `~/.sigpi/logs/agent.log`
- Log files roll daily as `agent.YYYY-MM-DD.log` to keep single files manageable
- Set `[logging].level = "debug"` for more detailed runtime logs
- Set `[logging].to_console = true` to mirror structured logs to stdout/stderr
- Each runtime gets a `runId` and each turn gets a `turnId` in structured logs
- Failure categories are logged as `model_request_failed`, `tool_execution_failed`, `skill_action_failed`, `session_restore_warning`, and `context_summarization_failed`
- Logs include elapsed time, request sizes, tool counts, summarization/trim counts, and failure details for diagnosis

## Cross-platform shell behavior

- Unix-like systems default to `zsh`
- Windows defaults to `powershell.exe`, but Git Bash / MSYS / Cygwin sessions are detected as `bash`
- Override the shell with `[shell].kind = "zsh" | "bash" | "sh" | "pwsh" | "powershell" | "cmd"`
- Override the executable path with `[shell].path = "..." `; if the path ends in `bash(.exe)`, `zsh(.exe)`, `sh(.exe)`, `pwsh(.exe)`, `powershell(.exe)`, or `cmd(.exe)`, the shell kind is inferred automatically
- Set `[tools.bash].mode = "read_only" | "workspace_write" | "full_access"` to control the shared tool safety mode
- The default `workspace_write` mode allows normal edits inside the workspace but blocks obvious dangerous commands and recognizable out-of-workspace writes
- `read_only` also disables built-in file mutation tools and mutating skill actions
- This is a guardrail against accidental damage, not OS-level isolation for untrusted shell commands or skill scripts
- The system prompt tells the agent which platform and shell it should target when using `bash`

## Configuration

- Global config path: `~/.sigpi/config.toml`
- Project override path: `.sigpi/config.toml`
- Session storage root: `~/.sigpi/projects`
- Environment variables still override file-based config when present
- Model selection priority is: `MODEL_ID`, the last model selected with `/model`, then the file fallback `[model] default = "name"`
- The legacy `[model] active = "name"` key is still accepted as a fallback alias, but new configs should use `default`
- Model settings live under `[models.<name>]`: `base_url`, `api_key`, `name`
- `[models.<name>]` also supports `api_format`, `timeout_ms`, `max_retries`, and `retry_base_delay_ms`
- `api_format` defaults to `chat_completions`; set it to `responses` for OpenAI Responses API-compatible providers
- In interactive chat, `/model` lists and opens a selector for available models; `/model <name>` switches directly for the current process
- Model requests default to `timeout_ms = 60000` and `max_retries = 2`
- Agent tuning lives under `[agent]`
- Logging settings live under `[logging]`
- Session storage settings live under `[storage]`
- Shell settings live under `[shell]`
- Tool safety policy currently lives under the `[tools.bash]` section

## Built-in tools

- `read`
- `grep`
- `glob`
- `edit`
- `write`
- `bash`
- `update_plan`

## Skills

sigpi loads skills as **instruction documents** that follow the [Agent Skills specification](https://agentskills.io/specification). A skill is a directory containing a `SKILL.md` file; the agent reads it and follows the instructions, running any referenced scripts itself via the `bash` tool. There is no separate skill-execution engine.

### Discovery

Skills are discovered (first match wins; later duplicates are skipped with a warning) from:

- project `.sigpi/skills/` — searched upward from the working directory to the filesystem root
- project `.agents/skills/` — same upward walk (sigpi's own `.sigpi` namespace takes precedence over `.agents`)
- global `~/.sigpi/skills/`
- global `~/.agents/skills/`

This means skills written for other harnesses (e.g. Claude Code / pi skills under `.agents/skills`) load automatically as long as their `SKILL.md` follows the spec.

### Skill format

```text
.sigpi/
  skills/
    <skill-name>/
      SKILL.md            # required: frontmatter + instruction body
      scripts/...         # optional, run by the agent via bash
      references/...      # optional, read by the agent on demand
      assets/...          # optional templates / resources
```

`SKILL.md` frontmatter (YAML):

```md
---
name: example-skill
description: What the skill does and when to use it.
license: MIT
compatibility: Requires git and node.
metadata:
  author: example-org
  version: "1.0"
allowed-tools: Bash(git:*) Read
---

# Example skill

Instructions the agent follows. Reference scripts with relative paths,
e.g. run `scripts/setup.mjs` and read `references/guide.md`.
```

- `name` (required) must match the directory name and be 1-64 lowercase
  letters/digits/hyphens, with no leading/trailing/double hyphens.
- `description` (required) should say what the skill does and when to use it.
- `license`, `compatibility`, `metadata`, and `allowed-tools` are optional and
  parsed but advisory. Unknown fields are ignored (lenient).
- The Markdown body after the frontmatter is the instruction text.
- `scripts/`, `references/`, and `assets/` are loaded on demand by the agent
  (progressive disclosure) — the harness does not pre-load them.

### Using a skill

- The system prompt lists every loaded skill as `name: description (skills dir: <path>)`. When a task matches, the agent reads the `SKILL.md` with the `read` tool and follows it.
- The user can also load a skill into the conversation directly:

  ```
  /skill example-skill        # injects the skill's name, directory, and instructions
  /skill                      # lists loaded skills
  ```

### Behavior

- Skill scanning happens automatically at startup; invalid skills are skipped with warnings rather than failing startup.
- The agent runs skill scripts through the `bash` tool, so the workspace sandbox (`read_only` / `workspace_write` / `full_access`) governs what they can do.

## Search tool notes

`grep` wraps `ripgrep` so the agent can search inside workspace text files much more efficiently than reading entire files or using generic shell commands.

- `output=lines` returns matching lines with line numbers
- `output=files` returns only file paths that contain a match
- `query` is always required
- supports `glob`, case sensitivity, max results, and context lines
- ignores `.git`, `node_modules`, and `dist` by default

## File navigation notes

- `glob` is the fast path for filename/path searches and filtering candidate files with a glob like `src/**/*.ts`
- `read` reads targeted line ranges or character offsets when the agent only needs local context; by default it returns up to 2,000 lines or 50KB before continuation
- `read` returns explicit continuation metadata when truncated; use that metadata instead of guessing the next offset or line range
- `write` handles full-file writes in a cross-platform way
- `edit` applies one or more exact replacement blocks to a single file without JSON-escaping each search/replace pair
- `edit` also applies standard unified diffs with `git apply --check` validation first
- `update_plan` tracks concise multi-step task progress inside a turn
- patch blocks should use the marker lines `--- old`, `--- new`, and `--- end`
- for `edit`, prefer small unique old blocks copied from the current file; after a failed patch, reread the affected lines and retry with a narrower block

## Development notes

- TUI implementation guidance: `src/tui/README.md`
- block shape:

```text
--- old
<exact existing text>
--- new
<replacement text>
--- end
```

## Shell tool notes

`bash` runs a command in the agent's shell (`zsh -lc` on macOS/Linux by default, `powershell` on Windows).

- The working directory carries across commands in a session, like a terminal; `cd` changes it and it resets to the project directory if a command leaves the project tree
- Output is capped by default (`[tools.bash].max_output_length`, 30000 chars); when exceeded the full output is written to a session file and the tool returns the path plus a preview
- It has a default timeout of 120 seconds (`[tools.bash].default_timeout_ms`), capped at 600 seconds (`[tools.bash].max_timeout_ms`)
- It returns `stdout`, `stderr`, `exitCode`, `signal`, `ok`, `cwd`, and `cwdReset`
- It returns `timedOut`, `stdoutTruncated`, and `stderrTruncated` flags
- In `read_only` mode it blocks write and environment-modifying commands before execution
- In `workspace_write` mode it blocks obvious dangerous commands and recognizable writes outside the current workspace
- Complex shell syntax and skill action subprocesses are not strongly contained; use `full_access` only as an explicit escape hatch
- Pass `run_in_background: true` to run a command detached; the tool returns a task id and a log path immediately and the turn continues. List tasks with the `/tasks` chat command and stop one with `/tasks stop <task-id>`; read the log file to follow progress.
- It is best suited for read-only inspection commands unless you explicitly want the agent to change local state

## Release Checks

- Run `pnpm check`
- Run `pnpm test:provider`
- Run `pnpm test:cli`
- Run `pnpm pack:smoke`
- Only commits that pass the full chain above should be used for beta package publishing

## License

MIT. See [LICENSE](./LICENSE).

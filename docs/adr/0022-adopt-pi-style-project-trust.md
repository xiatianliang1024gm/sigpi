# 0022 — Adopt Pi-style project trust (replace in-process tool/permission restrictions)

SigPi previously restricted tool execution with two built-in mechanisms —
`[tools.bash].mode` (read_only / workspace_write / full_access) and
`[tools].allowedRoots` (ADR 0016) — plus a skill-root read-only write guard
(ADR 0017). We are removing all three and adopting Pi's permission philosophy
instead: SigPi runs with the permissions of the account that starts it and
treats the local environment as a single trust boundary; isolation is the
operating system's / container's job, not SigPi's. The one built-in "permission"
concept that remains is **project trust** — a per-directory decision that gates
whether SigPi *loads project-local resources* (skills and the project
`.sigpi/config.toml` override) before working in a directory. It mirrors
Pi's project trust: it guards resource *loading*, not what tools the model may
call once running. See ADR 0023 for why the skill-root write guard was also
removed (it was bypassable without a sandbox and gave false safety).

## Status

accepted

## Considered Options

- **Keep the built-in sandbox/limiters (status quo).** Rejected: the bash
  write-target heuristic (`extractWriteTargets`) and the write-tool guard only
  catch direct paths; `npx`, subshells, `curl | sh`, and any indirection bypass
  them, so they create a false sense of safety while diverging from Pi's
  explicit "no partial in-process sandbox" stance.
- **Remove all restrictions with no replacement (grill Q1 option B).** Rejected:
  this deletes the only backstop and does not adopt Pi's *conscious, recorded*
  trust model — Pi still prompts before loading project resources.
- **Extension-based permission gate only (Pi's `permission-gate.ts` pattern).**
  Considered but out of scope: an optional, user-installed interceptor is a
  reasonable future addition, but it is not a substitute for the loading gate
  this ADR introduces, and it does not address untrusted project resources.

## Consequences

- **Default `defaultProjectTrust = "ask"`** (new global config field in
  `~/.sigpi/config.toml`, value set `ask | always | never`). In the interactive
  REPL (UI present) SigPi prompts; in headless one-shot mode it behaves like Pi's
  non-interactive path — an `ask`/`never` decision *ignores* project resources and
  falls back to global config + global skills. `--approve` / `--no-approve` (alias
  `-a` / `-na`) override per run.
- **Behavior change for headless runs:** a `sigpi "prompt"` inside a repo with
  project skills/config now silently skips them unless trust is `"always"` or
  `--approve` is passed; a stderr warning notes the skip.
- **Trust is per-directory and all-or-nothing per project:** the presence of
  `.sigpi/skills`, `.agents/skills` (walked up from cwd), or `.sigpi/config.toml`
  triggers the decision; a bare `.sigpi/` directory does not. A trusted project
  loads both its skills and its config override together.
- **`AGENTS.md` / `CONTEXT.md` / `CLAUDE.md` load regardless of trust** (context
  text, matching Pi), and **global skill roots** (`~/.sigpi/skills`,
  `~/.agents/skills`) are never gated (user-installed, trusted by definition).
- **Persistence:** decisions stored in `~/.sigpi/trust.json` keyed by canonical
  absolute dir → `always` | `never`; lookup walks cwd → filesystem root and the
  closest saved decision wins (trusting/declining a parent applies to subdirs
  unless a closer decision exists).
- **Security boundary is now explicitly the OS/container**, not SigPi. Running
  in untrusted or unattended contexts requires an external sandbox.
- **ADR 0017 (load-implies-trust) is refined:** skills still auto-load and are
  trusted with no separate gate, but only within a trusted project. Its
  compensating skill-root write guard is removed (see ADR 0023).
- **Future loadable resources** (e.g. extensions, prompts, themes) should be
  added to the gated resource set when introduced, keeping parity with Pi.

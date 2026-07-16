# 0016 — Configurable trusted roots replace the hard workspace-write block

- **Status**: Accepted
- **Date**: 2026-07-13
- **Commit**: `—`

## Update — removed by ADR 0022 (2026-07-16)

The `allowedRoots` read/write allow-list and the *trusted roots* concept were
**removed** by ADR 0022, which replaces SigPi's built-in tool-execution
restrictions with Pi-style project trust. The workspace-write containment this ADR
introduced is gone; isolation is now the operating system's / container's job, not
SigPi's. This ADR's Status stays Accepted as a historical record; the mechanism it
describes no longer ships.

## Context and Problem

SigPi's tool-safety model blocks writes outside the working directory through two independent gates:

- `write` / `edit` tools call `resolveWritableWorkspacePath` → `resolveWorkspacePath`, which throws `"Path must stay within the working directory."` whenever a path escapes `cwd` and is not under an allowed root (`src/tools/path-utils.ts:15-23`, `src/tools/sandbox-policy.ts:40-51`).
- `bash` calls `evaluateCommandPolicy`, which rejects any write target outside the workspace in `workspace_write` mode (`src/tools/sandbox-policy.ts:78-84`).

A read-only trusted-roots mechanism already exists (`allowedReadRoots`, built in `buildTrustedReadRoots` and consumed by `read`/`glob`/`grep` via `ToolExecutionContext.allowedReadRoots` — `src/tools/path-utils.ts:48-72`, `src/types.ts:116`, `src/agent/runner.ts:627`). It is seeded at runtime with the bash-output/background-log directory and each loaded skill's directory (`src/runtime.ts:286-289`). **Writes never consult it.**

The pain: an agent that needs a scratch location (e.g. `/tmp`) is hard-denied and must spend a turn finding somewhere else to write. The only escape today is switching the whole session to `full_access`, which drops the sandbox entirely — a nuclear option for a benign need.

Industry comparison (from a `/grilling` research pass; Pi's own source is not public, so "Pi" here means SigPi, the readable reference implementation inspired by it):

- **Claude Code**: soft boundary — read tools pass by default; write/bash prompt per-call with memorable allow-rules. No hard `/tmp` ban.
- **Codex CLI**: hard sandbox by default, but exposes **configurable writable roots** as a precise escape hatch rather than "all or nothing".
- **SigPi (current)**: hard block with only `full_access` as the escape — sits between the two schools and inherits the worst of both (hard denial + no fine-grained relief).

The decision: keep the hard boundary, but add a fine-grained escape hatch aligned with Codex's writable-roots idea, and unify it with the existing read-roots mechanism.

## Considered Options

1. **Configurable trusted roots, unified for read and write, defaulted via `init` (adopted)** — add `[tools] allowed_roots` to config; `init` emits it pre-seeded with the OS temp dir; reads and writes both consult it. Minimal, matches the existing `allowedReadRoots` mental model, and the escape is precise rather than all-or-nothing.
2. **Permission prompt + memorable allow-rules (Claude Code style)** — intercept the denial and ask "allow writing to /tmp? (remember)". Closer to the word "interaction", but adds friction every first time and requires a new rule-persistence subsystem. Rejected: the pain is a one-time config cost, not per-call friction, so prompting overshoots.
3. **Hard-code a `/tmp` allow-constant (like the existing `/dev/null` whitelist)** — minimal, but not configurable, doesn't generalize to other locations the user might want, and bakes an OS-specific path into source. Rejected as too narrow and too rigid.
4. **Drop the workspace-write restriction entirely (default allow outside)** — rejected: both Claude Code and Codex retain a boundary; removing it would weaken the safety model SigPi documents and demonstrates.

## Decision

- Add a single config field `[tools] allowed_roots` (camelCase `tools.allowedRoots`), defaulting to `[]` in the schema. It is a list of absolute paths that are trusted for **both reading and writing**, in addition to the working directory.
- `init` (`initializeUserConfig` / `renderDefaultConfigToml`, `src/config.ts:427-514`) emits `allowed_roots` pre-seeded with the OS temp directory, using `os.tmpdir()` rather than a literal `/tmp`, so the default is correct on Windows (`%TEMP%`) as well as Linux/macOS. The literal `/tmp` is **not** hard-coded in source.
- Runtime merges config `allowed_roots` with the existing dynamic roots (bash-output dir + loaded-skill dirs) into `ToolExecutionContext.allowedReadRoots` — **read paths need no behavioral change** (`src/runtime.ts:286-289`).
- Write paths consult the roots: `resolveWritableWorkspacePath(cwd, relativePath, mode, toolName, allowedRoots)` gains an `allowedRoots` parameter and forwards it to `resolveWorkspacePath` (which already accepts `allowedRoots` at `src/tools/path-utils.ts:7` but is currently called without it). `write.ts:56` and `edit.ts` pass `config.tools.allowedRoots`.
- Bash path consults the roots: `evaluateCommandPolicy(command, cwd, mode, allowedRoots)` gains an `allowedRoots` parameter; in `workspace_write` mode, a write target under an allowed root is permitted instead of denied (`src/tools/sandbox-policy.ts:78-84`). `bash.ts:153` passes the roots.
- **Mode invariant (preserved, not new code)**: `read_only` write gates (`evaluateMutatingToolPolicy`, `src/tools/sandbox-policy.ts:32-36`; `readOnlyWritePattern`, `:68-72`) run *before* any roots check. Therefore `allowed_roots` relieves reads in `read_only` but never opens writes there. `full_access` ignores roots entirely (unchanged).

## Consequences

- **Pain resolved**: an agent with the default `init` config can read and write the OS temp dir without a wasted turn and without dropping to `full_access`.
- **Unified mental model**: one `allowed_roots` list serves read and write; the existing dynamic roots (bash output, skill dirs) remain merged at runtime. No second context field is introduced.
- **Cross-platform default**: `os.tmpdir()` means Windows users get a valid temp root instead of a dead `/tmp` literal.
- **Opt-in by config, not by code**: the schema default is `[]`; the `/tmp` relief is an *artifact of running `init`*, not an out-of-the-box code behavior. Users who never run `init` (or who delete the line) get the original hard block. This is recorded deliberately: model config already requires `init`, so the practical impact is nil, but the safety default of the code itself stays strict.
- **No weakening of `read_only`**: the mode invariant above holds by construction; roots cannot be used to write under `read_only`.
- **Tests to add**:
  - `resolveWorkspacePath` / `resolveWritableWorkspacePath` permit a path under an allowed root and still reject paths outside both cwd and roots.
  - `evaluateCommandPolicy` permits a redirect/write target under an allowed root in `workspace_write`, and still denies it in `read_only` even when the root is listed.
  - `renderDefaultConfigToml` emits `allowed_roots` containing `os.tmpdir()` (platform-dependent assertion).
  - config round-trip: `allowed_roots` survives TOML parse/serialize via the alias table (`src/config.ts:113-120`).

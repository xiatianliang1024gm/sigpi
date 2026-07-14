# 0017 — Skill trust: load implies trust; skill roots are read-only

- **Status**: Accepted
- **Date**: 2026-07-13
- **Commit**: `—`

## Context and Problem

A design pass (`tmp/skill-trust.md`) proposed splitting skill handling into four
stages — Discovery → Trust → Prompt Loading → Runtime Read Capability — and argued
that "discovery is not trust" and that a skill should only be loaded into the
system prompt after an explicit trust decision (allowlist / first-use approval /
signature verification).

Hands-on research against real implementations overturned that premise:

- **Claude Code** loads every skill under `~/.claude/skills` directly — *load
  implies trust*, no per-skill opt-in.
- **Codex** exposes a `/skill` enable/disable toggle, but skills default to
  enabled; the toggle reads as a *visibility* control, not a security boundary.
- **Pi agent** — load implies trust.

So the industry baseline is "discovery ⇒ load ⇒ trust," not "discovery ⇒
trust-gate ⇒ load." An explicit user-approval / allowlist gate is heavier than
the problem warrants and diverges from how users already expect skills to behave.

This ADR records the decision to follow the baseline: **a discovered skill is
trusted the moment it is loaded into the system prompt.** There is no separate
trust gate. The only remaining security control is keeping skill roots
**read-only**, which becomes a hard invariant once the trust gate is removed.

### Facts established during the review (verified against source)

- `loadSkillCatalog` (`src/skills/catalog.ts`) loads **every** discovered skill
  unconditionally — there is no trust gate today. Read roots only gate the
  `read`/`glob`/`grep` tools.
- `allowedReadRoots` is a **runtime read-capability** mechanism, not a trust
  boundary. It is built in `buildTrustedReadRoots` (`src/tools/path-utils.ts:48`)
  and seeded at runtime with the bash-output dir, each loaded skill's `dir`, and
  `config.tools.allowedRoots` (`src/runtime.ts:290-294`). **Writes never consult
  it.** (See ADR 0016 for the read/write roots model.)
- Skill roots are **not** in any write-root list. Therefore `workspace_write`
  mode already blocks writes to them (a skill root is neither `cwd` nor an
  allowed root). The gap is `full_access`, which bypasses all write checks
  (`sandbox-policy.ts:60-62`; `src/config.ts:819`).
- The `tmp/skill-trust.md` "Runtime" recommendation (`allowedReadRoots =
  collectSkillRoots()`) is **rejected**: it would drop `bashOutputDir` and
  `config.tools.allowedRoots`, and broaden scope to whole discovery roots. It is
  also unnecessary — force-loading a skill is just the `read` tool reading a
  `SKILL.md` path, which already works because each skill `dir` is in
  `allowedReadRoots`.

## Considered Options

1. **Load implies trust; skill roots read-only (adopted)** — match Claude Code /
   Codex / Pi. No trust gate. Add a hard, mode-independent block on writes to any
   skill discovery root, including `full_access`. Lightest option; matches user
   expectations.
2. **Load implies trust + optional deny-list (Codex-style)** — default trust, but
   let the user disable individual skills. Recorded as a **future option**, not
   adopted now: the escape hatch looks redundant at this stage and adds config
   surface. Revisit if a concrete "I never want skill X in the prompt" need
   appears.
3. **Allowlist / first-use approval gate (rejected)** — the original
   `tmp/skill-trust.md` proposal. Heavier than the problem warrants, diverges
   from industry baseline, and (if interactive) conflicts with the session
   immutability / fingerprint-stability principles. Rejected after the research
   pass.

## Decision

- **Load implies trust.** A discovered skill is trusted when its `SKILL.md` is
  loaded into the system prompt. There is no separate trust gate, allowlist, or
  approval step.
- **Skill roots are read-only — a hard invariant, not a suggestion.** No tool or
  shell command may write into any skill discovery root (`.sigpi/skills` /
  `.agents/skills`, project or global). This block is **mode-independent**: it
  applies under `read_only`, `workspace_write`, **and `full_access`**. It is the
  compensating control for removing the trust gate — without it, an agent in
  `full_access` could write a new skill into a root, which would be auto-discovered
  and auto-loaded on the next startup, yielding persistent privilege escalation.
- **Force-loading an untrusted skill is just `read`.** If a user wants an
  arbitrary `SKILL.md` content in context, they point the `read` tool at its path;
  if the path is sandbox-readable, the content returns as a tool result. No
  special command, no catalog resolution by the LLM, no skill semantics attached.
  (Each skill `dir` is already in `allowedReadRoots`, so this works today.)
- **No change to `allowedReadRoots` construction.** Keep
  `src/runtime.ts:290-294` as-is (bash-output dir + per-skill `dir` +
  `config.tools.allowedRoots`). The `tmp/skill-trust.md` `collectSkillRoots()`
  swap is explicitly not adopted.
- **Session immutability preserved.** Skill discovery happens at startup; the
  loaded skill set (and thus the system prompt and `skillsFingerprint`) is fixed
  for the session. New skills on disk become active only in a new session. This
  is unchanged from current behavior and is unaffected by this ADR.

## Consequences

- **Vocabulary**: the terms "trusted skill" / "untrusted skill" / "force-load" from
  the earlier draft are **retired** — under load-implies-trust there is no
  untrusted-discovered skill. "Skill" keeps its existing CONTEXT.md meaning
  (instruction document discovered from skill roots and surfaced to the system
  prompt). "Trusted roots" remains ADR 0016's read/write allow-list — a distinct
  concept from skill trust.
- **Security model is simpler and honest**: the real boundary is "you cannot
  persist a new trusted skill" (root read-only), not "you must approve each
  skill." The `full_access` hard block closes the one path that would otherwise
  defeat this.
- **No config surface added.** No allowlist, no deny-list, no approval prompt.
- **Future option recorded**: a Codex-style deny-list (option 2) may be added
  later without reopening the trust-gate question; it would be a visibility
  control layered on top of load-implies-trust, not a security boundary.
- **Implementation to add**: a mode-independent write guard in the sandbox policy
  that rejects any write/edit/bash-write-target whose resolved path falls within a
  skill discovery root (computed via `collectSkillRoots`-style roots). It must run
  *before* the `full_access` early-return so it cannot be bypassed.
- **Tests to add**:
  - `write`/`edit` reject a path under a skill root in all three modes, including
    `full_access`.
  - `evaluateCommandPolicy` rejects a redirect/write target under a skill root in
    `full_access` (currently it returns `null` immediately — must be fixed).
  - `read`/`glob`/`grep` still succeed on skill-root files (read capability
    unchanged).

# 0023 — Remove the skill-root read-only write invariant

ADR 0017 introduced a mode-independent write guard (`assertNotSkillRoot`) that
blocked `write`/`edit` and bash write/redirect targets whose resolved path fell
inside any skill discovery root (`.sigpi/skills` / `.agents/skills`, project or
global), in every mode including `full_access`. It was the *compensating control*
for load-implies-trust: without it, an agent in `full_access` could persist a new
skill into a root, which would be auto-discovered and auto-loaded on the next
startup — persistent privilege escalation. **We are removing this guard entirely,
including for global roots.**

## Status

accepted

## Why remove it

- **It was bypassable without a sandbox.** The guard only intercepted the write
  tools directly and a hand-picked set of bash write commands via the
  `extractWriteTargets` regex (redirects plus `touch`/`mkdir`/`rm`/`rmdir`/`mv`/
  `cp`/`install`/`tee`). Any indirection escaped it: `npx <pkg>` whose internals
  write the file, a subshell, `curl | sh`, base64-decoded content, or a pre-built
  script dropped via `cp` from a temp path. So it stopped only the *honest* path.
- **False sense of safety.** A guard that is trivially bypassable is worse than
  none: it implies a boundary that does not hold, inviting users to run agents in
  contexts they would otherwise sandbox.
- **It contradicts Pi's stated philosophy.** Pi's `security.md` is explicit that a
  "partial in-process sandbox would be easy to misunderstand as a security boundary
  while still depending on the host shell, filesystem, package managers,
  credentials, and extension code." Real isolation is the OS's/container's job.
- **ADR 0022 replaces the rationale.** With project trust (ADR 0022) gating
  *loading* of project skill roots, the untrusted-project path is closed at load
  time — the only case the write guard uniquely covered was a *trusted* project's
  agent persisting a skill, which Pi accepts as inherent to trusting a project.

## Considered Options

- **Keep the guard on global roots only (grill Q2 option B).** Rejected: a trusted
  project's agent can already run with the user's full permissions, so a global-root
  write guard is the same partial sandbox Pi warns against; it adds complexity for a
  gap Pi tolerates by design. The user chose full removal (option A).
- **Keep the full invariant (grill Q2 option C).** Rejected: that would not actually
  "replace" the invariant with trust, and retains a bypassable, misleading control.

## Consequences

- `assertNotSkillRoot` and all call sites (write/edit path resolution, bash command
  policy) are deleted; the skill-root concept leaves `sandbox-policy.ts`.
- Loading of *project* skill roots is now gated by **Project trust** (ADR 0022);
  global skill roots remain user-installed and never gated.
- `load-implies-trust` (ADR 0017) is scoped to trusted projects (ADR 0022); the
  skill-root invariant is no longer its compensating control.
- Running agents in untrusted or unattended contexts requires an external sandbox;
  this is now an explicit, documented responsibility, not a SigPi invariant.

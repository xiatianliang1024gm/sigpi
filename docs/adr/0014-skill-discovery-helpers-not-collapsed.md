# 0014 — Skill-discovery helpers not collapsed (candidate 6, no change)

- **Status**: Accepted
- **Date**: 2026-07-13
- **Commit**: `—` (no code change)

## Context and Problem

The architecture-review deepening pass (candidate 6, rated **Speculative**) proposed collapsing `src/skills/catalog.ts`, `src/skills/manifest.ts`, and `src/skills/format.ts` into one skill module with a single `loadSkillCatalog` interface, on the grounds that "each is small; together they form a shallow cluster with no single name."

The three files are already a clean layered split, not duplicated logic:

- `catalog.ts` (227 lines) — orchestrator: root walking, dedup, fingerprint. Exports `loadSkillCatalog`, `buildSkillsFingerprint`.
- `manifest.ts` (79 lines) — pure helper: `parseSkillDocument` (SKILL.md frontmatter parse). Called only by `catalog.ts`.
- `format.ts` (22 lines) — pure helper: `buildSkillCatalogSummary` (system-prompt index string). Called by `defaults.ts`.

Consumers are few and already import the specific symbol they need (`runtime.ts` → `loadSkillCatalog`; `defaults.ts` → `buildSkillCatalogSummary`). There is no second implementation to eliminate and no drift risk — the files do not re-implement each other.

## Considered Options

1. **No code change; record as speculative / not worth it (adopted)** — the current split is already a good deep-module shape (orchestrator + two pure helpers). Merging would mainly combine three small files into one ~330-line file for no leverage or locality gain.
2. **Barrel `src/skills/index.ts` re-exporting the three symbols** — gives one import site (`runtime.ts`/`defaults.ts` import from `./skills`). Rejected: cosmetic only; the files stay separate and the import-site churn (including `test/skills.test.ts`) buys nothing material.
3. **Inline `manifest.ts` + `format.ts` into `catalog.ts`, delete the two files** — rejected: forces `test/skills.test.ts` to change its three direct imports, and removes the clean single-responsibility separation for no behavioral benefit.

## Decision

Candidate 6 is **skipped** as speculative. The skill-discovery helpers stay as three cohesive files under `src/skills/`. No code change.

## Consequences

- No behavioral or structural change.
- A future explorer reading the architecture-review HTML should not re-suggest merging the skill helpers — the split is intentional and already deep.

# 0008 — Open-source positioning: a readable reference implementation, not a minimal toy

- **Status**: Accepted
- **Date**: 2026-07-12
- **Commit**: pending implementation (decided in a grilling session, not yet landed in code/docs)

## Context and Problem

The author's original motivation was being unable to read Pi / Codex source: huge codebases,
deep abstraction layers, hard to debug/locate, many supported models. So they built a "readable
agent" and intended to open-source it with "teaching-grade" as the hook.

But three tensions must be resolved now, or README / docs / naming will contradict each other:

1. **Misrepresentation**: the README calls it "minimal / smallest practical", yet it is ~18k LOC
   across ~80 source files, with production-grade logic (turn-checkpoint compaction, tool dedup,
   verification reminder, interrupt escape, max-steps synthesis fallback). "tiny / minimal" misleads
   people expecting a 300-line toy.
2. **Audience mismatch**: the author explicitly does NOT target zero-code, pick-up-and-use users —
   that would require heavy newbie-guidance features, which is not the goal. The real target is
   developers with a coding foundation who want to understand how an agent is implemented.
3. **Mixed languages**: the root README is English, but source (e.g. `buildMaxStepsFallbackAnswer`'s
   fallback text, some comments) is Chinese — unsustainable long-term.

## Considered Options

1. **Keep "minimal toy" positioning + rename** (rejected): conflicts with the facts (18k LOC,
   production logic) and the audience does not want a toy; erodes trust via misrepresentation.
2. **Reposition as "a readable real-world agent reference implementation / learning sample" + rename
   + language layering** (adopted): precisely hits the same people who "couldn't read Pi/Codex so
   built their own", and is honest.
3. **Pure-Chinese project** (rejected): sacrifices the international entry; but the author only wanted
   to write a Chinese explanation, so we compromised to "root README English + docs/ Chinese
   explanation + code/comments/UX English".
4. **Keep `TinyPi`** (rejected): `Tiny` now conflicts with the "readable real implementation"
   positioning, and the "...Agent" suffix is severely inflated/cliché in 2024–2026 dev tooling.
   `SigPi` (Σπ, summation/assembly metaphor) fits better and is distinctive.

## Decision

- **Positioning**: SigPi is a **readable real-world agent reference implementation** that writes the
  full chain of "agent loop + function calling + context management" with minimal abstraction layers
  and line-by-line traceability. It does not teach zero-base onboarding; it gives developers with a
  coding foundation who want to understand how agents are implemented a sample they can read against
  the Pi / Codex behemoths.
- **Audience**: developers with a coding foundation who want to understand agent internals (how it
  interacts with the LLM, how it calls tools, how the loop runs).
- **Name**: `SigPi` (Σπ = summation, metaphor for "assembling readable parts into a complete agent");
  package/bin use ASCII `sigpi`; π is used only for logo / docs branding.
- **Language**: root `README.md` in English (international entry); `docs/` ships BOTH English (source)
  + Chinese (translation) — English written first to lock content/structure, Chinese for
  Chinese-background readers; code, comments, and UX strings in English. Hardcoded Chinese fallback
  strings become language-neutral / follow the conversation language.
- **ADRs**: English-only (developer-facing, consistent with code and comments).

## Consequences

- **Honest**: no more "minimal/tiny" mislabel; positioning matches the audience.
- **Precise**: directly serves readers who want to understand agent implementation;it mirrors the
  author's own pain.
- **Cleanup required** (handled in another branch):
  - Remove the internal npm registry configuration and the scoped package prefix from `package.json`;
    change `name`/`bin` to `sigpi`.
  - Rewrite the README's positioning first sentence; add the Chinese teaching explanation under `docs/`.
  - Make hardcoded Chinese UX strings language-neutral.
- **Deliberate trade-off**: not zero-base-friendly, so no heavy newbie-guidance UI; teaching value
  concentrates on "readable code + explanation".
- **Docs authoring workflow (bilingual)**: `docs/` ships both English and Chinese; English is drafted
  first to lock content/structure as the source doc, then translated to Chinese for Chinese-background
  readers; code/comments/UX stay English.

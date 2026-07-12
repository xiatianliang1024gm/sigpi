# 0002 — Unify TOML and runtime config field names with a single alias table

- **Status**: Accepted
- **Date**: 2026-07-12
- **Commit**: `5d5a808`

## Context and Problem

When `src/config.ts` parses TOML config, it maps `snake_case` TOML keys to runtime `camelCase` field names, and serializes the runtime schema back into a `snake_case` example TOML. Originally this two-way mapping was **hand-written** and **separated** from the runtime schema's field names in two places:

- the runtime schema (sub-schemas of `appConfigSchema`) defines fields;
- TOML parse/serialize then wrote a second camel↔snake mapping table.

Each side is maintained independently; when a field is renamed, the mapping table does not fail to compile, it only silently misaligns at runtime — a classic missing "single source of truth".

## Considered Options

1. **A single alias table drives the two-way mapping** (adopted). `appConfigSchema`'s sub-schemas stay authoritative (the only source of field types and runtime shape); add `MODEL_ALIASES` / `AGENT_ALIASES` / `LOGGING_ALIASES` / `STORAGE_ALIASES` / `SHELL_ALIASES` / `BASH_ALIASES` (camel↔snake, single source).
   - `snakeFields(subSchema, aliases, strict=false)`: takes the **type** from the sub-schema's `.shape`, the **key name** from the alias table, and derives the TOML-side schema.
   - `mapSection(raw, aliases)`: inverts the alias table to map `snake_case` raw sections back to runtime fields.
   - `tomlRootSchema` is composed from each sub-schema's `snakeFields`.
   - Reverse guard: if a sub-schema field has no matching entry in the alias table, `strict` mode throws at load time (prevents the "schema has a field but the alias table missed it" drift).
   - Export `CONFIG_ALIASES` so callers (e.g. default-config rendering) reuse the same source.
2. Make the TOML schema itself authoritative and map back at runtime.
   - Rejected: would **duplicate** the config structure (one for runtime, one for TOML), contradicting the "sub-schema is authoritative" goal and increasing the drift surface.

## Decision

- The runtime `appConfigSchema` and its sub-schemas remain the **sole authority** for types and fields.
- A single `CONFIG_ALIASES` drives both "TOML→runtime" and "runtime→example TOML" directions, eliminating the second hand-written mapping.
- `parseTomlConfig` was rewritten into a unified path based on `mapSection`.
- The `agent` / `model` / `models` sections stay `.strict()` (unknown keys error); `logging` / `storage` / `shell` / `tools.bash` are not strict (allow provider-specific keys to pass through).

## Consequences

- **Single source of truth**: renaming a field changes one place (sub-schema + alias table) and both mappings stay consistent automatically.
- Added guard tests for "alias table has it / schema doesn't" and vice versa, preventing drift.
- Runtime behavior fully unchanged; +205 / −107 lines, mostly from deleting the duplicate mapping and adding tests.
- biome + tsc clean; 390/390 (at the time) tests passed.

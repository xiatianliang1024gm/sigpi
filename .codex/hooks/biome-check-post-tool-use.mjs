#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync as pathExists } from "node:fs";

if (!pathExists("biome.json") && !pathExists("biome.jsonc")) process.exit(0);

for await (const _chunk of process.stdin) {
  // Drain hook event stdin so the parent process can close cleanly.
}

const changedFiles = new Set([
  ...gitLines(["diff", "--name-only", "--diff-filter=ACMR", "--", "."]),
  ...gitLines(["ls-files", "--others", "--exclude-standard", "--", "."]),
]);
const files = [...changedFiles].filter((file) =>
  /^(src|test)\/.*\.tsx?$/.test(file),
);

if (files.length === 0) process.exit(0);

const result = spawnSync("pnpm", [
  "exec",
  "biome",
  "check",
  "--write",
  ...files,
], {
  encoding: "utf8",
});

if (result.status !== 0) {
  process.stderr.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  process.exit(2);
}

function gitLines(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

#!/usr/bin/env node
// Copies non-TS assets from src/ into dist/src/ so they ship alongside the
// compiled JS. TypeScript only emits .ts/.tsx files, so anything we want to
// load at runtime via `import.meta.url` (e.g. default-config.toml) must be
// staged here.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const assets = ["src/default-config.toml"];

for (const relPath of assets) {
	const src = join(root, relPath);
	const dest = join(root, "dist", relPath);
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(src, dest);
	console.log(`copied ${relPath} -> dist/${relPath}`);
}

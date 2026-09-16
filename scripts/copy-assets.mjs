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

const assets = [
	"src/default-config.toml",
	"src/server/web/index.html",
	"src/server/web/app.js",
	"src/server/web/dom.js",
	"src/server/web/state.js",
	"src/server/web/format.js",
	"src/server/web/api.js",
	"src/server/web/sidebar.js",
	"src/server/web/transcript.js",
	"src/server/web/events.js",
	"src/server/web/tree.js",
	"src/server/web/menus.js",
	"src/server/web/projects.js",
	"src/server/web/sessions.js",
	"src/server/web/composer.js",
	"src/server/web/reducer.js",
	"src/server/web/markdown.js",
	"src/server/web/styles.css",
];

for (const relPath of assets) {
	const src = join(root, relPath);
	const dest = join(root, "dist", relPath);
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(src, dest);
	console.log(`copied ${relPath} -> dist/${relPath}`);
}

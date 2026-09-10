import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";

/**
 * Serves the bundled browser client for the multi-session web frontend. The
 * assets live next to this module (`src/server/web/`) and are copied into
 * `dist/` by `scripts/copy-assets.mjs`, so `import.meta.url` resolves them in
 * both the compiled build and the test harness.
 *
 * Only a fixed allow-list of paths is served — there is no directory traversal
 * surface, and every request is same-origin with the API it drives (no CORS).
 */
const ASSETS: Record<string, { file: string; contentType: string }> = {
	"/": { file: "index.html", contentType: "text/html; charset=utf-8" },
	"/index.html": {
		file: "index.html",
		contentType: "text/html; charset=utf-8",
	},
	"/app.js": {
		file: "app.js",
		contentType: "text/javascript; charset=utf-8",
	},
	"/reducer.js": {
		file: "reducer.js",
		contentType: "text/javascript; charset=utf-8",
	},
	"/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
};

/** True when `pathname` names a bundled client asset. */
export function isStaticAssetPath(pathname: string): boolean {
	return Object.hasOwn(ASSETS, pathname);
}

/**
 * Write a bundled client asset to `res`. Returns `true` when the path was
 * handled (including a missing-on-disk 404), `false` when it is not an asset
 * path so the caller can continue routing.
 */
export async function serveStaticAsset(
	pathname: string,
	res: ServerResponse,
): Promise<boolean> {
	const asset = ASSETS[pathname];
	if (!asset) {
		return false;
	}

	let body: Buffer;
	try {
		body = await readFile(new URL(`./web/${asset.file}`, import.meta.url));
	} catch {
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "not_found" }));
		return true;
	}

	res.writeHead(200, {
		"content-type": asset.contentType,
		"cache-control": "no-cache",
	});
	res.end(body);
	return true;
}

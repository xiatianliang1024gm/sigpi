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
 * The client is split into small ES modules (`app.js` imports the rest), so the
 * allow-list names each file rather than listing URL records by hand.
 */
const JS = "text/javascript; charset=utf-8";

const ASSET_CONTENT_TYPES: Record<string, string> = {
	"index.html": "text/html; charset=utf-8",
	"styles.css": "text/css; charset=utf-8",
	"app.js": JS,
	"dom.js": JS,
	"state.js": JS,
	"format.js": JS,
	"api.js": JS,
	"sidebar.js": JS,
	"transcript.js": JS,
	"events.js": JS,
	"tree.js": JS,
	"menus.js": JS,
	"projects.js": JS,
	"sessions.js": JS,
	"composer.js": JS,
	"reducer.js": JS,
	"markdown.js": JS,
};

/** Resolve a request path to an allow-listed asset, or `undefined`. */
function assetFor(
	pathname: string,
): { file: string; contentType: string } | undefined {
	const file =
		pathname === "/" || pathname === "/index.html"
			? "index.html"
			: pathname.replace(/^\//, "");
	const contentType = ASSET_CONTENT_TYPES[file];
	return contentType ? { file, contentType } : undefined;
}

/** True when `pathname` names a bundled client asset. */
export function isStaticAssetPath(pathname: string): boolean {
	return assetFor(pathname) !== undefined;
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
	const asset = assetFor(pathname);
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

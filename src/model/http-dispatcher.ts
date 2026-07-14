import { EventEmitter } from "node:events";
import * as undici from "undici";

/**
 * HTTP dispatcher setup for model requests, mirroring how the pi agent makes
 * its own `fetch` proxy-aware.
 *
 * Node's `fetch` (and undici's) does not consult `HTTP_PROXY` / `HTTPS_PROXY`
 * by default, so a machine that can only reach the internet through a proxy
 * (common behind corporate / mitmproxy setups) times out with `fetch failed`
 * / `ETIMEDOUT`. We fix that the same way pi does:
 *
 *   1. `applyHttpProxySettings` seeds the proxy env vars from config (only when
 *      they are not already set by the environment).
 *   2. `configureHttpDispatcher` installs an `undici.EnvHttpProxyAgent` as the
 *      global dispatcher. `EnvHttpProxyAgent` reads `HTTP_PROXY` /
 *      `HTTPS_PROXY` / `NO_PROXY` and routes each origin through the proxy,
 *      honouring the `NO_PROXY` allowlist for internal hosts.
 *   3. `undici.install()` swaps `globalThis.fetch` for undici's own fetch so it
 *      uses that same dispatcher. This keeps fetch and the dispatcher on one
 *      undici implementation (avoiding a decompression bug when Node's bundled
 *      fetch is driven by a separate undici dispatcher) and means
 *      `ModelTransport`, whose default `fetchImpl` is `globalThis.fetch`, picks
 *      up the proxy-aware fetch with no changes to its call sites.
 */

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

export interface HttpProxyStatus {
	/** Whether a proxy is in effect (from config or environment). */
	configured: boolean;
	/** Where the proxy URL came from. */
	source: "config" | "env" | "none";
	/** The proxy URL actually used, if any. */
	proxyUrl?: string;
	/** Whether the proxy-aware global dispatcher was installed. */
	dispatcherInstalled: boolean;
	/** Idle/stall timeout applied to the dispatcher (ms). */
	idleTimeoutMs: number;
	/** Name of the `fetch` implementation now in use. */
	fetchImpl: string;
}

let currentProxyStatus: HttpProxyStatus = {
	configured: false,
	source: "none",
	dispatcherInstalled: false,
	idleTimeoutMs: DEFAULT_HTTP_IDLE_TIMEOUT_MS,
	fetchImpl:
		typeof globalThis.fetch === "function"
			? globalThis.fetch.name || "fetch"
			: "unknown",
};

/** Snapshot of the current proxy configuration, for diagnostics/logging. */
export function getProxyStatus(): HttpProxyStatus {
	return { ...currentProxyStatus };
}

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this
// listener only prevents EventEmitter's unhandled "error" special case from
// crashing the process.
function withUndiciErrorListener<T extends EventEmitter>(dispatcher: T): T {
	EventEmitter.prototype.on.call(
		dispatcher,
		"error",
		ignoreUndiciDispatcherError,
	);
	return dispatcher;
}

let installedGlobalFetch: typeof fetch | undefined;

/**
 * Install a proxy-aware global HTTP dispatcher for `fetch`. Idempotent: the
 * global fetch swap happens at most once.
 */
export function configureHttpDispatcher(
	idleTimeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS,
): void {
	if (installedGlobalFetch !== undefined) {
		return;
	}

	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(idleTimeoutMs);
	const timeout =
		normalizedTimeoutMs === undefined
			? DEFAULT_HTTP_IDLE_TIMEOUT_MS
			: normalizedTimeoutMs;

	const dispatcher = withUndiciErrorListener(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			bodyTimeout: timeout,
			headersTimeout: timeout,
		}),
	);
	undici.setGlobalDispatcher(dispatcher);
	undici.install?.();
	installedGlobalFetch = globalThis.fetch;
	currentProxyStatus = {
		...currentProxyStatus,
		dispatcherInstalled: true,
		idleTimeoutMs: timeout,
		fetchImpl: installedGlobalFetch?.name || "fetch",
	};
}

/**
 * Convenience entry used at startup: seed proxy env from config (if any) and
 * install the proxy-aware dispatcher. `idleTimeoutMs` governs undici's
 * idle/stall timeout between received bytes.
 */
/**
 * Convenience entry used at startup: seed proxy env from config (if any) and
 * install the proxy-aware dispatcher. `idleTimeoutMs` governs undici's
 * idle/stall timeout between received bytes.
 *
 * Returns a status snapshot and prints a one-line notice to stderr so the
 * proxy decision is always visible, even before logging is configured.
 */
export function configureHttpProxy(
	proxyFromConfig?: string,
	idleTimeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS,
): HttpProxyStatus {
	const proxy = proxyFromConfig?.trim();
	const fromEnv =
		process.env.HTTPS_PROXY?.trim() || process.env.HTTP_PROXY?.trim();
	const effectiveProxy = proxy ?? fromEnv;
	const source: HttpProxyStatus["source"] = proxy
		? "config"
		: fromEnv
			? "env"
			: "none";

	if (proxy) {
		// `??=` so an existing environment setting always wins.
		process.env.HTTP_PROXY ??= proxy;
		process.env.HTTPS_PROXY ??= proxy;
	}

	if (!effectiveProxy) {
		currentProxyStatus = {
			...currentProxyStatus,
			configured: false,
			source: "none",
			proxyUrl: undefined,
			dispatcherInstalled: false,
		};
		logProxyNotice(currentProxyStatus);
		return currentProxyStatus;
	}

	// Only swap in the proxy-aware dispatcher when a proxy is actually in
	// effect. Users without a proxy keep Node's built-in `fetch` as before.
	configureHttpDispatcher(idleTimeoutMs);
	currentProxyStatus = {
		...currentProxyStatus,
		configured: true,
		source,
		proxyUrl: effectiveProxy,
		dispatcherInstalled: true,
	};
	logProxyNotice(currentProxyStatus);
	return currentProxyStatus;
}

function logProxyNotice(status: HttpProxyStatus): void {
	if (status.configured) {
		process.stderr.write(
			`[sigpi] http proxy: routing model requests via ${status.proxyUrl} (source: ${status.source})\n`,
		);
	} else {
		process.stderr.write(
			"[sigpi] http proxy: none detected — model requests use direct connections\n",
		);
	}
}

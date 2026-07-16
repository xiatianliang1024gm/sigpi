import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Project trust — Pi-style gating of *project-local resource loading*.
 *
 * SigPi runs with the permissions of the account that starts it; the OS /
 * container is the only real isolation boundary. The one built-in "permission"
 * concept that remains is project trust: a per-directory decision that gates
 * whether SigPi *loads project-local resources* (the project's skills and the
 * project `.sigpi/config.toml` override) before working in a directory. It
 * mirrors Pi's project trust — it guards resource *loading*, not what tools the
 * model may call once running. See ADR 0022.
 *
 * Trusted resources are discovered by walking cwd → filesystem root:
 *   - project `.sigpi/skills`, `.agents/skills`
 *   - project `.sigpi/config.toml` (a bare `.sigpi/` directory does NOT trigger)
 * A trusted project loads both its skills and its config override together.
 * Global skill roots (`~/.sigpi/skills`, `~/.agents/skills`) are user-installed
 * and never gated. `AGENTS.md` / `CONTEXT.md` / `CLAUDE.md` load regardless.
 */

export type ProjectTrustPreference = "ask" | "always" | "never";
export type TrustDecision = "always" | "never";

export interface ProjectTrustResult {
	/** Whether to load project-local resources (skills + project config override) this run. */
	allows: boolean;
	/** True when project resource loading was skipped because the project is not trusted (deny path with gated resources present). */
	skipped: boolean;
	reason:
		| "no-gating-resources"
		| "cli-approve"
		| "cli-no-approve"
		| "saved-always"
		| "saved-never"
		| "default-always"
		| "default-never"
		| "prompt-always"
		| "prompt-never"
		| "headless-denied";
}

export interface ResolveProjectTrustOptions {
	cwd: string;
	homeDir: string;
	defaultTrust: ProjectTrustPreference;
	/** Per-run override: trust project resources. Does not persist. */
	approve?: boolean;
	/** Per-run override: do not trust project resources. Does not persist. */
	noApprove?: boolean;
	/**
	 * Called when the user must be asked interactively (default trust is
	 * "ask" and no saved/CLI decision applies). Receives the canonical
	 * project directory and returns the chosen decision, or `null` to
	 * decline. Omit (or return null) for a headless run, which denies.
	 */
	prompt?: (dir: string) => Promise<TrustDecision | null>;
}

/** Skill/config paths that, if present, make a directory gating-relevant. */
const GATING_MARKERS = [
	path.join(".sigpi", "skills"),
	path.join(".agents", "skills"),
	path.join(".sigpi", "config.toml"),
];

/** True when any ancestor of `cwd` (including `cwd`) carries gated resources. */
export function projectHasGatedResources(cwd: string): boolean {
	return findClosestGatingDir(cwd) !== undefined;
}

/**
 * Walk cwd → filesystem root and return the first directory (canonical,
 * absolute) that carries a gating marker, or `undefined` if none. The closest
 * gating directory is the natural unit of trust — trusting it covers the whole
 * project regardless of which subdir SigPi was launched from.
 */
export function findClosestGatingDir(cwd: string): string | undefined {
	let dir = path.resolve(cwd);
	for (;;) {
		for (const marker of GATING_MARKERS) {
			if (existsSync(path.join(dir, marker))) {
				return dir;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return undefined;
}

export function getTrustStorePath(homeDir: string): string {
	return path.join(homeDir, ".sigpi", "trust.json");
}

export interface TrustStore {
	decisions: Record<string, TrustDecision>;
}

/**
 * Read the persisted trust decisions from `~/.sigpi/trust.json`. The on-disk
 * shape is `{ decisions: { "<canonical absolute dir>": "always" | "never" } }`.
 * A missing or corrupt store yields an empty map rather than failing the run.
 */
export function readTrustStore(homeDir: string): TrustStore {
	const filePath = getTrustStorePath(homeDir);
	if (!existsSync(filePath)) {
		return { decisions: {} };
	}
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		if (
			parsed &&
			typeof parsed === "object" &&
			"decisions" in parsed &&
			parsed.decisions &&
			typeof parsed.decisions === "object"
		) {
			const decisions = parsed.decisions as Record<string, unknown>;
			const cleaned: Record<string, TrustDecision> = {};
			for (const [dir, value] of Object.entries(decisions)) {
				if (value === "always" || value === "never") {
					cleaned[path.resolve(dir)] = value;
				}
			}
			return { decisions: cleaned };
		}
	} catch {
		// Corrupt store: start fresh rather than failing the run.
	}
	return { decisions: {} };
}

/**
 * Walk cwd → filesystem root and return the closest saved decision, or
 * `undefined` if none. A saved decision for a parent applies to subdirs unless
 * a closer decision exists.
 */
export function lookupClosestTrust(
	store: TrustStore,
	cwd: string,
): TrustDecision | undefined {
	let dir = path.resolve(cwd);
	for (;;) {
		const decision = store.decisions[dir];
		if (decision) {
			return decision;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return undefined;
}

/** Persist a decision for `dir` (canonical, absolute) into the trust store. */
export function writeTrustDecision(
	homeDir: string,
	dir: string,
	decision: TrustDecision,
): void {
	const store = readTrustStore(homeDir);
	store.decisions[path.resolve(dir)] = decision;
	const storePath = getTrustStorePath(homeDir);
	mkdirSync(path.dirname(storePath), { recursive: true });
	writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

/**
 * Resolve whether SigPi may load project-local resources for `cwd`.
 *
 * The decision order (first match wins):
 *   1. No gated resources anywhere → allow, no gate (nothing to trust).
 *   2. `--approve` / `--no-approve` per-run override (does not persist).
 *   3. Closest saved decision in `~/.sigpi/trust.json` (walk cwd → root).
 *   4. Global `defaultProjectTrust` (`always` / `never`).
 *   5. `ask` with an interactive `prompt` → persist the chosen decision.
 *   6. `ask` without a prompt (headless) → deny, caller notes the skip.
 */
export async function resolveProjectTrust(
	options: ResolveProjectTrustOptions,
): Promise<ProjectTrustResult> {
	const { cwd, homeDir, defaultTrust, approve, noApprove, prompt } = options;

	const gatingDir = findClosestGatingDir(cwd);
	if (!gatingDir) {
		return { allows: true, skipped: false, reason: "no-gating-resources" };
	}

	if (approve) {
		return { allows: true, skipped: false, reason: "cli-approve" };
	}
	if (noApprove) {
		return { allows: false, skipped: true, reason: "cli-no-approve" };
	}

	const saved = lookupClosestTrust(readTrustStore(homeDir), cwd);
	if (saved === "always") {
		return { allows: true, skipped: false, reason: "saved-always" };
	}
	if (saved === "never") {
		return { allows: false, skipped: true, reason: "saved-never" };
	}

	if (defaultTrust === "always") {
		return { allows: true, skipped: false, reason: "default-always" };
	}
	if (defaultTrust === "never") {
		return { allows: false, skipped: true, reason: "default-never" };
	}

	// default "ask": prompt only when an interactive UI is provided.
	if (!prompt) {
		return { allows: false, skipped: true, reason: "headless-denied" };
	}
	const choice = await prompt(gatingDir);
	if (choice !== "always" && choice !== "never") {
		return { allows: false, skipped: true, reason: "headless-denied" };
	}
	writeTrustDecision(homeDir, gatingDir, choice);
	return {
		allows: choice === "always",
		skipped: choice === "never",
		reason: choice === "always" ? "prompt-always" : "prompt-never",
	};
}

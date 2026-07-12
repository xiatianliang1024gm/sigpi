import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LoadedSkill, SkillWarning } from "../types.js";
import { parseSkillDocument } from "./manifest.js";

export interface SkillCatalogLoadResult {
	loadedSkills: LoadedSkill[];
	warnings: SkillWarning[];
	fingerprint: string | null;
}

export interface LoadSkillCatalogOptions {
	/** Working directory to scan for project skills. */
	cwd: string;
	/** Home directory for global skill roots. Defaults to $HOME / os.homedir(). */
	homeDir?: string;
}

/**
 * Load every skill discoverable from the standard skill roots.
 *
 * Discovery precedence (first match wins; later duplicates are skipped with a
 * warning):
 *   1. project `.sigpi/skills` — cwd up to the filesystem root
 *   2. project `.agents/skills` — cwd up to the filesystem root
 *   3. global `~/.sigpi/skills`
 *   4. global `~/.agents/skills`
 *
 * sigpi's own `.sigpi` namespace always takes precedence over `.agents`,
 * and project roots beat global roots.
 */
export async function loadSkillCatalog(
	options: LoadSkillCatalogOptions,
): Promise<SkillCatalogLoadResult> {
	const cwd = options.cwd;
	const homeDir = options.homeDir ?? process.env.HOME ?? os.homedir();
	const roots = collectSkillRoots(cwd, homeDir);

	const allWarnings: SkillWarning[] = [];
	const loadedSkills: LoadedSkill[] = [];
	const loadedNames = new Set<string>();

	for (const root of roots) {
		const result = await loadSkillsFromDir(root);
		allWarnings.push(...result.warnings);
		for (const skill of result.loadedSkills) {
			if (loadedNames.has(skill.name)) {
				allWarnings.push({
					skillName: skill.name,
					message: `Skipped skill: duplicate skill name "${skill.name}" (already loaded from an earlier location).`,
				});
				continue;
			}
			loadedNames.add(skill.name);
			loadedSkills.push(skill);
		}
	}

	loadedSkills.sort((left, right) => left.name.localeCompare(right.name));
	return {
		loadedSkills,
		warnings: allWarnings,
		fingerprint: buildSkillsFingerprint(loadedSkills),
	};
}

function collectSkillRoots(cwd: string, homeDir: string): string[] {
	const projectRoots: string[] = [];
	let dir = path.resolve(cwd);
	for (;;) {
		projectRoots.push(path.join(dir, ".sigpi", "skills"));
		projectRoots.push(path.join(dir, ".agents", "skills"));
		const parent = path.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	// sigpi's own namespace precedes the agents namespace; within a namespace,
	// nearer-to-cwd roots precede ancestors.
	const sigpiRoots = projectRoots.filter((root) =>
		root.endsWith(path.join(".sigpi", "skills")),
	);
	const agentsRoots = projectRoots.filter((root) =>
		root.endsWith(path.join(".agents", "skills")),
	);

	const globalRoots = [
		path.join(homeDir, ".sigpi", "skills"),
		path.join(homeDir, ".agents", "skills"),
	];

	return [...sigpiRoots, ...agentsRoots, ...globalRoots];
}

async function loadSkillsFromDir(
	skillsRoot: string,
): Promise<SkillCatalogLoadResult> {
	let entries: Array<{ name: string; fullPath: string }> = [];

	try {
		const dirEntries = await readdir(skillsRoot, { withFileTypes: true });
		entries = dirEntries
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map((entry) => ({
				name: entry.name,
				fullPath: path.join(skillsRoot, entry.name),
			}))
			.sort((left, right) => left.name.localeCompare(right.name));
	} catch (error) {
		if (isMissingFile(error)) {
			return { loadedSkills: [], warnings: [], fingerprint: null };
		}
		throw error;
	}

	const warnings: SkillWarning[] = [];
	const loaded: LoadedSkill[] = [];
	const byName = new Map<string, LoadedSkill[]>();

	for (const entry of entries) {
		const manifestPath = path.join(entry.fullPath, "SKILL.md");
		let content: string;
		try {
			content = await readFile(manifestPath, "utf8");
		} catch (error) {
			warnings.push({
				skillName: entry.name,
				message: `Skipped skill: cannot read SKILL.md (${formatError(error)}).`,
			});
			continue;
		}

		try {
			const parsed = parseSkillDocument(content);
			if (parsed.frontmatter.name !== entry.name) {
				warnings.push({
					skillName: entry.name,
					message: `Skipped skill: manifest name "${parsed.frontmatter.name}" does not match directory "${entry.name}".`,
				});
				continue;
			}

			const skill: LoadedSkill = {
				name: parsed.frontmatter.name,
				description: parsed.frontmatter.description,
				dir: entry.fullPath,
				configRoot: path.resolve(skillsRoot, ".."),
				manifestPath,
				body: parsed.body,
				license: parsed.frontmatter.license,
				compatibility: parsed.frontmatter.compatibility,
				metadata: parsed.frontmatter.metadata ?? {},
				allowedTools: parsed.frontmatter.allowedTools,
				rawFrontmatter: parsed.raw,
			};
			loaded.push(skill);
			const existing = byName.get(skill.name) ?? [];
			existing.push(skill);
			byName.set(skill.name, existing);
		} catch (error) {
			warnings.push({
				skillName: entry.name,
				message: `Skipped skill: ${formatError(error)}`,
			});
		}
	}

	const dedupedSkills: LoadedSkill[] = [];
	for (const skill of loaded) {
		const duplicates = byName.get(skill.name) ?? [];
		if (duplicates.length > 1) {
			if (duplicates[0] === skill) {
				warnings.push({
					skillName: skill.name,
					message: `Skipped skill: duplicate skill name "${skill.name}".`,
				});
			}
			continue;
		}
		dedupedSkills.push(skill);
	}

	dedupedSkills.sort((left, right) => left.name.localeCompare(right.name));
	return {
		loadedSkills: dedupedSkills,
		warnings,
		fingerprint: buildSkillsFingerprint(dedupedSkills),
	};
}

export function buildSkillsFingerprint(skills: LoadedSkill[]): string | null {
	if (skills.length === 0) {
		return null;
	}

	const hash = createHash("sha256");
	for (const skill of [...skills].sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		hash.update(skill.name);
		hash.update(skill.description);
		hash.update(skill.body);
		hash.update(skill.dir);
		hash.update(skill.license ?? "");
		hash.update(skill.compatibility ?? "");
		hash.update(skill.allowedTools ?? "");
	}
	return hash.digest("hex");
}

function isMissingFile(error: unknown): boolean {
	return Boolean(
		error &&
			typeof error === "object" &&
			"code" in error &&
			(error as { code?: string }).code === "ENOENT",
	);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

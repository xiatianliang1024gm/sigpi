import { parse as parseYaml } from "yaml";
import type { SkillFrontmatter } from "../types.js";

export interface ParsedSkillDocument {
	frontmatter: SkillFrontmatter;
	/** Full parsed frontmatter, including fields sigpi does not specialize. */
	raw: Record<string, unknown>;
	body: string;
}

/**
 * Parse a `SKILL.md` document into its frontmatter and instruction body.
 *
 * Frontmatter follows the Agent Skills specification:
 * `name` and `description` are required; `license`, `compatibility`,
 * `metadata`, and `allowed-tools` are optional; any other field is ignored
 * (lenient parsing so skills authored for other harnesses still load).
 */
export function parseSkillDocument(content: string): ParsedSkillDocument {
	const normalized = content.replace(/^﻿/, "").replace(/\r\n/g, "\n");
	const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u);

	if (!match) {
		throw new Error(
			"Skill file must start with YAML frontmatter delimited by ---.",
		);
	}

	const raw = (parseYaml(match[1] ?? "") ?? {}) as Record<string, unknown>;
	const name = asString(raw.name);
	const description = asString(raw.description);

	if (!name) {
		throw new Error("Skill manifest must define a non-empty `name`.");
	}
	if (!description) {
		throw new Error("Skill manifest must define a non-empty `description`.");
	}

	const frontmatter: SkillFrontmatter = {
		name,
		description,
		license: asString(raw.license),
		compatibility: asString(raw.compatibility),
		metadata: asStringRecord(raw.metadata),
		allowedTools: asString(raw.allowedTools ?? raw["allowed-tools"]),
	};

	return {
		frontmatter,
		raw,
		body: (match[2] ?? "").trim(),
	};
}

function asString(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

function asStringRecord(value: unknown): Record<string, string> {
	const result: Record<string, string> = {};
	if (!value || typeof value !== "object") {
		return result;
	}
	for (const [key, val] of Object.entries(value)) {
		if (val === null || val === undefined) {
			continue;
		}
		result[key] = typeof val === "string" ? val : JSON.stringify(val);
	}
	return result;
}

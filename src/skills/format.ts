import type { LoadedSkill } from "../types.js";

/**
 * Build the skill index embedded in the system prompt. Only `name`,
 * `description`, and `dir` are surfaced here — the body and any referenced
 * files are loaded on demand (progressive disclosure) when the model picks a
 * skill. `dir` lets the model resolve relative paths the body mentions
 * (scripts/, references/, assets/).
 */
export function buildSkillCatalogSummary(skills: LoadedSkill[]): string {
	if (skills.length === 0) {
		return "No project skills are currently loaded.";
	}

	return skills
		.map(
			(skill) =>
				`- ${skill.name}: ${skill.description} (skills dir: ${skill.dir})`,
		)
		.join("\n");
}

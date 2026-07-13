import assert from "node:assert/strict";
import test from "node:test";
import type { ChatCommandContext } from "../src/chat-commands.js";
import {
	createChatCommandDefinitions,
	parseChatCommand,
} from "../src/chat-commands.js";
import type { ChatReplState } from "../src/chat-repl.js";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
} from "../src/defaults.js";
import { createShellRuntime } from "../src/shell.js";
import { loadSkillCatalog } from "../src/skills/catalog.js";
import { buildSkillCatalogSummary } from "../src/skills/format.js";
import { parseSkillDocument } from "../src/skills/manifest.js";
import type { LoadedSkill } from "../src/types.js";
import { createTempDir, writeWorkspaceFile } from "./helpers.js";

function minimalSkill(overrides: Partial<LoadedSkill> = {}): LoadedSkill {
	return {
		name: "demo",
		description: "Demo skill",
		dir: "/tmp/demo",
		configRoot: "/tmp",
		manifestPath: "/tmp/demo/SKILL.md",
		body: "Demo body.",
		metadata: {},
		rawFrontmatter: {},
		...overrides,
	};
}

test("loadSkillCatalog returns empty result when skills directory is missing", async () => {
	const cwd = await createTempDir("sigpi-skills-none-");
	const result = await loadSkillCatalog({ cwd, homeDir: cwd });

	assert.deepEqual(result.loadedSkills, []);
	assert.equal(result.fingerprint, null);
	assert.equal(result.warnings.length, 0);
});

test("document-only skill loads without version/actions/resources", async () => {
	const cwd = await createTempDir("sigpi-skills-doc-");
	await writeWorkspaceFile(
		cwd,
		".sigpi/skills/doc-skill/SKILL.md",
		`---
name: doc-skill
description: Documentation only skill
---
This is a documentation-only skill.
`,
	);

	const catalog = await loadSkillCatalog({ cwd, homeDir: cwd });
	assert.equal(catalog.loadedSkills.length, 1);
	assert.equal(catalog.loadedSkills[0]?.name, "doc-skill");
	assert.equal(
		catalog.loadedSkills[0]?.body,
		"This is a documentation-only skill.",
	);
	assert.deepEqual(catalog.loadedSkills[0]?.metadata, {});
});

test("optional frontmatter fields are parsed; unknown fields ignored", async () => {
	const cwd = await createTempDir("sigpi-skills-opt-");
	await writeWorkspaceFile(
		cwd,
		".sigpi/skills/opt/SKILL.md",
		`---
name: opt
description: Optional fields skill
license: MIT
compatibility: Requires git and node.
metadata:
  author: example-org
  version: "1.0"
allowed-tools: Bash(git:*) Read
foreign_field: keep-me
---
Opt body.
`,
	);

	const catalog = await loadSkillCatalog({ cwd, homeDir: cwd });
	const skill = catalog.loadedSkills[0];
	assert.equal(skill?.license, "MIT");
	assert.equal(skill?.compatibility, "Requires git and node.");
	assert.equal(skill?.allowedTools, "Bash(git:*) Read");
	assert.deepEqual(skill?.metadata, { author: "example-org", version: "1.0" });
	assert.equal(skill?.rawFrontmatter.foreign_field, "keep-me");
});

test("missing name or description is skipped with a warning", async () => {
	const cwd = await createTempDir("sigpi-skills-missing-");
	await writeWorkspaceFile(
		cwd,
		".sigpi/skills/no-desc/SKILL.md",
		`---
name: no-desc
---
Body.
`,
	);

	const catalog = await loadSkillCatalog({ cwd, homeDir: cwd });
	assert.equal(catalog.loadedSkills.length, 0);
	assert.match(catalog.warnings[0]?.message ?? "", /must define a non-empty/);
});

test("manifest name must match the directory name", async () => {
	const cwd = await createTempDir("sigpi-skills-namematch-");
	await writeWorkspaceFile(
		cwd,
		".sigpi/skills/real-dir/SKILL.md",
		`---
name: wrong-name
description: Name mismatch
---
Body.
`,
	);

	const catalog = await loadSkillCatalog({ cwd, homeDir: cwd });
	assert.equal(catalog.loadedSkills.length, 0);
	assert.match(catalog.warnings[0]?.message ?? "", /does not match directory/);
});

test("duplicate skill names across locations are skipped with a warning", async () => {
	const cwd = await createTempDir("sigpi-skills-dup-");
	await writeWorkspaceFile(
		cwd,
		".sigpi/skills/dup/SKILL.md",
		`---
name: dup
description: First dup
---
dup one
`,
	);
	await writeWorkspaceFile(
		cwd,
		".agents/skills/dup/SKILL.md",
		`---
name: dup
description: Second dup
---
dup two
`,
	);

	const catalog = await loadSkillCatalog({ cwd, homeDir: cwd });
	assert.equal(
		catalog.loadedSkills.filter((skill) => skill.name === "dup").length,
		1,
	);
	assert.match(
		catalog.warnings.map((warning) => warning.message).join("\n"),
		/duplicate/i,
	);
});

test("project .sigpi skills take precedence over .agents skills", async () => {
	const cwd = await createTempDir("sigpi-skills-precedence-");
	await writeWorkspaceFile(
		cwd,
		".sigpi/skills/shared/SKILL.md",
		`---
name: shared
description: From sigpi namespace
---
sigpi body
`,
	);
	await writeWorkspaceFile(
		cwd,
		".agents/skills/shared/SKILL.md",
		`---
name: shared
description: From agents namespace
---
agents body
`,
	);

	const catalog = await loadSkillCatalog({ cwd, homeDir: cwd });
	const shared = catalog.loadedSkills.find((skill) => skill.name === "shared");
	assert.equal(shared?.description, "From sigpi namespace");
});

test("skills under .agents/skills are discovered", async () => {
	const cwd = await createTempDir("sigpi-skills-agents-");
	await writeWorkspaceFile(
		cwd,
		".agents/skills/agents-skill/SKILL.md",
		`---
name: agents-skill
description: Lives in .agents
---
agents body
`,
	);

	const catalog = await loadSkillCatalog({ cwd, homeDir: cwd });
	assert.equal(
		catalog.loadedSkills.some((skill) => skill.name === "agents-skill"),
		true,
	);
});

test("buildSkillCatalogSummary includes name, description, and directory", () => {
	const summary = buildSkillCatalogSummary([
		minimalSkill({ name: "demo", description: "Demo skill", dir: "/x/demo" }),
	]);
	assert.match(summary, /demo: Demo skill/);
	assert.match(summary, /skills dir: \/x\/demo/);
});

test("system prompt lists skills and no longer references the old gateway", () => {
	const prompt = buildSystemPrompt(createShellRuntime("zsh", "linux"), [
		minimalSkill({ name: "demo", description: "Demo skill", dir: "/x/demo" }),
	]);
	assert.match(prompt, /demo: Demo skill/);
	assert.match(prompt, /skills dir: \/x\/demo/);
	assert.match(prompt, /read its SKILL\.md/);
	assert.equal(prompt.includes("call_skill"), false);
	assert.equal(prompt.includes("list_skills"), false);
});

test("buildSystemPromptSections surfaces the skill index", () => {
	const sections = buildSystemPromptSections(
		createShellRuntime("zsh", "linux"),
		[minimalSkill({ name: "demo", description: "Demo skill", dir: "/x/demo" })],
	);
	const skillSection = sections.find((section) => section.id === "skills");
	assert.ok(skillSection, "expected a skills section");
	assert.match(skillSection?.content ?? "", /demo: Demo skill/);
});

test("/skill lists loaded skills", async () => {
	const state = {
		runtime: {
			loadedSkills: [minimalSkill({ name: "demo", description: "Demo skill" })],
		},
	} as unknown as ChatReplState;
	const lines: string[] = [];
	const context: ChatCommandContext = {
		getState: () => state,
		setState: () => {},
		store: {} as ChatCommandContext["store"],
		writeLine: (line: string) => lines.push(line),
	};

	const command = createChatCommandDefinitions().find(
		(c) => c.name === "/skill",
	);
	if (!command) {
		throw new Error("expected a /skill command");
	}
	const outcome = await command.handler(context, []);

	assert.equal(outcome.action, "continue");
	assert.ok(lines.some((line) => line.includes("demo: Demo skill")));
});

test("/skill <name> with a space lists skills and hints at /skill:<name>", async () => {
	const state = {
		runtime: {
			loadedSkills: [minimalSkill({ name: "demo", description: "Demo skill" })],
		},
	} as unknown as ChatReplState;
	const lines: string[] = [];
	const context: ChatCommandContext = {
		getState: () => state,
		setState: () => {},
		store: {} as ChatCommandContext["store"],
		writeLine: (line: string) => lines.push(line),
	};

	const command = createChatCommandDefinitions().find(
		(c) => c.name === "/skill",
	);
	if (!command) {
		throw new Error("expected a /skill command");
	}
	const outcome = await command.handler(context, ["demo"]);

	assert.equal(outcome.action, "continue");
	assert.ok(lines.some((line) => line.includes("demo: Demo skill")));
	assert.ok(lines.some((line) => line.includes("use /skill:demo")));
});

test("/skill:<name> injects a skill's name, directory, and body as a turn", async () => {
	const skill = minimalSkill({
		name: "demo",
		description: "Demo skill",
		dir: "/x/demo",
		body: "Follow these instructions.",
	});
	const context: ChatCommandContext = {
		getState: () =>
			({ runtime: { loadedSkills: [skill] } }) as unknown as ChatReplState,
		setState: () => {},
		store: {} as ChatCommandContext["store"],
		writeLine: () => {},
	};

	const command = createChatCommandDefinitions({ loadedSkills: [skill] }).find(
		(c) => c.name === "/skill:demo",
	);
	if (!command) {
		throw new Error("expected a /skill:demo command");
	}
	const outcome = await command.handler(context, []);

	assert.equal(outcome.action, "run-turn");
	assert.ok("input" in outcome && typeof outcome.input === "string");
	const input = (outcome as { input: string }).input;
	assert.match(input, /Skill: demo/);
	assert.match(input, /Directory: \/x\/demo/);
	assert.match(input, /Follow these instructions\./);
	assert.equal(input.includes("User request:"), false);
});

test("/skill:<name> <message> injects the skill body and a User request", async () => {
	const skill = minimalSkill({
		name: "demo",
		description: "Demo skill",
		dir: "/x/demo",
		body: "Follow these instructions.",
	});
	const context: ChatCommandContext = {
		getState: () =>
			({ runtime: { loadedSkills: [skill] } }) as unknown as ChatReplState,
		setState: () => {},
		store: {} as ChatCommandContext["store"],
		writeLine: () => {},
	};

	const command = createChatCommandDefinitions({ loadedSkills: [skill] }).find(
		(c) => c.name === "/skill:demo",
	);
	if (!command) {
		throw new Error("expected a /skill:demo command");
	}
	const outcome = await command.handler(context, [
		"please",
		"refactor",
		"this",
	]);

	assert.equal(outcome.action, "run-turn");
	assert.ok("input" in outcome && typeof outcome.input === "string");
	const input = (outcome as { input: string }).input;
	assert.match(input, /Skill: demo/);
	assert.match(input, /Follow these instructions\./);
	assert.match(input, /User request:/);
	assert.match(input, /please refactor this/);
});

test("parseChatCommand resolves /skill: to the list command and /skill:<name> to the skill command", () => {
	const skill = minimalSkill({ name: "demo", description: "Demo skill" });
	const commands = createChatCommandDefinitions({ loadedSkills: [skill] });

	const listParsed = parseChatCommand("/skill:", commands);
	assert.equal(listParsed.kind, "command");
	assert.equal(
		(listParsed as { command: { name: string } }).command.name,
		"/skill",
	);

	const skillParsed = parseChatCommand("/skill:demo", commands);
	assert.equal(skillParsed.kind, "command");
	assert.equal(
		(skillParsed as { command: { name: string } }).command.name,
		"/skill:demo",
	);

	assert.equal(
		parseChatCommand("/skill:demo refactor", commands).kind,
		"command",
	);
});

test("parseSkillDocument throws when frontmatter is absent", () => {
	assert.throws(
		() => parseSkillDocument("No frontmatter here."),
		/must start with YAML frontmatter/,
	);
});

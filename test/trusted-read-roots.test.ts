import assert from "node:assert/strict";
import { realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createAgentRuntime } from "../src/runtime.js";
import { globTool } from "../src/tools/builtin/glob.js";
import { grepTool } from "../src/tools/builtin/grep.js";
import { createReadTool } from "../src/tools/builtin/read.js";
import {
	grepWorkspaceContentFallback,
	listWorkspaceFilesFallback,
} from "../src/tools/local-search.js";
import { buildTrustedReadRoots } from "../src/tools/path-utils.js";
import { ReadTracker } from "../src/tools/read-tracker.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createTempDir } from "./helpers.js";

const cwd = process.cwd();

async function makeOutsideSkillDir(): Promise<string> {
	const dir = await createTempDir("sigpi-skill-");
	writeFileSync(path.join(dir, "SKILL.md"), "name: demo\nskill-body-token\n");
	return dir;
}

// ---------------------------------------------------------------------------
// buildTrustedReadRoots
// ---------------------------------------------------------------------------

test("buildTrustedReadRoots registers a plain directory's resolved path once", async () => {
	const dir = await createTempDir("sigpi-skill-");
	const roots = await buildTrustedReadRoots([dir]);
	assert.deepEqual(roots, [path.resolve(dir)]);
});

test("buildTrustedReadRoots registers raw and canonical (realpath) forms for a symlink", async () => {
	const realDir = await createTempDir("sigpi-skill-");
	const linkParent = await createTempDir("sigpi-link-");
	const sym = path.join(linkParent, "skills");
	symlinkSync(realDir, sym);

	const roots = await buildTrustedReadRoots([sym]);

	// Both the symlinked path and the on-disk real path must be trusted, so a
	// read issued through either form succeeds (this is what makes global
	// skills readable when ~/.agents is itself a symlink).
	assert.equal(roots.length, 2);
	assert.ok(roots.includes(sym), "missing raw symlink root");
	assert.ok(roots.includes(realpathSync(sym)), "missing realpath root");
});

// ---------------------------------------------------------------------------
// read tool
// ---------------------------------------------------------------------------

test("read tool opens a file outside cwd when its directory is in allowedReadRoots", async () => {
	const skillDir = await makeOutsideSkillDir();
	const target = path.join(skillDir, "SKILL.md");
	const tools = new ToolRegistry([createReadTool(new ReadTracker())]);

	const result = await tools.execute(
		{
			id: "read_outside_1",
			name: "read",
			arguments: { file_path: target },
			rawArguments: JSON.stringify({ file_path: target }),
		},
		{ cwd, allowedReadRoots: [skillDir] },
	);

	assert.equal(result.ok, true);
	assert.match(
		(result.data as { content: string }).content,
		/skill-body-token/,
	);
});

test("read tool still blocks outside-cwd files absent from allowedReadRoots", async () => {
	const outside = await createTempDir("sigpi-escape-");
	const secret = path.join(outside, "secret.txt");
	writeFileSync(secret, "topsecret");
	const tools = new ToolRegistry([createReadTool(new ReadTracker())]);

	const result = await tools.execute(
		{
			id: "read_blocked_1",
			name: "read",
			arguments: { file_path: secret },
			rawArguments: JSON.stringify({ file_path: secret }),
		},
		{ cwd, allowedReadRoots: [] },
	);

	assert.equal(result.ok, false);
	assert.match(
		result.error ?? "",
		/Path must stay within the working directory/,
	);
});

test("read tool opens a global skill file through a symlinked skill directory", async () => {
	// Reproduces the reported failure: a global skill under ~/.agents/skills
	// (which may be a symlink) could not be read by the agent.
	const realDir = await createTempDir("sigpi-skill-");
	writeFileSync(
		path.join(realDir, "SKILL.md"),
		"name: demo\nskill-body-token\n",
	);
	const linkParent = await createTempDir("sigpi-link-");
	const sym = path.join(linkParent, "skills");
	symlinkSync(realDir, sym);

	const roots = await buildTrustedReadRoots([sym]);
	const target = path.join(sym, "SKILL.md");
	const tools = new ToolRegistry([createReadTool(new ReadTracker())]);

	const result = await tools.execute(
		{
			id: "read_sym_1",
			name: "read",
			arguments: { file_path: target },
			rawArguments: JSON.stringify({ file_path: target }),
		},
		{ cwd, allowedReadRoots: roots },
	);

	assert.equal(result.ok, true);
	assert.match(
		(result.data as { content: string }).content,
		/skill-body-token/,
	);
});

// ---------------------------------------------------------------------------
// grep / glob tools honor allowedReadRoots on the `path` argument
// ---------------------------------------------------------------------------

test("grep finds content in an outside-cwd directory listed in allowedReadRoots", async () => {
	const skillDir = await makeOutsideSkillDir();
	const tools = new ToolRegistry([grepTool]);

	const result = await tools.execute(
		{
			id: "grep_outside_1",
			name: "grep",
			arguments: {
				pattern: "skill-body-token",
				path: skillDir,
				output_mode: "content",
			},
			rawArguments: JSON.stringify({
				pattern: "skill-body-token",
				path: skillDir,
				output_mode: "content",
			}),
		},
		{ cwd, allowedReadRoots: [skillDir] },
	);

	assert.equal(result.ok, true);
	assert.match(
		(result.data as { matches: string }).matches,
		/skill-body-token/,
	);
});

test("grep blocks an outside-cwd path absent from allowedReadRoots", async () => {
	const outside = await createTempDir("sigpi-escape-");
	const tools = new ToolRegistry([grepTool]);

	const result = await tools.execute(
		{
			id: "grep_blocked_1",
			name: "grep",
			arguments: { pattern: "x", path: outside },
			rawArguments: JSON.stringify({ pattern: "x", path: outside }),
		},
		{ cwd, allowedReadRoots: [] },
	);

	assert.equal(result.ok, false);
	assert.match(
		result.error ?? "",
		/Path must stay within the working directory/,
	);
});

test("glob lists files in an outside-cwd directory listed in allowedReadRoots", async () => {
	const skillDir = await makeOutsideSkillDir();
	const tools = new ToolRegistry([globTool]);

	const result = await tools.execute(
		{
			id: "glob_outside_1",
			name: "glob",
			arguments: { pattern: "**/*.md", path: skillDir },
			rawArguments: JSON.stringify({ pattern: "**/*.md", path: skillDir }),
		},
		{ cwd, allowedReadRoots: [skillDir] },
	);

	assert.equal(result.ok, true);
	assert.match((result.data as { rendered: string }).rendered, /SKILL\.md/);
});

test("glob blocks an outside-cwd path absent from allowedReadRoots", async () => {
	const outside = await createTempDir("sigpi-escape-");
	const tools = new ToolRegistry([globTool]);

	const result = await tools.execute(
		{
			id: "glob_blocked_1",
			name: "glob",
			arguments: { pattern: "**/*.txt", path: outside },
			rawArguments: JSON.stringify({ pattern: "**/*.txt", path: outside }),
		},
		{ cwd, allowedReadRoots: [] },
	);

	assert.equal(result.ok, false);
	assert.match(
		result.error ?? "",
		/Path must stay within the working directory/,
	);
});

// ---------------------------------------------------------------------------
// local-search fallback walkers honor allowedRoots directly
// ---------------------------------------------------------------------------

test("grepWorkspaceContentFallback honors allowedRoots for an outside-cwd startPath", async () => {
	const skillDir = await makeOutsideSkillDir();
	const out = await grepWorkspaceContentFallback({
		cwd,
		startPath: skillDir,
		allowedRoots: [skillDir],
		pattern: "skill-body-token",
		case_sensitive: false,
		multiline: false,
		context: 0,
		output_mode: "content",
		head_limit: 100,
		offset: 0,
	});
	assert.match(out.output, /skill-body-token/);
});

test("grepWorkspaceContentFallback blocks an outside-cwd startPath absent from allowedRoots", async () => {
	const outside = await createTempDir("sigpi-escape-");
	await assert.rejects(
		() =>
			grepWorkspaceContentFallback({
				cwd,
				startPath: outside,
				allowedRoots: [],
				pattern: "x",
				case_sensitive: false,
				multiline: false,
				context: 0,
				output_mode: "content",
				head_limit: 100,
				offset: 0,
			}),
		/Path must stay within the working directory/,
	);
});

test("listWorkspaceFilesFallback honors allowedRoots for an outside-cwd startPath", async () => {
	const skillDir = await makeOutsideSkillDir();
	const { files } = await listWorkspaceFilesFallback({
		cwd,
		startPath: skillDir,
		allowedRoots: [skillDir],
		maxResults: 100,
	});
	assert.ok(
		files.some((file) => file.endsWith("SKILL.md")),
		`expected SKILL.md in results: ${JSON.stringify(files)}`,
	);
});

// ---------------------------------------------------------------------------
// Runtime wiring: config.tools.allowed_roots must reach context.allowedReadRoots
// ---------------------------------------------------------------------------

test("config.tools.allowed_roots flows into read tool's trusted roots at runtime", async () => {
	const scratch = await createTempDir("sigpi-runtime-trusted-");
	const notePath = path.join(scratch, "note.txt");
	writeFileSync(notePath, "hello from scratch\n");

	// Write a real config file carrying allowed_roots, then let the runtime
	// load it from disk — mirroring the actual user scenario.
	const configDir = path.join(cwd, ".sigpi");
	await mkdir(configDir, { recursive: true });
	await writeFile(
		path.join(configDir, "config.toml"),
		[
			"[model]",
			'active = "test"',
			"",
			"[models.test]",
			'base_url = "https://example.test/v1"',
			'api_key = "test-key"',
			'name = "test-model"',
			"timeout_ms = 2000",
			"max_retries = 0",
			"retry_base_delay_ms = 10",
			"",
			"[tools]",
			`allowed_roots = ["${scratch}"]`,
		].join("\n"),
		"utf8",
	);

	const runtime = await createAgentRuntime();
	// The runner wires config.tools.allowed_roots into its trusted read roots.
	const runnerOptions = (
		runtime.runner as unknown as {
			options: { allowedReadRoots: string[] };
		}
	).options;
	assert.ok(
		runnerOptions.allowedReadRoots.includes(scratch),
		`expected ${scratch} in allowedReadRoots: ${JSON.stringify(runnerOptions.allowedReadRoots)}`,
	);

	const result = await runtime.tools.execute(
		{
			id: "runtime_read_trusted_1",
			name: "read",
			arguments: { file_path: notePath },
			rawArguments: JSON.stringify({ file_path: notePath }),
		},
		{ cwd, allowedReadRoots: runnerOptions.allowedReadRoots },
	);

	assert.equal(result.ok, true);
	assert.match(
		(result.data as { rendered: string }).rendered,
		/hello from scratch/,
	);
});

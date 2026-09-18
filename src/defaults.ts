import { buildSkillCatalogSummary } from "./skills/format.js";
import type {
	LoadedSkill,
	ShellRuntime,
	SystemPromptSection,
} from "./types.js";

interface SystemEnvironmentInfo {
	/**
	 * Absolute path of the project (launch) directory — where the agent's file
	 * tools and shell start.
	 */
	cwd: string;
}

function buildEnvironmentSection(
	shellRuntime: ShellRuntime,
	environment: SystemEnvironmentInfo,
): SystemPromptSection {
	return {
		id: "environment",
		label: "Environment",
		content: [
			`Current project directory: ${environment.cwd}`,
			`Shell executable: ${shellRuntime.executable}`,
		].join("\n"),
	};
}

export function buildSystemPromptSections(
	shellRuntime: ShellRuntime,
	loadedSkills: LoadedSkill[] = [],
	environment: SystemEnvironmentInfo = {
		cwd: process.cwd(),
	},
): SystemPromptSection[] {
	const skillSection =
		loadedSkills.length > 0
			? [
					"Skills are instruction documents the agent can read and follow. They are not separate tools.",
					"When a task matches a skill, read its SKILL.md with the read tool, then follow the instructions.",
					"Skill scripts, references, and assets are reached via relative paths from the skill's directory listed below.",
					"The user can also load a skill into the conversation with the `/skill:<name>` command (or `/skill:<name> <message>` to load and chat in one step).",
					`Available skills:
${buildSkillCatalogSummary(loadedSkills)}`,
				].join(" ")
			: "No project skills are currently loaded.";

	return [
		{
			id: "core",
			label: "Core instructions",
			content:
				"You are a minimal teaching agent. If you modify code or files, treat the task as incomplete until you verify the change when feasible.",
		},
		{
			id: "tools",
			label: "Tool guidance",
			content: [
				"Use tools when they materially improve correctness.",
				"Do not use bash or shell scripts for file/path discovery when glob or grep can answer it.",
				"Prefer the edit tool for targeted changes to an existing file instead of shell redirection or shell text-processing commands. The write tool creates or overwrites an entire file without requiring a prior read.",
				"If a file-read result is truncated and no continuation metadata is available, retry with a smaller window instead of guessing.",
				"After making changes, run the narrowest relevant validation command available, such as a focused test, lint, or build step.",
			].join(" "),
		},
		{
			id: "shell",
			label: "Shell guidance",
			content: [
				`Current platform: ${shellRuntime.platform}.`,
				`Current shell for bash: ${shellRuntime.shell} (${shellRuntime.displayName}).`,
				"Treat bash and skill action processes as ordinary subprocesses; SigPi does not sandbox them — the operating system or container is the only real isolation boundary. Run SigPi only in contexts you trust.",
				"When using bash, generate commands for the current shell and platform instead of assuming Unix syntax.",
				"Every bash command runs in the project directory. A `cd` inside a command affects only that command's process and never carries into later commands, so write paths relative to the project directory (or use absolute paths).",
				"For long output the bash tool writes the full output to a session file and returns the file path plus a preview; use the read tool to open it.",
				"Run a command in the background with `run_in_background: true`; the tool returns a task id and a log path immediately and the turn continues. List tasks with the `/tasks` chat command; open a task's details with Enter and press `k` to stop it. Read the log file to follow progress.",
				"Environment variables do not persist across bash commands. To make them persist, set CLAUDE_ENV_FILE to a shell script that the tool sources before each command.",
				"Treat bash and skill action processes as ordinary subprocesses, not a strong sandbox for untrusted code.",
				"The tool safety mode is a guardrail against accidental writes and dangerous commands; full OS-level isolation is not provided.",
			].join(" "),
		},
		buildEnvironmentSection(shellRuntime, environment),
		{
			id: "skills",
			label: "Skill guidance",
			content: skillSection,
		},
		{
			id: "exploration",
			label: "Exploration strategy",
			content: [
				"Use a targeted-first strategy: start with the most specific search or file read that answers the question. Broaden only when the targeted approach yields nothing.",
				"Stop exploring as soon as you have enough context to answer or implement. Do not read every file in a directory just to confirm nothing is there. Do not follow every import or dependency trace unless the task explicitly requires exhaustive understanding.",
				"If glob or grep returns more files than needed, narrow with a more specific pattern or query rather than reading them all. Read one representative file first, then decide if more are needed.",
				"When you have enough context to implement a solution, stop exploring and start implementing. If during implementation you discover missing details, do a targeted follow-up read rather than restarting broad exploration.",
				"After 2-3 read operations on the same topic without finding what you need, step back and reason from what is already known rather than continuing to search blindly. Consider that the concept may use a different name, pattern, or location.",
			].join(" "),
		},
		{
			id: "style",
			label: "Failure and style",
			content: [
				"When a tool fails, explain the failure briefly and continue if possible.",
				"If validation is not possible, say what blocked it instead of implying the change was verified.",
				"Keep answers concise and grounded in available context.",
			].join(" "),
		},
	];
}

export function buildSystemPrompt(
	shellRuntime: ShellRuntime,
	loadedSkills: LoadedSkill[] = [],
	environment: SystemEnvironmentInfo = {
		cwd: process.cwd(),
	},
): string {
	return buildSystemPromptSections(shellRuntime, loadedSkills, environment)
		.map((section) => `## ${section.label}\n\n${section.content}`)
		.join("\n\n");
}

/** Character ceiling the sub-agent is asked to keep its reply within. */
export const SUB_AGENT_OUTPUT_MAX_CHARS = 2_000;

/**
 * System prompt for the delegated sub-agent. Deliberately separate from
 * {@link buildSystemPrompt}: the sub-agent gets no skills and none of the main
 * conversation's conventions — only its single-task output contract. That
 * contract is what makes context savings real: the entire reply is fed back
 * into the parent's window, so it must be short and self-contained rather than
 * a transcript of what was read.
 */
export function buildSubAgentSystemPrompt(options: { cwd: string }): string {
	return [
		"You are a sub-agent. The main agent delegated exactly one self-contained task to you.",
		`Current project directory: ${options.cwd}`,
		[
			"## Your task",
			"Complete only the single task you were given. Do not broaden the scope, do not modify files, and do not ask questions — there is no one to answer them.",
			"You have read, grep and glob to inspect the repo, and bash to run commands (tests, builds, git). Gather evidence yourself instead of assuming file contents; you have no file-editing tools, so keep the repo unchanged.",
		].join("\n"),
		[
			"## Output contract",
			"The main agent only ever receives your final reply, not the files you read, so it must be self-contained.",
			"Reply with a short, structured conclusion and nothing else, using exactly these three sections:",
			"",
			"- 结论: the direct answer to the task.",
			"- 证据: the concrete evidence, one item per line, each as `path:line` (1-based) so the main agent can use it without re-reading the file.",
			"- 未解问题: anything you could not determine; write 无 when there is none.",
			"",
			`Keep the entire reply under ${SUB_AGENT_OUTPUT_MAX_CHARS} characters.`,
		].join("\n"),
	].join("\n\n");
}

import type { SubAgentRunner } from "../agent/sub-agent.js";
import type { RunShellConfig } from "../config.js";
import { detectShellRuntime } from "../shell.js";
import type { ShellRuntime } from "../types.js";
import { createBashTool } from "./builtin/bash.js";
import { createEditTool } from "./builtin/edit.js";
import { globTool } from "./builtin/glob.js";
import { grepTool } from "./builtin/grep.js";
import { createReadTool } from "./builtin/read.js";
import { createSubAgentTool } from "./builtin/sub-agent.js";
import { createUpdatePlanTool } from "./builtin/update-plan.js";
import { createWriteTool } from "./builtin/write.js";
import { ReadTracker } from "./read-tracker.js";
import { ToolRegistry } from "./registry.js";

export function createDefaultToolRegistry(
	shellRuntime?: ShellRuntime,
	bashConfig: RunShellConfig = {},
	extras?: { subAgent?: SubAgentRunner },
): ToolRegistry {
	const readTracker = new ReadTracker();
	const registry = new ToolRegistry([
		globTool,
		grepTool,
		createReadTool(readTracker),
		createWriteTool(readTracker),
		createEditTool(readTracker),
		createUpdatePlanTool(),
		createBashTool(
			shellRuntime ?? detectShellRuntime(),
			bashConfig,
			readTracker,
		),
	]);
	if (extras?.subAgent) {
		registry.register(createSubAgentTool(extras.subAgent));
	}
	return registry;
}

/**
 * Registry for the delegated sub-agent. It keeps the read-only inspection
 * tools (`glob` / `grep` / `read`) and adds `bash` so a child can run commands
 * — tests, builds, `git` — while gathering evidence. The dedicated mutation
 * tools (`edit` / `write`) and the sub-agent's own `SubAgent` tool stay out, so
 * a child can never recurse or reach for the file-editing tools.
 *
 * A sub-agent call is blocking and never runs concurrently with another
 * sub-agent, and it is never backgrounded itself, so a shared shell is safe
 * here. `bash` still runs against the project directory, and when the caller
 * supplies a `bashToolContext` on the runner it reuses the main agent's output
 * and background-task roots too.
 */
export function createSubAgentToolRegistry(
	shellRuntime?: ShellRuntime,
	bashConfig: RunShellConfig = {},
): ToolRegistry {
	const readTracker = new ReadTracker();
	return new ToolRegistry([
		globTool,
		grepTool,
		createReadTool(readTracker),
		createBashTool(
			shellRuntime ?? detectShellRuntime(),
			bashConfig,
			readTracker,
		),
	]);
}

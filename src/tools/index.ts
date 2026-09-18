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

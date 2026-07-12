import type { RunShellConfig } from "../config.js";
import type { ShellRuntime } from "../types.js";
import { createBashTool } from "./builtin/bash.js";
import { createEditTool } from "./builtin/edit.js";
import { globTool } from "./builtin/glob.js";
import { grepTool } from "./builtin/grep.js";
import { createReadTool } from "./builtin/read.js";
import { createUpdatePlanTool } from "./builtin/update-plan.js";
import { createWriteTool } from "./builtin/write.js";
import { ReadTracker } from "./read-tracker.js";
import { ToolRegistry } from "./registry.js";

export function createDefaultToolRegistry(
	shellRuntime?: ShellRuntime,
	bashConfig: RunShellConfig = { mode: "workspace_write" },
): ToolRegistry {
	const readTracker = new ReadTracker();
	return new ToolRegistry([
		globTool,
		grepTool,
		createReadTool(readTracker),
		createWriteTool(bashConfig, readTracker),
		createEditTool(bashConfig, readTracker),
		createUpdatePlanTool(),
		createBashTool(
			shellRuntime ?? {
				platform: process.platform,
				shell: "zsh",
				executable: "zsh",
				argsPrefix: ["-lc"],
				displayName: "zsh",
			},
			bashConfig,
			readTracker,
		),
	]);
}

import { z } from "zod";
import type { SubAgentRunner } from "../../agent/sub-agent.js";
import { asQuoted, getString } from "../../progress.js";
import type { ToolDefinition } from "../../types.js";
import { withRendered } from "../render.js";

const subAgentSchema = z.object({
	description: z.string().min(1),
});

export type SubAgentArgs = z.infer<typeof subAgentSchema>;

/**
 * The `SubAgent` tool: delegate one self-contained exploration/research task
 * to a child agent. The child does all the reading/searching in its own
 * context; only its final conclusion is handed back as this tool's result,
 * so the parent's window is not filled with raw file reads.
 */
export function createSubAgentTool(
	runSubAgent: SubAgentRunner,
): ToolDefinition<SubAgentArgs> {
	return {
		name: "SubAgent",
		description:
			"Delegate a self-contained exploration/research task to a sub-agent. " +
			"The sub-agent has its own context and decides which files to read and " +
			"what to search; only its final conclusion is returned to you, so its " +
			"intermediate reads do not consume your context. Good for: locating " +
			"implementations, cross-file research, collecting evidence, producing a " +
			"conclusion. Not for: edits that must stay continuous with this conversation.",
		inputSchema: subAgentSchema,
		parameters: {
			type: "object",
			properties: {
				description: {
					type: "string",
					description:
						"The complete task to delegate to the sub-agent, including the goal and the expected output.",
				},
			},
			required: ["description"],
			additionalProperties: false,
		},
		execute: async ({ description }, context) => {
			const result = await runSubAgent.run({
				description,
				signal: context.abortSignal,
			});
			return withRendered(
				{
					steps: result.steps,
					status: result.completionStatus,
					summary: result.outputText,
				},
				// `rendered` is what the parent model sees as the tool result —
				// the sub-agent's conclusion itself, not the JSON envelope above.
				result.outputText,
			);
		},
		describeProgress: (args) => ({
			summary: `delegate to sub-agent: ${asQuoted(getString(args.description) ?? "")}`,
		}),
	};
}

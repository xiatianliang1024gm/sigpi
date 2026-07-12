import type { ZodType } from "zod";
import {
	makeLedgerRecorder,
	normalizeExplorationLedger,
} from "../agent/exploration-ledger.js";
import { isTurnInterruptedError, TurnInterruptedError } from "../interrupt.js";
import type {
	ExplorationLedger,
	JsonValue,
	ToolCall,
	ToolDefinition,
	ToolExecutionContext,
	ToolExecutionResult,
	ToolSchema,
} from "../types.js";
import { joinRenderedSections, withRendered } from "./render.js";

type RegisteredTool = Omit<ToolDefinition, "inputSchema" | "execute"> & {
	inputSchema: ZodType;
	execute: {
		bivarianceHack(
			args: unknown,
			context: ToolExecutionContext,
		): Promise<JsonValue> | JsonValue;
	}["bivarianceHack"];
};

export class ToolExecutionError extends Error {
	constructor(
		message: string,
		public readonly details?: JsonValue,
	) {
		super(message);
		this.name = "ToolExecutionError";
	}
}

export class ToolRegistry {
	private readonly tools = new Map<string, RegisteredTool>();

	constructor(definitions: RegisteredTool[] = []) {
		for (const definition of definitions) {
			this.register(definition);
		}
	}

	register(definition: RegisteredTool): void {
		this.tools.set(definition.name, definition);
	}

	getSchemas(): ToolSchema[] {
		return [...this.tools.values()].map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		}));
	}

	describeProgress(toolCall: ToolCall): { summary: string; detail?: string } {
		const tool = this.tools.get(toolCall.name);
		if (tool?.describeProgress) {
			return tool.describeProgress(toolCall.arguments);
		}
		return { summary: `tool ${toolCall.name}` };
	}

	recordLedger(
		toolCall: ToolCall,
		result: ToolExecutionResult,
		ledger: ExplorationLedger,
	): ExplorationLedger {
		const tool = this.tools.get(toolCall.name);
		if (!tool?.recordLedger) {
			return ledger;
		}
		const next = normalizeExplorationLedger(ledger);
		tool.recordLedger(makeLedgerRecorder(next), toolCall, result);
		return next;
	}

	async execute(
		toolCall: ToolCall,
		context: ToolExecutionContext,
	): Promise<ToolExecutionResult> {
		if (context.abortSignal?.aborted) {
			const reason = context.abortSignal.reason;
			if (isTurnInterruptedError(reason)) {
				throw reason;
			}
			throw new TurnInterruptedError("user_escape", "tool");
		}

		if (toolCall.argumentParseError) {
			return {
				ok: false,
				error: toolCall.argumentParseError,
				details: withRendered(
					{
						toolName: toolCall.name,
						rawArguments: toolCall.rawArguments,
					},
					joinRenderedSections([
						`Tool: ${toolCall.name}`,
						"Reason: arguments could not be parsed as a JSON object.",
						toolCall.rawArguments
							? `Raw arguments: ${toolCall.rawArguments}`
							: null,
					]),
				),
			};
		}

		const tool = this.tools.get(toolCall.name);

		if (!tool) {
			return {
				ok: false,
				error: `Unknown tool: ${toolCall.name}`,
				details: withRendered(
					{
						toolName: toolCall.name,
					},
					`Tool: ${toolCall.name}\nReason: tool is not registered in this runtime.`,
				),
			};
		}

		const parsed = tool.inputSchema.safeParse(toolCall.arguments);

		if (!parsed.success) {
			const issues = parsed.error.issues.map((issue) => ({
				path: issue.path.join(".") || "(root)",
				message: issue.message,
			}));
			const issueSummary =
				issues.length === 0
					? parsed.error.message
					: issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
			return {
				ok: false,
				error: `Tool '${toolCall.name}' received invalid arguments. ${issueSummary}. Check the tool's input schema and retry.`,
				details: withRendered(
					{
						toolName: toolCall.name,
						issues,
					},
					joinRenderedSections([
						`Tool: ${toolCall.name}`,
						"Reason: arguments failed schema validation.",
						"Validation issues:",
						...issues.map((issue) => `- ${issue.path}: ${issue.message}`),
					]),
				),
			};
		}

		try {
			const data = await tool.execute(parsed.data, context);
			return { ok: true, data };
		} catch (error) {
			if (isTurnInterruptedError(error)) {
				throw error;
			}
			if (error instanceof ToolExecutionError) {
				return {
					ok: false,
					error: error.message,
					details: error.details,
				};
			}
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
}

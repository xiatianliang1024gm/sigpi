import { randomUUID } from "node:crypto";
import { estimateContextTokens } from "../context-window.js";
import type { TurnInterruptController } from "../interrupt.js";
import { isTurnInterruptedError, TurnInterruptedError } from "../interrupt.js";
import { summarizeAssistantProgressText } from "../progress.js";
import type { ToolRegistry } from "../tools/registry.js";
import { formatToolExecutionResult } from "../tools/render.js";
import type {
	AgentRunnerOptions,
	ContextUpdateResult,
	ExecutedToolCall,
	Message,
	ModelProvider,
	ModelUsage,
	RunTurnResult,
	ToolCall,
	ToolExecutionResult,
	ToolSchema,
	TurnProgressEvent,
} from "../types.js";
import { CompactionFailedError } from "./compaction-error.js";
import type { ConversationContext } from "./context.js";
import { resolveCurrentGoal } from "./goal-resolution.js";
import {
	createAssistantMessage,
	createSystemMessage,
	createToolMessage,
	createUserMessage,
	renderMessagesForSummary,
} from "./messages.js";

const MUTATING_TOOL_NAMES = new Set(["write", "edit"]);
const VERIFICATION_TOOL_NAMES = new Set(["bash"]);
const DEDUP_SKIPPED_TOOL_NAMES = new Set(["write", "edit", "bash", "read"]);
const DEDUP_WINDOW = 6;
const VERIFICATION_REMINDER =
	"You changed files in this turn. Before finishing, run the narrowest relevant verification command with `bash` if feasible, or explain what blocked validation.";
const MAX_STEPS_SYNTHESIS_PROMPT = [
	"The tool-call step limit has been reached.",
	"Do not request or describe more tool calls.",
	"Answer the user's current request now using the available context.",
	"If the context is incomplete, state the best-effort findings and what remains unknown, but do not claim the user gave no task.",
].join(" ");
const TURN_CHECKPOINT_KEEP_LAST_MESSAGES = 4;
const TURN_CHECKPOINT_PREFIX =
	"Current turn checkpoint. Earlier tool work in this same user turn was compacted:";
const TURN_CHECKPOINT_SYSTEM_PROMPT = [
	"You summarize an in-progress agent turn.",
	"Do NOT continue the task. ONLY output a concise checkpoint that preserves the user's goal, work done, key findings, files inspected or changed, blockers, and next step.",
].join(" ");
const TURN_CHECKPOINT_PROMPT = `Create a concise checkpoint for an in-progress tool-using turn.

Use this EXACT format:

## Current Goal
[Restate the user's current request exactly enough that another model can continue.]

## Work Done This Turn
- [Files read, searches run, commands executed, or edits made]

## Key Findings
- [Important facts discovered, with exact file paths, symbols, and error messages]

## Next Step
1. [What the assistant should do next]

Preserve the user's current goal even if later tool results are large or distracting.`;
const CHECKPOINT_GOAL_LOG_MAX_CHARS = 240;
const DEFAULT_RUNNER_OPTIONS: AgentRunnerOptions = {
	maxSteps: 8,
	temperature: 0.2,
	workingDirectory: process.cwd(),
	enableVerificationReminder: false,
};
const CLEAR_PROGRESS_TOOL_RESULT_MAX_CHARS = 4000;

function formatGoalForLog(goal: string): string {
	const compact = goal.replace(/\s+/g, " ").trim();
	if (compact.length <= CHECKPOINT_GOAL_LOG_MAX_CHARS) {
		return compact;
	}

	return `${compact.slice(0, CHECKPOINT_GOAL_LOG_MAX_CHARS)}...`;
}

function normalizeToolCallKey(toolCall: ToolCall): string {
	const sortedArgs = sortObjectKeys(toolCall.arguments ?? {});
	return JSON.stringify({ name: toolCall.name, args: sortedArgs });
}

function sortObjectKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => sortObjectKeys(item));
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
		);
		const result: Record<string, unknown> = {};
		for (const [key, entry] of entries) {
			result[key] = sortObjectKeys(entry);
		}
		return result;
	}
	if (typeof value === "string") {
		return value.replace(/\s+/g, " ").trim().toLowerCase();
	}
	return value;
}

function findRecentDuplicateToolCall(
	toolCall: ToolCall,
	turnMessages: readonly Message[],
): { stepsBack: number; previousCall: ToolCall } | null {
	if (DEDUP_SKIPPED_TOOL_NAMES.has(toolCall.name)) {
		return null;
	}

	const targetKey = normalizeToolCallKey(toolCall);
	const currentAssistantIndex = findLastAssistantMessageIndex(turnMessages);

	if (currentAssistantIndex === null) {
		return null;
	}

	let assistantCount = 0;

	for (let index = currentAssistantIndex - 1; index >= 0; index -= 1) {
		const message = turnMessages[index];
		if (!message || message.role !== "assistant") {
			continue;
		}
		assistantCount += 1;
		const calls = message.toolCalls ?? [];
		for (const previousCall of calls) {
			if (previousCall.name !== toolCall.name) {
				continue;
			}
			if (normalizeToolCallKey(previousCall) === targetKey) {
				return { stepsBack: assistantCount, previousCall };
			}
		}
		if (assistantCount >= DEDUP_WINDOW) {
			break;
		}
	}

	return null;
}

function findLastAssistantMessageIndex(
	messages: readonly Message[],
): number | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message && message.role === "assistant") {
			return index;
		}
	}
	return null;
}

function buildDuplicateToolCallResult(args: {
	toolName: string;
	stepsBack: number;
}): ToolExecutionResult {
	const summary = `You already called ${args.toolName} with equivalent arguments ${args.stepsBack} assistant turn(s) ago in this turn. Reuse the previous tool result from your conversation history, or change the arguments (different query, glob, range, or path) to read new content.`;
	return {
		ok: true,
		data: {
			repeated: true,
			deduplicated: true,
			toolName: args.toolName,
			stepsBack: args.stepsBack,
		},
		details: {
			repeated: true,
			deduplicated: true,
			toolName: args.toolName,
			stepsBack: args.stepsBack,
			rendered: summary,
		},
	};
}

function findTurnCheckpointSplitIndex(
	messages: readonly Message[],
	keepLastMessages: number,
): number {
	let splitIndex = Math.max(1, messages.length - keepLastMessages);

	// Pull splitIndex back to an assistant message boundary so we never keep
	// an orphan tool message without its corresponding assistant turn.
	while (
		splitIndex > 1 &&
		splitIndex < messages.length &&
		messages[splitIndex]?.role !== "assistant"
	) {
		splitIndex -= 1;
	}

	return splitIndex;
}

export class AgentRunner {
	private provider: ModelProvider;
	private readonly tools: ToolRegistry;
	private readonly toolSchemas: ToolSchema[];
	private readonly context: ConversationContext;
	private readonly systemPrompt: string;
	private readonly options: AgentRunnerOptions;

	constructor(args: {
		provider: ModelProvider;
		tools: ToolRegistry;
		context: ConversationContext;
		systemPrompt: string;
		options?: Partial<AgentRunnerOptions>;
	}) {
		this.provider = args.provider;
		this.tools = args.tools;
		this.toolSchemas = this.tools.getSchemas();
		this.context = args.context;
		this.systemPrompt = args.systemPrompt;
		this.options = { ...DEFAULT_RUNNER_OPTIONS, ...args.options };
	}

	setProvider(provider: ModelProvider): void {
		this.provider = provider;
	}

	async runTurn(
		userInput: string,
		interruptController?: TurnInterruptController,
	): Promise<RunTurnResult> {
		const workingMessages = this.context.buildMessages(
			this.systemPrompt,
			userInput,
		);
		const turnMessages: Message[] = [createUserMessage(userInput)];
		const toolExecutions: ExecutedToolCall[] = [];
		const logger = this.options.logger;
		const progress = this.options.progressReporter;
		const currentGoal = resolveCurrentGoal(userInput, {
			summary: this.context.getSummary(),
			keyFindings: this.context.getExplorationLedger().keyFindings,
			recentMessages: this.context.getRecentMessages(),
		});
		const turnStartedAt = Date.now();
		const turnId = randomUUID();
		let summaryCount = 0;
		let trimCount = 0;
		let lastModelElapsedMs = 0;
		let failureType: string | undefined;
		let turnMessagesPersisted = false;
		let needsVerification = false;
		let verificationReminderSent = false;
		let lastStep = 0;
		let turnCheckpoint: string | null = null;
		let lastCheckpointedTurnMessageCount = 0;

		interruptController?.beginTurn();

		const createContextUpdateSnapshot = (): ContextUpdateResult => {
			const recentMessages = this.context.getRecentMessages();
			return {
				summarized: false,
				trimmed: false,
				summary: this.context.getSummary(),
				recentMessageCount: recentMessages.length,
				previousRecentMessageCount: recentMessages.length,
				summaryChars: this.context.getSummary()?.length ?? 0,
				previousSummaryChars: this.context.getSummary()?.length ?? 0,
				tokensBefore: 0,
				tokensAfter: 0,
			};
		};

		const checkpointTurnMessages = (): ContextUpdateResult => {
			if (turnMessagesPersisted || turnMessages.length === 0) {
				return createContextUpdateSnapshot();
			}

			const checkpointUpdated = this.context.appendRecoveryMessages(
				turnMessages,
				this.systemPrompt,
				this.toolSchemas,
				{ turnId },
			);
			turnMessagesPersisted = true;
			trimCount += Number(checkpointUpdated.trimmed);
			return checkpointUpdated;
		};

		const estimateWorkingMessageTokens = (): number => {
			const lastUsage = this.context.getLastUsage();
			return estimateContextTokens({
				systemPrompt: this.systemPrompt,
				summary: this.context.getSummary(),
				recentMessages: workingMessages.filter(
					(message) => message.role !== "system",
				),
				toolSchemas: this.toolSchemas,
				lastUsage: lastUsage?.usage ?? null,
				lastUsageMessageIndex: lastUsage?.messageIndex ?? null,
			}).totalTokens;
		};

		const reportProgress = (event: TurnProgressEvent): void => {
			progress?.({
				...event,
				estimatedContextTokens: estimateWorkingMessageTokens(),
			});
		};

		const maybeCompactWorkingMessages = async (): Promise<void> => {
			if (turnMessages.length <= TURN_CHECKPOINT_KEEP_LAST_MESSAGES + 1) {
				return;
			}
			if (turnMessages.length === lastCheckpointedTurnMessageCount) {
				return;
			}
			const estimatedTokens = estimateWorkingMessageTokens();
			const budget = this.context.getContextBudget();
			const hardLimitTokens = budget.hardContextLimit - budget.reserveTokens;
			if (estimatedTokens <= hardLimitTokens) {
				return;
			}

			const splitIndex = findTurnCheckpointSplitIndex(
				turnMessages,
				TURN_CHECKPOINT_KEEP_LAST_MESSAGES,
			);
			const messagesToSummarize = turnMessages.slice(0, splitIndex);
			const keptTurnMessages = turnMessages.slice(splitIndex);
			const transcript = renderMessagesForSummary(messagesToSummarize);
			const existingCheckpoint = turnCheckpoint
				? `<previous-turn-checkpoint>\n${turnCheckpoint}\n</previous-turn-checkpoint>\n\n`
				: "";
			const response = await this.provider.generate({
				messages: [
					createSystemMessage(this.systemPrompt),
					createSystemMessage(TURN_CHECKPOINT_SYSTEM_PROMPT),
					createUserMessage(
						[
							`<current-user-goal>\n${currentGoal}\n</current-user-goal>`,
							existingCheckpoint,
							`<conversation>\n${transcript}\n</conversation>`,
							TURN_CHECKPOINT_PROMPT,
						].join("\n\n"),
					),
				],
				tools: [],
				temperature: 0,
				maxTokens: 768,
				context: {
					runId: this.options.runId,
					sessionId: this.options.sessionId ?? null,
					turnId,
					step: lastStep,
					purpose: "summary",
				},
			});
			turnCheckpoint =
				response.assistantText?.trim() ||
				turnCheckpoint ||
				`## Current Goal\n${currentGoal}`;

			workingMessages.length = 0;
			workingMessages.push(
				...this.context.buildMessages(this.systemPrompt),
				createUserMessage(userInput),
				createSystemMessage(`${TURN_CHECKPOINT_PREFIX}\n${turnCheckpoint}`),
				...keptTurnMessages,
			);
			lastCheckpointedTurnMessageCount = turnMessages.length;
			summaryCount += 1;

			logger?.info("turn_working_context_compacted", {
				runId: this.options.runId,
				sessionId: this.options.sessionId ?? null,
				turnId,
				step: lastStep,
				estimatedTokens,
				remainingMessages: workingMessages.length,
			});
			reportProgress({
				type: "context_checkpoint",
				step: lastStep,
				turnId,
				message: `checkpoint compacted current turn; goal: ${formatGoalForLog(currentGoal)}`,
				detail: `estimated context before checkpoint: ${estimatedTokens} tokens; kept recent messages: ${keptTurnMessages.length}`,
				summaryCount,
			});
		};

		const finishInterruptedTurn = (stage: "model" | "tool"): RunTurnResult => {
			const contextUpdated = checkpointTurnMessages();
			logger?.info("turn_interrupted", {
				runId: this.options.runId,
				sessionId: this.options.sessionId ?? null,
				turnId,
				step: lastStep || null,
				stage,
				source: "user_escape",
				toolExecutionCount: toolExecutions.length,
				summaryCount,
				trimCount,
				modelElapsedMs: lastModelElapsedMs,
				turnElapsedMs: Date.now() - turnStartedAt,
			});
			reportProgress({
				type: "turn_interrupted",
				step: lastStep || undefined,
				turnId,
				elapsedMs: Date.now() - turnStartedAt,
				message: "Turn interrupted",
				toolExecutionCount: toolExecutions.length,
				modelElapsedMs: lastModelElapsedMs,
				summaryCount,
				trimCount,
				interruptStage: stage,
				interruptSource: "user_escape",
			});

			return {
				completionStatus: "interrupted",
				outputText: null,
				steps: lastStep,
				toolExecutions,
				contextSummary: this.context.getSummary(),
				contextMessageCount: this.context.getRecentMessages().length,
				contextUpdated,
				interruptSource: "user_escape",
				interruptStage: stage,
			};
		};

		logger?.info("turn_started", {
			runId: this.options.runId,
			sessionId: this.options.sessionId ?? null,
			turnId,
			input: userInput,
			existingContextMessages: workingMessages.length - 1,
		});
		reportProgress({
			type: "turn_started",
			turnId,
			message: "Starting agent loop",
			userInput,
		});

		try {
			for (let step = 1; step <= this.options.maxSteps; step += 1) {
				lastStep = step;
				interruptController?.throwIfInterrupted();
				logger?.debug("turn_step_started", {
					runId: this.options.runId,
					sessionId: this.options.sessionId ?? null,
					turnId,
					step,
					messageCount: workingMessages.length,
				});
				reportProgress({
					type: "step_started",
					step,
					turnId,
					message: `Step ${step}/${this.options.maxSteps}`,
				});

				const modelStartedAt = Date.now();
				reportProgress({
					type: "model_request_started",
					step,
					turnId,
					message: "Requesting model",
				});

				interruptController?.enterModel();
				const response = await this.provider
					.generate(
						{
							messages: workingMessages,
							tools: this.tools.getSchemas(),
							temperature: this.options.temperature,
							maxTokens: this.options.maxTokens,
							context: {
								runId: this.options.runId,
								sessionId: this.options.sessionId ?? null,
								turnId,
								step,
								purpose: "turn",
							},
							abortSignal: interruptController?.getAbortSignal(),
						},
						(delta) => {
							if (
								delta.reasoningDelta ||
								delta.contentDelta ||
								delta.toolCallDelta
							) {
								reportProgress({
									type: "model_delta",
									step,
									turnId,
									reasoningDelta: delta.reasoningDelta,
									contentDelta: delta.contentDelta,
									toolCallDelta: delta.toolCallDelta,
								});
							}
						},
					)
					.finally(() => {
						interruptController?.leaveActiveStage();
					});
				lastModelElapsedMs = Date.now() - modelStartedAt;

				reportProgress({
					type: "model_request_finished",
					step,
					turnId,
					elapsedMs: lastModelElapsedMs,
					message:
						response.toolCalls.length > 0
							? "Model returned tool calls"
							: "Model returned final answer",
				});

				const assistantProgressText = summarizeAssistantProgressText(
					response.assistantText,
				);

				if (assistantProgressText && response.toolCalls.length > 0) {
					reportProgress({
						type: "assistant_message",
						step,
						turnId,
						message: "Model note",
						assistantText: assistantProgressText,
					});
				}

				if (response.toolCalls.length > 0) {
					const assistantMessage = createAssistantMessage(
						response.assistantText,
						response.toolCalls,
					);
					workingMessages.push(assistantMessage);
					turnMessages.push(assistantMessage);
					interruptController?.throwIfInterrupted();

					logger?.info("tool_calls_received", {
						runId: this.options.runId,
						sessionId: this.options.sessionId ?? null,
						turnId,
						step,
						toolCallCount: response.toolCalls.length,
					});
					reportProgress({
						type: "tool_calls_received",
						step,
						turnId,
						toolCallCount: response.toolCalls.length,
						message: `Received ${response.toolCalls.length} tool call(s)`,
					});

					for (const toolCall of response.toolCalls) {
						interruptController?.throwIfInterrupted();
						const toolStartedAt = Date.now();
						const toolDescription = this.tools.describeProgress(toolCall);

						const duplicate = findRecentDuplicateToolCall(
							toolCall,
							turnMessages,
						);
						if (duplicate) {
							const dedupResult = buildDuplicateToolCallResult({
								toolName: toolCall.name,
								stepsBack: duplicate.stepsBack,
							});
							toolExecutions.push({ toolCall, result: dedupResult });
							this.context.recordToolExecution(toolCall, dedupResult);

							logger?.info("tool_call_deduplicated", {
								runId: this.options.runId,
								sessionId: this.options.sessionId ?? null,
								turnId,
								step,
								toolName: toolCall.name,
								arguments: JSON.stringify(toolCall.arguments),
								stepsBack: duplicate.stepsBack,
							});
							reportProgress({
								type: "tool_execution_finished",
								step,
								turnId,
								toolName: toolCall.name,
								toolOk: true,
								elapsedMs: 0,
								message: `Deduplicated repeat of ${toolCall.name}`,
								toolResultData: dedupResult.data,
								toolResult: formatToolExecutionResult(
									toolCall.name,
									dedupResult,
								),
							});

							const toolMessage = createToolMessage(
								toolCall.id,
								toolCall.name,
								dedupResult,
							);
							workingMessages.push(toolMessage);
							turnMessages.push(toolMessage);
							continue;
						}
						logger?.info("tool_execution_started", {
							runId: this.options.runId,
							sessionId: this.options.sessionId ?? null,
							turnId,
							step,
							toolName: toolCall.name,
							arguments: JSON.stringify(toolCall.arguments),
						});
						reportProgress({
							type: "tool_execution_started",
							step,
							turnId,
							toolName: toolCall.name,
							toolArguments: toolCall.arguments,
							message: toolDescription.summary,
							detail: toolDescription.detail,
						});
						interruptController?.enterTool();
						const result = await this.tools
							.execute(toolCall, {
								cwd: this.options.workingDirectory,
								logger,
								runId: this.options.runId,
								sessionId: this.options.sessionId ?? null,
								turnId,
								abortSignal: interruptController?.getAbortSignal(),
								allowedReadRoots: this.options.allowedReadRoots,
								bash: this.options.bashToolContext,
							})
							.finally(() => {
								interruptController?.leaveActiveStage();
							});

						toolExecutions.push({ toolCall, result });
						this.context.recordToolExecution(toolCall, result);

						if (!result.ok) {
							logger?.error("tool_execution_failed", {
								runId: this.options.runId,
								sessionId: this.options.sessionId ?? null,
								turnId,
								step,
								toolName: toolCall.name,
								error: result.error ?? null,
								details: result.details
									? JSON.stringify(result.details)
									: undefined,
								elapsedMs: Date.now() - toolStartedAt,
							});
						} else {
							logger?.info("tool_execution_finished", {
								runId: this.options.runId,
								sessionId: this.options.sessionId ?? null,
								turnId,
								step,
								toolName: toolCall.name,
								ok: true,
								elapsedMs: Date.now() - toolStartedAt,
							});
						}
						const renderedToolResult = formatToolExecutionResult(
							toolCall.name,
							result,
						);
						reportProgress({
							type: "tool_execution_finished",
							step,
							turnId,
							toolName: toolCall.name,
							toolOk: result.ok,
							elapsedMs: Date.now() - toolStartedAt,
							message: result.ok
								? `Tool finished: ${toolCall.name}`
								: `Tool failed: ${toolCall.name}`,
							toolResultData: result.data,
							toolResult:
								this.options.processOutputMode === "detailed"
									? truncateProgressToolResult(renderedToolResult)
									: renderedToolResult,
						});

						const toolMessage = createToolMessage(
							toolCall.id,
							toolCall.name,
							result,
						);
						workingMessages.push(toolMessage);
						turnMessages.push(toolMessage);
						interruptController?.throwIfInterrupted();

						if (MUTATING_TOOL_NAMES.has(toolCall.name) && result.ok) {
							needsVerification = true;
						} else if (
							needsVerification &&
							VERIFICATION_TOOL_NAMES.has(toolCall.name)
						) {
							needsVerification = false;
						}
					}

					await maybeCompactWorkingMessages();
					continue;
				}

				interruptController?.throwIfInterrupted();
				const outputText =
					response.assistantText?.trim() || "No response generated.";

				if (
					needsVerification &&
					!verificationReminderSent &&
					this.options.enableVerificationReminder === true
				) {
					verificationReminderSent = true;
					workingMessages.push(createUserMessage(VERIFICATION_REMINDER));
					logger?.info("turn_verification_reminder_added", {
						runId: this.options.runId,
						sessionId: this.options.sessionId ?? null,
						turnId,
						step,
					});
					reportProgress({
						type: "assistant_message",
						step,
						turnId,
						message: "Runner note",
						assistantText: VERIFICATION_REMINDER,
					});
					continue;
				}

				const assistantMessage = createAssistantMessage(outputText);
				turnMessages.push(assistantMessage);

				let contextUpdated: ContextUpdateResult;
				try {
					contextUpdated = await this.context.appendMessages(
						turnMessages,
						this.provider,
						this.systemPrompt,
						this.toolSchemas,
						{ turnId },
						{ usage: response.usage },
					);
				} catch (error) {
					if (error instanceof CompactionFailedError) {
						logger?.warn("turn_compaction_failed", {
							runId: this.options.runId,
							sessionId: this.options.sessionId ?? null,
							turnId,
							reason: error.reason,
							trigger: error.trigger,
							error: error.message,
						});
						contextUpdated = {
							summarized: false,
							trimmed: true,
							summary: this.context.getSummary(),
							recentMessageCount: this.context.getRecentMessages().length,
							previousRecentMessageCount:
								this.context.getRecentMessages().length,
							summaryChars: this.context.getSummary()?.length ?? 0,
							previousSummaryChars: this.context.getSummary()?.length ?? 0,
							tokensBefore: 0,
							tokensAfter: 0,
							trigger: error.trigger,
						};
					} else {
						throw error;
					}
				}
				turnMessagesPersisted = true;
				summaryCount += Number(contextUpdated.summarized);
				trimCount += Number(contextUpdated.trimmed);

				logger?.info("turn_finished", {
					runId: this.options.runId,
					sessionId: this.options.sessionId ?? null,
					turnId,
					steps: step,
					toolExecutionCount: toolExecutions.length,
					summaryCount,
					trimCount,
					modelElapsedMs: lastModelElapsedMs,
					turnElapsedMs: Date.now() - turnStartedAt,
				});
				reportProgress({
					type: "turn_finished",
					step,
					turnId,
					elapsedMs: Date.now() - turnStartedAt,
					message: "Answer ready",
					toolExecutionCount: toolExecutions.length,
					modelElapsedMs: lastModelElapsedMs,
					summaryCount,
					trimCount,
				});

				return {
					completionStatus: "completed",
					outputText,
					steps: step,
					toolExecutions,
					contextSummary: this.context.getSummary(),
					contextMessageCount: this.context.getRecentMessages().length,
					contextUpdated,
					interruptSource: null,
					interruptStage: null,
				};
			}

			let outputText = `I hit the maximum tool-call steps (${this.options.maxSteps}) before reaching a final answer.`;
			let synthesisUsage: ModelUsage | undefined;
			try {
				const modelStartedAt = Date.now();
				reportProgress({
					type: "model_request_started",
					step: this.options.maxSteps,
					turnId,
					message: "Synthesizing final answer",
				});
				const response = await this.provider.generate({
					messages: [
						...workingMessages,
						createSystemMessage(MAX_STEPS_SYNTHESIS_PROMPT),
					],
					tools: [],
					temperature: this.options.temperature,
					maxTokens: this.options.maxTokens,
					context: {
						runId: this.options.runId,
						sessionId: this.options.sessionId ?? null,
						turnId,
						step: this.options.maxSteps,
						purpose: "turn",
					},
				});
				lastModelElapsedMs = Date.now() - modelStartedAt;
				reportProgress({
					type: "model_request_finished",
					step: this.options.maxSteps,
					turnId,
					elapsedMs: lastModelElapsedMs,
					message: "Model returned final answer",
				});
				const synthesizedText = response.assistantText?.trim();
				synthesisUsage = response.usage;
				outputText = isUsableMaxStepsAnswer(synthesizedText)
					? synthesizedText
					: buildMaxStepsFallbackAnswer(currentGoal, toolExecutions);
			} catch (error) {
				logger?.warn("turn_max_steps_synthesis_failed", {
					runId: this.options.runId,
					sessionId: this.options.sessionId ?? null,
					turnId,
					error: error instanceof Error ? error.message : String(error),
				});
				outputText = buildMaxStepsFallbackAnswer(currentGoal, toolExecutions);
			}
			turnMessages.push(createAssistantMessage(outputText));

			let contextUpdated: ContextUpdateResult;
			try {
				contextUpdated = await this.context.appendMessages(
					turnMessages,
					this.provider,
					this.systemPrompt,
					this.toolSchemas,
					{ turnId },
					{ usage: synthesisUsage },
				);
			} catch (error) {
				if (error instanceof CompactionFailedError) {
					logger?.warn("turn_compaction_failed", {
						runId: this.options.runId,
						sessionId: this.options.sessionId ?? null,
						turnId,
						reason: error.reason,
						trigger: error.trigger,
						error: error.message,
					});
					contextUpdated = {
						summarized: false,
						trimmed: true,
						summary: this.context.getSummary(),
						recentMessageCount: this.context.getRecentMessages().length,
						previousRecentMessageCount: this.context.getRecentMessages().length,
						summaryChars: this.context.getSummary()?.length ?? 0,
						previousSummaryChars: this.context.getSummary()?.length ?? 0,
						tokensBefore: 0,
						tokensAfter: 0,
						trigger: error.trigger,
					};
				} else {
					throw error;
				}
			}
			turnMessagesPersisted = true;
			summaryCount += Number(contextUpdated.summarized);
			trimCount += Number(contextUpdated.trimmed);

			logger?.warn("turn_max_steps_reached", {
				runId: this.options.runId,
				sessionId: this.options.sessionId ?? null,
				turnId,
				maxSteps: this.options.maxSteps,
				toolExecutionCount: toolExecutions.length,
				summaryCount,
				trimCount,
				modelElapsedMs: lastModelElapsedMs,
				turnElapsedMs: Date.now() - turnStartedAt,
			});
			reportProgress({
				type: "turn_max_steps_reached",
				step: this.options.maxSteps,
				turnId,
				elapsedMs: Date.now() - turnStartedAt,
				message: "Maximum tool-call steps reached",
				toolExecutionCount: toolExecutions.length,
				modelElapsedMs: lastModelElapsedMs,
				summaryCount,
				trimCount,
			});

			return {
				completionStatus: "completed",
				outputText,
				steps: this.options.maxSteps,
				toolExecutions,
				contextSummary: this.context.getSummary(),
				contextMessageCount: this.context.getRecentMessages().length,
				contextUpdated,
				interruptSource: null,
				interruptStage: null,
			};
		} catch (error) {
			if (
				isTurnInterruptedError(error) ||
				(error instanceof TurnInterruptedError &&
					error.source === "user_escape") ||
				(interruptController?.isInterruptRequested() ?? false)
			) {
				const stage =
					error instanceof TurnInterruptedError
						? error.stage
						: (interruptController?.getInterruptedStage() ??
							interruptController?.getActiveStage() ??
							"tool");
				return finishInterruptedTurn(stage);
			}

			if (!turnMessagesPersisted && turnMessages.length > 0) {
				try {
					checkpointTurnMessages();
				} catch (checkpointError) {
					logger?.error("turn_failed_context_checkpoint_failed", {
						runId: this.options.runId,
						sessionId: this.options.sessionId ?? null,
						turnId,
						error:
							checkpointError instanceof Error
								? checkpointError.message
								: String(checkpointError),
					});
				}
			}

			failureType = error instanceof Error ? error.name : "unknown_error";
			logger?.error("turn_failed", {
				runId: this.options.runId,
				sessionId: this.options.sessionId ?? null,
				turnId,
				toolExecutionCount: toolExecutions.length,
				summaryCount,
				trimCount,
				modelElapsedMs: lastModelElapsedMs,
				turnElapsedMs: Date.now() - turnStartedAt,
				failureType,
				error: error instanceof Error ? error.message : String(error),
			});
			reportProgress({
				type: "turn_failed",
				turnId,
				elapsedMs: Date.now() - turnStartedAt,
				message: "Turn failed",
				toolExecutionCount: toolExecutions.length,
				modelElapsedMs: lastModelElapsedMs,
				summaryCount,
				trimCount,
				failureType,
			});
			throw error;
		}
	}

	async compactContext(options?: {
		instructions?: string;
		abortSignal?: AbortSignal;
	}): Promise<ContextUpdateResult> {
		return this.context.compactNow(
			this.provider,
			this.systemPrompt,
			this.toolSchemas,
			undefined,
			options,
		);
	}
}

function isUsableMaxStepsAnswer(
	text: string | null | undefined,
): text is string {
	if (!text) {
		return false;
	}
	return !["<tool_call>", "<invoke name=", "]<]minimax[>", "</mm:think>"].some(
		(marker) => text.includes(marker),
	);
}

function buildMaxStepsFallbackAnswer(
	currentGoal: string,
	toolExecutions: readonly ExecutedToolCall[],
): string {
	const facts = summarizeToolExecutions(toolExecutions);
	const factLines =
		facts.length > 0
			? facts.slice(0, 20).map((fact) => `- ${fact}`)
			: ["- No tool results were captured."];

	return [
		`I hit the tool-call step limit, but the current user goal is: ${currentGoal}`,
		"",
		"Based on the context already gathered, I should answer this goal rather than keep exploring. Key context obtained:",
		...factLines,
		"",
		"If this task continues, the next step is to synthesize a clear analysis of the project structure, core modules, how to run it, and its risk points; only keep reading files when key information is missing.",
	].join("\n");
}

function summarizeToolExecutions(
	toolExecutions: readonly ExecutedToolCall[],
): string[] {
	const facts: string[] = [];
	const seen = new Set<string>();

	for (const execution of toolExecutions) {
		const pathArg = execution.toolCall.arguments.file_path;
		const commandArg = execution.toolCall.arguments.command;
		const fact =
			typeof pathArg === "string"
				? `Read ${pathArg}`
				: typeof commandArg === "string"
					? `Ran ${commandArg}`
					: `Called ${execution.toolCall.name}`;
		if (!seen.has(fact)) {
			seen.add(fact);
			facts.push(fact);
		}
	}

	return facts;
}

function truncateProgressToolResult(value: string): string {
	if (value.length <= CLEAR_PROGRESS_TOOL_RESULT_MAX_CHARS) {
		return value;
	}

	return `${value.slice(0, CLEAR_PROGRESS_TOOL_RESULT_MAX_CHARS - 32)}\n... [tool result truncated]`;
}

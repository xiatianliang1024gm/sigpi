import { randomUUID } from "node:crypto";
import { estimateContextTokens } from "../context-window.js";
import type { TurnInterruptController } from "../interrupt.js";
import { isTurnInterruptedError, TurnInterruptedError } from "../interrupt.js";
import { ModelRequestError } from "../model/transport.js";
import { summarizeAssistantProgressText } from "../progress.js";
import type { ToolRegistry } from "../tools/registry.js";
import { formatToolExecutionResult } from "../tools/render.js";
import type {
	AgentRunnerOptions,
	ContextUpdateResult,
	ExecutedToolCall,
	Message,
	ModelProvider,
	ModelResponse,
	ModelUsage,
	RunTurnResult,
	RuntimeLogger,
	ToolCall,
	ToolSchema,
	TurnProgressEvent,
} from "../types.js";
import type { ConversationContext } from "./context.js";
import {
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from "./messages.js";

const INTERRUPTED_TOOL_RESULT_ERROR =
	"Tool execution was interrupted by the user before it produced output. Re-run the tool if the task still requires it.";
/**
 * A provider `context_length_exceeded` (400) is retried once after a forced
 * compaction (ADR 0026, D3 — "retries the original request once; a second
 * failure re-throws"). If the compaction cannot shrink the window enough — the
 * live window is bounded by `keepRecentTokens` and the floor, so a pathological
 * config can still overflow the provider's actual limit — the retry fails the
 * turn instead of spinning the compact → 400 loop forever.
 */
const CONTEXT_LENGTH_EXCEEDED_MAX_RETRIES = 1;
const DEFAULT_RUNNER_OPTIONS: AgentRunnerOptions = {
	maxSteps: 40,
	temperature: 0.2,
	workingDirectory: process.cwd(),
};
const CLEAR_PROGRESS_TOOL_RESULT_MAX_CHARS = 4000;

/**
 * Find assistant tool calls in `messages` that have no matching tool result.
 *
 * A turn interrupted during tool execution leaves exactly this shape: the
 * assistant message carrying the tool calls is appended to the transcript
 * first, and the tool result message is only appended after the tool returns.
 * When the tool is aborted mid-execution, the result never lands, so the
 * persisted transcript would contain a tool call without an output — which
 * providers reject on the next request (400 "No tool output found for tool
 * call ...").
 */
function collectUnansweredToolCalls(messages: readonly Message[]): ToolCall[] {
	const answeredCallIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "tool" && message.toolCallId) {
			answeredCallIds.add(message.toolCallId);
		}
	}

	const unanswered: ToolCall[] = [];
	for (const message of messages) {
		if (message.role === "assistant" && message.toolCalls) {
			for (const toolCall of message.toolCalls) {
				if (!answeredCallIds.has(toolCall.id)) {
					unanswered.push(toolCall);
				}
			}
		}
	}
	return unanswered;
}

function isContextLengthExceededError(error: unknown): boolean {
	return (
		error instanceof ModelRequestError &&
		error.kind === "context_length_exceeded"
	);
}

export class AgentRunner {
	private provider: ModelProvider;
	private readonly tools: ToolRegistry;
	private readonly toolSchemas: ToolSchema[];
	private readonly context: ConversationContext;
	private readonly systemPrompt: string;
	private readonly options: AgentRunnerOptions;
	private persistContext: (() => Promise<void>) | undefined;

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

	/**
	 * Register a callback invoked after the context is persisted to the
	 * session store (per-message, as soon as a batch lands — not just at turn
	 * boundaries). Wired by `SessionRuntime`; a no-op when absent (e.g.
	 * standalone runner tests).
	 */
	setPersistContext(persistContext: () => Promise<void>): void {
		this.persistContext = persistContext;
	}

	async runTurn(
		userInput: string,
		interruptController?: TurnInterruptController,
	): Promise<RunTurnResult> {
		const toolExecutions: ExecutedToolCall[] = [];
		const logger = this.options.logger;
		const progress = this.options.progressReporter;
		const turnStartedAt = Date.now();
		const turnId = randomUUID();
		let summaryCount = 0;
		let lastModelElapsedMs = 0;
		let failureType: string | undefined;
		let lastStep = 0;
		/**
		 * Messages produced this turn but not yet handed to the session store.
		 * Persisted at the next terminal point (final answer, interrupt,
		 * failure, max-steps) — including the user's input, which is persisted
		 * up-front so an interrupt never loses it. The request payload is
		 * rebuilt from the persisted context + this buffer before every
		 * `generate` (ADR 0026, D1), so there is no separate in-memory
		 * working copy to keep in sync.
		 */
		const pending: Message[] = [];
		/**
		 * Provider-reported usage of the most recent model response in this
		 * turn, attached to the tail assistant message when the buffer is
		 * persisted (D7 — the compaction entry and the session stream carry
		 * usage so resumed sessions keep the ground-truth token baseline).
		 */
		let lastResponseUsage: ModelUsage | undefined;
		/**
		 * Provider-reported usage summed across every model request in this
		 * turn. Mutable fields on a `const` object: a `let` union assigned
		 * only inside a closure would be narrowed to `never` at the terminal
		 * read sites. The `turnUsageReported` flag tracks whether any request
		 * reported usage, so callers can distinguish "0 tokens" from "usage
		 * unknown".
		 */
		const turnUsage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
		};
		let turnUsageReported = false;
		const accumulateUsage = (usage?: ModelUsage): void => {
			if (!usage) {
				return;
			}
			turnUsageReported = true;
			turnUsage.input += usage.input;
			turnUsage.output += usage.output;
			turnUsage.cacheRead += usage.cacheRead;
			turnUsage.cacheWrite += usage.cacheWrite;
			turnUsage.totalTokens += usage.totalTokens;
		};

		interruptController?.beginTurn();

		const createContextUpdateSnapshot = (): ContextUpdateResult => {
			const recentMessages = this.context.getRecentMessages();
			return {
				summarized: false,
				summary: this.context.getSummary(),
				recentMessageCount: recentMessages.length,
				previousRecentMessageCount: recentMessages.length,
				summaryChars: this.context.getSummary()?.length ?? 0,
				previousSummaryChars: this.context.getSummary()?.length ?? 0,
				tokensBefore: 0,
				tokensAfter: 0,
				trigger: null,
			};
		};

		const estimateRequestTokens = (): number => {
			const lastUsage = this.context.getLastUsage();
			return estimateContextTokens({
				systemPrompt: this.systemPrompt,
				summary: this.context.getSummary(),
				recentMessages: [
					...this.context.getRecentMessages(),
					...pending,
				].filter((message) => message.role !== "system"),
				toolSchemas: this.toolSchemas,
				lastUsage: lastUsage?.usage ?? null,
				lastUsageMessageIndex: lastUsage?.messageIndex ?? null,
			}).totalTokens;
		};

		const reportProgress = (event: TurnProgressEvent): void => {
			progress?.({
				...event,
				estimatedContextTokens: estimateRequestTokens(),
			});
		};

		/**
		 * Flush `pending` into the session store. Closes any dangling tool
		 * calls first (a turn interrupted mid-tool leaves an assistant
		 * tool-call message with no result; persisting that shape makes the
		 * next request fail with a provider 400). The request-side snapshot
		 * (`estimateRequestTokens`) excludes the flushed batch afterwards,
		 * since it now lives in the persisted context.
		 */
		const persistPendingMessages =
			async (): Promise<ContextUpdateResult | null> => {
				if (pending.length === 0) {
					return null;
				}
				for (const toolCall of collectUnansweredToolCalls(pending)) {
					logger?.info("turn_interrupted_tool_result_closed", {
						runId: this.options.runId,
						sessionId: this.options.sessionId ?? null,
						turnId,
						toolName: toolCall.name,
						toolCallId: toolCall.id,
					});
					pending.push(
						createToolMessage(toolCall.id, toolCall.name, {
							ok: false,
							error: INTERRUPTED_TOOL_RESULT_ERROR,
						}),
					);
				}
				const contextUpdated = await this.context.appendMessages(
					pending,
					this.provider,
					this.systemPrompt,
					this.toolSchemas,
					{ turnId },
					{ usage: lastResponseUsage },
				);
				pending.length = 0;
				lastResponseUsage = undefined;
				await this.persistContext?.();
				return contextUpdated;
			};

		logger?.info("turn_started", {
			runId: this.options.runId,
			sessionId: this.options.sessionId ?? null,
			turnId,
			input: userInput,
			existingContextMessages: this.context.getRecentMessages().length,
		});
		reportProgress({
			type: "turn_started",
			turnId,
			message: "Starting agent loop",
			userInput,
		});

		// Persist the user's input as the first message of the turn, before any
		// model or tool work — an interrupt at any point still leaves a valid,
		// resumable transcript.
		await persistPendingMessagesAndStart(userInput);

		try {
			for (let step = 1; step <= this.options.maxSteps; step += 1) {
				lastStep = step;
				interruptController?.throwIfInterrupted();
				logger?.debug("turn_step_started", {
					runId: this.options.runId,
					sessionId: this.options.sessionId ?? null,
					turnId,
					step,
					messageCount:
						this.context.getRecentMessages().length + pending.length,
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

				// One request per step. The payload is rebuilt from the
				// persisted context + `pending` before every generate, so a
				// mid-turn compaction (pre-request estimate or a provider
				// `context_length_exceeded` retry) is automatically reflected
				// in the next attempt (ADR 0026, D1).
				let response: ModelResponse;
				let contextLengthRetries = 0;
				let emptyResponseRetried = false;
				for (let attempt = 0; ; attempt += 1) {
					interruptController?.throwIfInterrupted();
					// Auto trigger (ADR 0026, D1): once per step, before the
					// request, the full request-shape estimate (persisted
					// context + buffered turn messages + system + tools) over
					// the soft limit compacts. The actual split decision stays
					// in `decide`; if the overshoot lives only in the buffered
					// turn messages (which compaction never touches), `compact`
					// reports `summarized: false` and the request proceeds.
					if (attempt === 0) {
						const budget = this.context.getContextBudget();
						const softLimit = Math.max(
							0,
							budget.hardContextLimit - budget.reserveTokens,
						);
						if (estimateRequestTokens() > softLimit) {
							const compacted = await this.context.compact(
								this.provider,
								this.systemPrompt,
								this.toolSchemas,
								{ turnId },
								{
									force: false,
									abortSignal: interruptController?.getAbortSignal(),
								},
							);
							summaryCount += Number(compacted.summarized);
							if (compacted.summarized) {
								logger?.info("turn_context_compacted", {
									runId: this.options.runId,
									sessionId: this.options.sessionId ?? null,
									turnId,
									step,
									trigger: "token",
									summaryCount,
								});
								reportProgress({
									type: "context_compacted",
									step,
									turnId,
									message: "Context compacted before request",
									tokensBefore: compacted.tokensBefore,
									tokensAfter: compacted.tokensAfter,
									trigger: "token",
									summaryCount,
								});
							}
						}
					}
					const messages = this.buildRequestMessages(pending);
					try {
						response = await this.provider
							.generate(
								{
									messages,
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
					} catch (error) {
						// D3 — provider "you are over the context window":
						// force-compact the persisted context and retry the
						// same step. Other failures propagate unchanged.
						if (!isContextLengthExceededError(error)) {
							throw error;
						}
						if (contextLengthRetries >= CONTEXT_LENGTH_EXCEEDED_MAX_RETRIES) {
							throw error;
						}
						contextLengthRetries += 1;
						logger?.warn("turn_context_length_exceeded_retry", {
							runId: this.options.runId,
							sessionId: this.options.sessionId ?? null,
							turnId,
							step,
							attempt: contextLengthRetries,
							maxRetries: CONTEXT_LENGTH_EXCEEDED_MAX_RETRIES,
							error: error instanceof Error ? error.message : String(error),
						});
						const compacted = await this.context.compact(
							this.provider,
							this.systemPrompt,
							this.toolSchemas,
							{ turnId },
							{
								force: true,
								abortSignal: interruptController?.getAbortSignal(),
							},
						);
						summaryCount += Number(compacted.summarized);
						if (compacted.summarized) {
							reportProgress({
								type: "context_compacted",
								step,
								turnId,
								message:
									"Context compacted after hitting the context window limit",
								tokensBefore: compacted.tokensBefore,
								tokensAfter: compacted.tokensAfter,
								trigger: "force",
								summaryCount,
							});
						}
						// The context was compacted — retry the request with the
						// rebuilt payload.
						continue;
					}
					// A response with no text and no tool calls is degenerate:
					// it is never persisted (ADR 0026, D5) and no "please
					// continue" note is injected into the request. Instead the
					// identical request is retried once (logged); a second
					// empty response falls through and ends the turn with the
					// user-facing "No response generated." fallback.
					if (
						!response.assistantText?.trim() &&
						response.toolCalls.length === 0 &&
						!emptyResponseRetried
					) {
						emptyResponseRetried = true;
						logger?.warn("turn_empty_response_retry", {
							runId: this.options.runId,
							sessionId: this.options.sessionId ?? null,
							turnId,
							step,
							retry: 1,
							maxRetries: 1,
						});
						reportProgress({
							type: "context_checkpoint",
							step,
							turnId,
							message: "Model returned an empty response; retrying once",
						});
						continue;
					}
					break;
				}
				lastModelElapsedMs = Date.now() - modelStartedAt;
				lastResponseUsage = response.usage;
				accumulateUsage(response.usage);

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
						{ reasoning: response.reasoning ?? undefined },
					);
					pending.push(assistantMessage);
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
							toolCallId: toolCall.id,
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
								bash: this.options.bashToolContext,
							})
							.finally(() => {
								interruptController?.leaveActiveStage();
							});

						toolExecutions.push({ toolCall, result });

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
							toolCallId: toolCall.id,
							toolOk: result.ok,
							elapsedMs: Date.now() - toolStartedAt,
							message: result.ok
								? `Tool finished: ${toolCall.name}`
								: `Tool failed: ${toolCall.name}`,
							toolResultData: result.data,
							toolResult: truncateProgressToolResult(renderedToolResult),
						});

						pending.push(createToolMessage(toolCall.id, toolCall.name, result));
						interruptController?.throwIfInterrupted();
					}

					continue;
				}

				interruptController?.throwIfInterrupted();
				const assistantText = response.assistantText?.trim() ?? "";
				// An empty response already got its one retry inside the
				// request loop (logged, identical payload). If it is still
				// empty, surface the user-facing fallback and end the turn —
				// the degenerate response itself was never persisted.
				const outputText = assistantText || "No response generated.";

				const contextUpdated = await persistPendingMessagesAndAnswer(
					createAssistantMessage(outputText, undefined, {
						reasoning: response.reasoning ?? undefined,
					}),
				);

				logger?.info("turn_finished", {
					runId: this.options.runId,
					sessionId: this.options.sessionId ?? null,
					turnId,
					steps: step,
					toolExecutionCount: toolExecutions.length,
					summaryCount,
					modelElapsedMs: lastModelElapsedMs,
					turnElapsedMs: Date.now() - turnStartedAt,
					inputTokens: turnUsageReported ? turnUsage.input : 0,
					outputTokens: turnUsageReported ? turnUsage.output : 0,
					cacheReadTokens: turnUsageReported ? turnUsage.cacheRead : 0,
					cacheWriteTokens: turnUsageReported ? turnUsage.cacheWrite : 0,
					turnTotalTokens: turnUsageReported ? turnUsage.totalTokens : 0,
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
					turnTokens: turnUsageReported ? turnUsage : undefined,
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

			const outputText = buildMaxStepsFallbackAnswer(
				toolExecutions,
				this.options.maxSteps,
			);
			// No reasoning to attach: this branch fires only when the loop
			// exhausted `maxSteps` and the last `response` from the inner loop
			// is out of scope. The fallback answer is synthesized locally and
			// has no associated chain-of-thought.
			const contextUpdated = await persistPendingMessagesAndAnswer(
				createAssistantMessage(outputText),
			);

			logger?.warn("turn_max_steps_reached", {
				runId: this.options.runId,
				sessionId: this.options.sessionId ?? null,
				turnId,
				maxSteps: this.options.maxSteps,
				toolExecutionCount: toolExecutions.length,
				summaryCount,
				modelElapsedMs: lastModelElapsedMs,
				turnElapsedMs: Date.now() - turnStartedAt,
				inputTokens: turnUsageReported ? turnUsage.input : 0,
				outputTokens: turnUsageReported ? turnUsage.output : 0,
				cacheReadTokens: turnUsageReported ? turnUsage.cacheRead : 0,
				cacheWriteTokens: turnUsageReported ? turnUsage.cacheWrite : 0,
				turnTotalTokens: turnUsageReported ? turnUsage.totalTokens : 0,
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
				turnTokens: turnUsageReported ? turnUsage : undefined,
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
				(interruptController?.isInterruptRequested() ?? false)
			) {
				const stage =
					error instanceof TurnInterruptedError
						? error.stage
						: (interruptController?.getInterruptedStage() ??
							interruptController?.getActiveStage() ??
							"tool");
				return this.finishInterruptedTurn({
					stage,
					turnId,
					toolExecutions,
					lastStep,
					summaryCount,
					lastModelElapsedMs,
					turnStartedAt,
					turnUsage,
					turnUsageReported,
					persistPendingMessages,
					reportProgress,
					logger,
					createContextUpdateSnapshot,
				});
			}

			if (pending.length > 0) {
				try {
					await persistPendingMessages();
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
				modelElapsedMs: lastModelElapsedMs,
				turnElapsedMs: Date.now() - turnStartedAt,
				failureType,
				error: error instanceof Error ? error.message : String(error),
				inputTokens: turnUsageReported ? turnUsage.input : 0,
				outputTokens: turnUsageReported ? turnUsage.output : 0,
				cacheReadTokens: turnUsageReported ? turnUsage.cacheRead : 0,
				cacheWriteTokens: turnUsageReported ? turnUsage.cacheWrite : 0,
				turnTotalTokens: turnUsageReported ? turnUsage.totalTokens : 0,
			});
			reportProgress({
				type: "turn_failed",
				turnId,
				elapsedMs: Date.now() - turnStartedAt,
				message: "Turn failed",
				toolExecutionCount: toolExecutions.length,
				modelElapsedMs: lastModelElapsedMs,
				summaryCount,
				failureType,
				turnTokens: turnUsageReported ? turnUsage : undefined,
			});
			throw error;
		}

		// Local helper: persist the initial user input before the loop.
		async function persistPendingMessagesAndStart(
			input: string,
		): Promise<void> {
			pending.push(createUserMessage(input));
			await persistPendingMessages();
		}

		// Local helper: flush the final assistant answer (plus any buffered
		// turn messages) into the session store.
		async function persistPendingMessagesAndAnswer(
			assistantMessage: Message,
		): Promise<ContextUpdateResult> {
			pending.push(assistantMessage);
			const result = await persistPendingMessages();
			return result ?? createContextUpdateSnapshot();
		}
	}

	private buildRequestMessages(pending: Message[]): Message[] {
		const messages = this.context.buildMessages(this.systemPrompt);
		messages.push(...pending);
		return messages;
	}

	private async finishInterruptedTurn(args: {
		stage: "model" | "tool";
		turnId: string;
		toolExecutions: ExecutedToolCall[];
		lastStep: number;
		summaryCount: number;
		lastModelElapsedMs: number;
		turnStartedAt: number;
		turnUsage: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
		};
		turnUsageReported: boolean;
		persistPendingMessages: () => Promise<ContextUpdateResult | null>;
		reportProgress: (event: TurnProgressEvent) => void;
		logger: RuntimeLogger | undefined;
		createContextUpdateSnapshot: () => ContextUpdateResult;
	}): Promise<RunTurnResult> {
		const contextUpdated =
			(await args.persistPendingMessages()) ??
			args.createContextUpdateSnapshot();
		args.logger?.info("turn_interrupted", {
			runId: this.options.runId,
			sessionId: this.options.sessionId ?? null,
			turnId: args.turnId,
			step: args.lastStep || null,
			stage: args.stage,
			source: "user_escape",
			toolExecutionCount: args.toolExecutions.length,
			summaryCount: args.summaryCount,
			modelElapsedMs: args.lastModelElapsedMs,
			turnElapsedMs: Date.now() - args.turnStartedAt,
			inputTokens: args.turnUsageReported ? args.turnUsage.input : 0,
			outputTokens: args.turnUsageReported ? args.turnUsage.output : 0,
			cacheReadTokens: args.turnUsageReported ? args.turnUsage.cacheRead : 0,
			cacheWriteTokens: args.turnUsageReported ? args.turnUsage.cacheWrite : 0,
			turnTotalTokens: args.turnUsageReported ? args.turnUsage.totalTokens : 0,
		});
		args.reportProgress({
			type: "turn_interrupted",
			step: args.lastStep || undefined,
			turnId: args.turnId,
			elapsedMs: Date.now() - args.turnStartedAt,
			message: "Turn interrupted",
			toolExecutionCount: args.toolExecutions.length,
			modelElapsedMs: args.lastModelElapsedMs,
			summaryCount: args.summaryCount,
			interruptStage: args.stage,
			interruptSource: "user_escape",
			turnTokens: args.turnUsageReported ? args.turnUsage : undefined,
		});

		return {
			completionStatus: "interrupted",
			outputText: null,
			steps: args.lastStep,
			toolExecutions: args.toolExecutions,
			contextSummary: this.context.getSummary(),
			contextMessageCount: this.context.getRecentMessages().length,
			contextUpdated,
			interruptSource: "user_escape",
			interruptStage: args.stage,
		};
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

function buildMaxStepsFallbackAnswer(
	toolExecutions: readonly ExecutedToolCall[],
	maxSteps: number,
): string {
	const facts = summarizeToolExecutions(toolExecutions).slice(0, 20);
	const factLines =
		facts.length > 0
			? facts.map((fact) => `- ${fact}`)
			: ["- No tool results were captured."];

	const lines: string[] = [
		`I reached the maximum tool-call steps (${maxSteps}) before the task was complete, so the work is not finished. Type 'go on' to continue from where this left off.`,
		...factLines,
	];

	return lines.join("\n");
}

export function summarizeToolExecutions(
	toolExecutions: readonly ExecutedToolCall[],
): string[] {
	// Only file read/modify operations belong in the turn summary. Classify by
	// tool name (not argument shape) so bash/grep/glob/update-plan are excluded
	// and edit/write are labeled as modifications, not reads.
	const FILE_OP_TOOLS = new Set(["read", "edit", "write"]);

	// Accumulate one status per path; "modified" wins over "read" so a file that
	// was both read and changed is recorded once as Modified.
	const statusByPath = new Map<string, "read" | "modified">();
	for (const execution of toolExecutions) {
		if (!FILE_OP_TOOLS.has(execution.toolCall.name)) {
			continue;
		}
		const pathArg = execution.toolCall.arguments.file_path;
		if (typeof pathArg !== "string") {
			continue;
		}
		const status = execution.toolCall.name === "read" ? "read" : "modified";
		if (statusByPath.get(pathArg) !== "modified") {
			statusByPath.set(pathArg, status);
		}
	}

	const facts: string[] = [];
	for (const [path, status] of statusByPath) {
		facts.push(status === "modified" ? `Modified ${path}` : `Read ${path}`);
	}

	return facts.slice(0, 20);
}

function truncateProgressToolResult(value: string): string {
	if (value.length <= CLEAR_PROGRESS_TOOL_RESULT_MAX_CHARS) {
		return value;
	}

	return `${value.slice(0, CLEAR_PROGRESS_TOOL_RESULT_MAX_CHARS - 32)}\n... [tool result truncated]`;
}

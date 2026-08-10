import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
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
	InterruptStage,
	Message,
	ModelProvider,
	ModelResponse,
	ModelUsage,
	RunTurnResult,
	ToolCall,
	ToolSchema,
	TurnProgressEvent,
	TurnProgressEventMap,
	TurnProgressPayload,
} from "../types.js";
import { TURN_PROGRESS_EVENTS } from "../types.js";
import type { ConversationContext } from "./context.js";
import {
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from "./messages.js";

const INTERRUPTED_TOOL_RESULT_ERROR =
	"Tool execution was interrupted by the user before it produced output. Re-run the tool if the task still requires it.";
/**
 * A step's model request is retried at most once, whatever the failure mode
 * (ADR 0026: D3 — a provider `context_length_exceeded` is retried once after a
 * forced compaction; D5 — a degenerate empty response is retried once). The
 * budget is shared, so a retry that fails again — compaction could not shrink
 * the window enough, or the model returned empty twice in a row — ends the
 * turn instead of looping the compact → 400 cycle.
 */
const GENERATE_MAX_RETRIES = 1;
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

/**
 * Mutable per-turn state plus the operations that read or mutate it. Bundling
 * both lets the runner's step logic live in small flat methods instead of one
 * deeply nested `runTurn`; every operation here is invoked at most once per
 * turn or per step, so there is no shared-state hazard between turns.
 */
class TurnState {
	readonly turnId: string;
	readonly startedAtMs: number;

	/**
	 * Messages produced this turn but not yet handed to the session store.
	 * Persisted at the next terminal point (final answer, interrupt,
	 * failure, max-steps) — including the user's input, which is persisted
	 * up-front so an interrupt never loses it. The request payload is
	 * rebuilt from the persisted context + this buffer before every
	 * `generate` (ADR 0026, D1), so there is no separate in-memory
	 * working copy to keep in sync.
	 */
	readonly pending: Message[] = [];
	readonly toolExecutions: ExecutedToolCall[] = [];
	/**
	 * Provider-reported usage summed across every model request in this
	 * turn. Mutable fields on a `const` object: a `let` union assigned
	 * only inside a closure would be narrowed to `never` at the terminal
	 * read sites. The `turnUsageReported` flag tracks whether any request
	 * reported usage, so callers can distinguish "0 tokens" from "usage
	 * unknown".
	 */
	readonly turnUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
	};
	turnUsageReported = false;
	/**
	 * Provider-reported usage of the most recent model response in this
	 * turn, attached to the tail assistant message when the buffer is
	 * persisted (D7 — the compaction entry and the session stream carry
	 * usage so resumed sessions keep the ground-truth token baseline).
	 */
	lastResponseUsage: ModelUsage | undefined;
	lastStep = 0;

	private readonly context: ConversationContext;
	private readonly getProvider: () => ModelProvider;
	private readonly systemPrompt: string;
	private readonly toolSchemas: ToolSchema[];
	private readonly getPersistContext: () => (() => Promise<void>) | undefined;
	private readonly runner: AgentRunner;

	constructor(args: {
		turnId: string;
		context: ConversationContext;
		getProvider: () => ModelProvider;
		systemPrompt: string;
		toolSchemas: ToolSchema[];
		getPersistContext: () => (() => Promise<void>) | undefined;
		runner: AgentRunner;
	}) {
		this.turnId = args.turnId;
		this.startedAtMs = Date.now();
		this.context = args.context;
		this.getProvider = args.getProvider;
		this.systemPrompt = args.systemPrompt;
		this.toolSchemas = args.toolSchemas;
		this.getPersistContext = args.getPersistContext;
		this.runner = args.runner;
	}

	accumulateUsage(usage?: ModelUsage): void {
		if (!usage) {
			return;
		}
		this.turnUsageReported = true;
		this.turnUsage.input += usage.input;
		this.turnUsage.output += usage.output;
		this.turnUsage.cacheRead += usage.cacheRead;
		this.turnUsage.cacheWrite += usage.cacheWrite;
		this.turnUsage.totalTokens += usage.totalTokens;
	}

	estimateRequestTokens(): number {
		const lastUsage = this.context.getLastUsage();
		return estimateContextTokens({
			systemPrompt: this.systemPrompt,
			summary: this.context.getSummary(),
			recentMessages: [
				...this.context.getRecentMessages(),
				...this.pending,
			].filter((message) => message.role !== "system"),
			toolSchemas: this.toolSchemas,
			lastUsage: lastUsage?.usage ?? null,
			lastUsageMessageIndex: lastUsage?.messageIndex ?? null,
		}).totalTokens;
	}

	/**
	 * Emit one turn-progress event, enriched with the live in-flight
	 * request-token estimate so the status bar can show a fresh figure.
	 */
	emitProgress<K extends keyof TurnProgressEventMap>(
		type: K,
		payload: TurnProgressEventMap[K],
	): void {
		this.runner.emitProgress(type, {
			...payload,
			estimatedContextTokens: this.estimateRequestTokens(),
		});
	}

	contextUpdateSnapshot(): ContextUpdateResult {
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
	}

	/**
	 * Flush `pending` into the session store. Closes any dangling tool
	 * calls first (a turn interrupted mid-tool leaves an assistant
	 * tool-call message with no result; persisting that shape makes the
	 * next request fail with a provider 400). The request-side snapshot
	 * (`estimateRequestTokens`) excludes the flushed batch afterwards,
	 * since it now lives in the persisted context.
	 */
	async persistPendingMessages(): Promise<ContextUpdateResult | null> {
		if (this.pending.length === 0) {
			return null;
		}
		for (const toolCall of collectUnansweredToolCalls(this.pending)) {
			this.pending.push(
				createToolMessage(toolCall.id, toolCall.name, {
					ok: false,
					error: INTERRUPTED_TOOL_RESULT_ERROR,
				}),
			);
		}
		const contextUpdated = await this.context.appendMessages(
			this.pending,
			this.getProvider(),
			this.systemPrompt,
			this.toolSchemas,
			{ turnId: this.turnId },
			{ usage: this.lastResponseUsage },
		);
		this.pending.length = 0;
		this.lastResponseUsage = undefined;
		await this.getPersistContext()?.();
		return contextUpdated;
	}

	/** Persist the user's input as the first message of the turn. */
	async persistUserInput(input: string): Promise<void> {
		this.pending.push(createUserMessage(input));
		await this.persistPendingMessages();
	}

	/** Flush the final assistant answer (plus any buffered turn messages). */
	async persistAnswer(assistantMessage: Message): Promise<ContextUpdateResult> {
		this.pending.push(assistantMessage);
		return (
			(await this.persistPendingMessages()) ?? this.contextUpdateSnapshot()
		);
	}
}

type StepOutcome = { done: true; result: RunTurnResult } | { done: false };

/**
 * Drives one agent turn. Progress is reported by emitting per-phase
 * turn-progress events (see {@link TurnProgressEventMap}); consumers — the
 * REPL view, the runtime log — subscribe with {@link AgentRunner.onProgress}
 * instead of the runner knowing anything about them.
 */
export class AgentRunner extends EventEmitter {
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
		super();
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

	/**
	 * Emit one turn-progress event to subscribed listeners. The runner emits
	 * per-phase events internally; the REPL also emits a synthetic
	 * `interrupt_requested` here when the user presses Esc mid-turn.
	 */
	emitProgress<K extends keyof TurnProgressEventMap>(
		type: K,
		payload: TurnProgressEventMap[K] & { estimatedContextTokens?: number },
	): void {
		super.emit(type, payload);
	}

	/**
	 * Subscribe to every turn-progress event. Each event is delivered with
	 * its name tagged on (`{ type, ...payload }`), so a single listener can
	 * switch on the phase. Returns an unsubscribe function.
	 */
	onProgress(listener: (event: TurnProgressEvent) => void): () => void {
		const subscriptions = TURN_PROGRESS_EVENTS.map((type) => {
			const handler = (payload: TurnProgressPayload): void => {
				listener({ type, ...payload } as TurnProgressEvent);
			};
			super.on(type, handler);
			return () => {
				super.off(type, handler);
			};
		});
		return () => {
			for (const unsubscribe of subscriptions) {
				unsubscribe();
			}
		};
	}

	async runTurn(
		userInput: string,
		interruptController?: TurnInterruptController,
	): Promise<RunTurnResult> {
		const turn = new TurnState({
			turnId: randomUUID(),
			context: this.context,
			getProvider: () => this.provider,
			systemPrompt: this.systemPrompt,
			toolSchemas: this.toolSchemas,
			getPersistContext: () => this.persistContext,
			runner: this,
		});

		interruptController?.beginTurn();

		turn.emitProgress("turn_started", {
			turnId: turn.turnId,
			userInput,
		});

		// Persist the user's input as the first message of the turn, before any
		// model or tool work — an interrupt at any point still leaves a valid,
		// resumable transcript.
		await turn.persistUserInput(userInput);

		try {
			for (let step = 1; step <= this.options.maxSteps; step += 1) {
				const outcome = await this.runStep(turn, step, interruptController);
				if (outcome.done) {
					return outcome.result;
				}
			}
			return await this.finishMaxStepsTurn(turn);
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
				return this.finishInterruptedTurn(turn, stage);
			}

			if (turn.pending.length > 0) {
				try {
					await turn.persistPendingMessages();
				} catch {
					// A checkpoint failure on the failure path must not mask the
					// original error; the turn_failed event below still fires.
				}
			}

			turn.emitProgress("turn_failed", {
				step: turn.lastStep,
				elapsedMs: Date.now() - turn.startedAtMs,
				failureType: error instanceof Error ? error.name : "unknown_error",
				message: error instanceof Error ? error.message : String(error),
				usage: turn.turnUsageReported ? turn.turnUsage : null,
			});
			throw error;
		}
	}

	/**
	 * One agent-loop step: request the model, then either finish the turn with
	 * the final answer (early return) or execute the requested tool calls and
	 * let the loop continue.
	 */
	private async runStep(
		turn: TurnState,
		step: number,
		interruptController?: TurnInterruptController,
	): Promise<StepOutcome> {
		turn.lastStep = step;
		interruptController?.throwIfInterrupted();
		turn.emitProgress("step_started", { step });

		const response = await this.generateResponse(
			turn,
			step,
			interruptController,
		);

		if (response.toolCalls.length === 0) {
			return {
				done: true,
				result: await this.finishAnswerTurn(
					turn,
					step,
					response,
					interruptController,
				),
			};
		}

		await this.executeToolCalls(turn, response, step, interruptController);
		return { done: false };
	}

	/**
	 * Auto trigger (ADR 0026, D1): once per step, before the first request,
	 * the full request-shape estimate (persisted context + buffered turn
	 * messages + system + tools) over the soft limit compacts. The actual
	 * split decision stays in `decide`; if the overshoot lives only in the
	 * buffered turn messages (which compaction never touches), `compact`
	 * reports `summarized: false` and the request proceeds.
	 */
	private async maybeAutoCompactBeforeRequest(
		turn: TurnState,
		step: number,
		interruptController?: TurnInterruptController,
	): Promise<void> {
		const budget = this.context.getContextBudget();
		const softLimit = Math.max(
			0,
			budget.hardContextLimit - budget.reserveTokens,
		);
		if (turn.estimateRequestTokens() <= softLimit) {
			return;
		}
		const compacted = await this.context.compact(
			this.provider,
			this.systemPrompt,
			this.toolSchemas,
			{ turnId: turn.turnId },
			{
				force: false,
				abortSignal: interruptController?.getAbortSignal(),
			},
		);
		if (compacted.summarized) {
			turn.emitProgress("context_compacted", {
				step,
				tokensBefore: compacted.tokensBefore,
				tokensAfter: compacted.tokensAfter,
				trigger: "token",
			});
		}
	}

	/**
	 * One model request per step, with the retry policy folded in:
	 * auto-compaction before the first attempt (ADR 0026, D1) and a single
	 * shared retry for both failure modes — `context_length_exceeded`
	 * (force-compact + retry, D3) and an empty response (retry, D5). Records
	 * usage + progress once a response lands.
	 */
	private async generateResponse(
		turn: TurnState,
		step: number,
		interruptController?: TurnInterruptController,
	): Promise<ModelResponse> {
		turn.emitProgress("model_request_started", { step });
		interruptController?.enterModel();

		// Auto trigger (ADR 0026, D1): once per step, before the first
		// request (see `maybeAutoCompactBeforeRequest`).
		interruptController?.throwIfInterrupted();
		await this.maybeAutoCompactBeforeRequest(turn, step, interruptController);

		// One request, one retry — whatever the failure mode (D3 / D5); see
		// GENERATE_MAX_RETRIES. A retry that fails again ends the turn.
		let retries = 0;
		while (true) {
			interruptController?.throwIfInterrupted();
			// The payload is rebuilt from the persisted context + `pending`
			// before every generate, so a mid-turn compaction (pre-request
			// estimate or a provider `context_length_exceeded` retry) is
			// automatically reflected in the next attempt (ADR 0026, D1).
			const messages = this.buildRequestMessages(turn.pending);
			let response: ModelResponse;
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
								turnId: turn.turnId,
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
								turn.emitProgress("model_delta", {
									step,
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
				// force-compact the persisted context and retry the same
				// step. Other failures propagate unchanged.
				if (!isContextLengthExceededError(error)) {
					throw error;
				}
				if (retries >= GENERATE_MAX_RETRIES) {
					throw error;
				}
				retries += 1;
				const compacted = await this.context.compact(
					this.provider,
					this.systemPrompt,
					this.toolSchemas,
					{ turnId: turn.turnId },
					{
						force: true,
						abortSignal: interruptController?.getAbortSignal(),
					},
				);
				if (compacted.summarized) {
					turn.emitProgress("context_compacted", {
						step,
						tokensBefore: compacted.tokensBefore,
						tokensAfter: compacted.tokensAfter,
						trigger: "force",
					});
				}
				// The context was compacted — retry the request with the
				// rebuilt payload.
				continue;
			}
			// A response with no text and no tool calls is degenerate:
			// it is never persisted (ADR 0026, D5) and no "please
			// continue" note is injected into the request. Instead the
			// identical request is retried while the shared retry budget
			// (GENERATE_MAX_RETRIES) allows it; once spent, the empty
			// response falls through and ends the turn with the
			// user-facing "No response generated." fallback.
			if (
				!response.assistantText?.trim() &&
				response.toolCalls.length === 0 &&
				retries < GENERATE_MAX_RETRIES
			) {
				retries += 1;
				turn.emitProgress("context_checkpoint", { step });
				continue;
			}

			turn.lastResponseUsage = response.usage;
			turn.accumulateUsage(response.usage);

			turn.emitProgress("model_request_finished", { step });

			const assistantProgressText = summarizeAssistantProgressText(
				response.assistantText,
			);
			if (assistantProgressText && response.toolCalls.length > 0) {
				turn.emitProgress("assistant_message", {
					step,
					text: assistantProgressText,
				});
			}
			return response;
		}
	}

	/**
	 * Persist the assistant tool-call message, then run each tool call in
	 * order, feeding the result back into the buffer for the next step.
	 */
	private async executeToolCalls(
		turn: TurnState,
		response: ModelResponse,
		step: number,
		interruptController?: TurnInterruptController,
	): Promise<void> {
		turn.pending.push(
			createAssistantMessage(response.assistantText, response.toolCalls, {
				reasoning: response.reasoning ?? undefined,
			}),
		);
		interruptController?.throwIfInterrupted();

		turn.emitProgress("tool_calls_received", {
			step,
			count: response.toolCalls.length,
		});

		for (const toolCall of response.toolCalls) {
			interruptController?.throwIfInterrupted();
			const toolStartedAt = Date.now();
			const toolDescription = this.tools.describeProgress(toolCall);
			turn.emitProgress("tool_execution_started", {
				step,
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				arguments: toolCall.arguments,
				message: toolDescription.summary,
			});
			interruptController?.enterTool();
			const result = await this.tools
				.execute(toolCall, {
					cwd: this.options.workingDirectory,
					runId: this.options.runId,
					sessionId: this.options.sessionId ?? null,
					turnId: turn.turnId,
					abortSignal: interruptController?.getAbortSignal(),
					bash: this.options.bashToolContext,
				})
				.finally(() => {
					interruptController?.leaveActiveStage();
				});

			turn.toolExecutions.push({ toolCall, result });

			const renderedToolResult = formatToolExecutionResult(
				toolCall.name,
				result,
			);
			turn.emitProgress("tool_execution_finished", {
				step,
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				ok: result.ok,
				elapsedMs: Date.now() - toolStartedAt,
				result: truncateProgressToolResult(renderedToolResult),
				data: result.data,
			});

			turn.pending.push(createToolMessage(toolCall.id, toolCall.name, result));
			interruptController?.throwIfInterrupted();
		}
	}

	/** Persist the model's final answer and report the completed turn. */
	private async finishAnswerTurn(
		turn: TurnState,
		step: number,
		response: ModelResponse,
		interruptController?: TurnInterruptController,
	): Promise<RunTurnResult> {
		interruptController?.throwIfInterrupted();
		const assistantText = response.assistantText?.trim() ?? "";
		// An empty response already got its one retry inside the request
		// loop (logged, identical payload). If it is still empty, surface the
		// user-facing fallback and end the turn — the degenerate response
		// itself was never persisted.
		const outputText = assistantText || "No response generated.";

		const contextUpdated = await turn.persistAnswer(
			createAssistantMessage(outputText, undefined, {
				reasoning: response.reasoning ?? undefined,
			}),
		);

		turn.emitProgress("turn_finished", {
			step,
			elapsedMs: Date.now() - turn.startedAtMs,
			usage: turn.turnUsageReported ? turn.turnUsage : null,
		});

		return {
			completionStatus: "completed",
			outputText,
			steps: step,
			toolExecutions: turn.toolExecutions,
			contextSummary: this.context.getSummary(),
			contextMessageCount: this.context.getRecentMessages().length,
			contextUpdated,
			interruptSource: null,
			interruptStage: null,
		};
	}

	/** The step loop exhausted `maxSteps`: synthesize the fallback answer. */
	private async finishMaxStepsTurn(turn: TurnState): Promise<RunTurnResult> {
		const outputText = buildMaxStepsFallbackAnswer(
			turn.toolExecutions,
			this.options.maxSteps,
		);
		// No reasoning to attach: this branch fires only when the loop
		// exhausted `maxSteps` and the last `response` from the inner loop
		// is out of scope. The fallback answer is synthesized locally and
		// has no associated chain-of-thought.
		const contextUpdated = await turn.persistAnswer(
			createAssistantMessage(outputText),
		);

		turn.emitProgress("turn_max_steps_reached", {
			step: this.options.maxSteps,
			elapsedMs: Date.now() - turn.startedAtMs,
			usage: turn.turnUsageReported ? turn.turnUsage : null,
		});

		return {
			completionStatus: "completed",
			outputText,
			steps: this.options.maxSteps,
			toolExecutions: turn.toolExecutions,
			contextSummary: this.context.getSummary(),
			contextMessageCount: this.context.getRecentMessages().length,
			contextUpdated,
			interruptSource: null,
			interruptStage: null,
		};
	}

	private buildRequestMessages(pending: Message[]): Message[] {
		const messages = this.context.buildMessages(this.systemPrompt);
		messages.push(...pending);
		return messages;
	}

	private async finishInterruptedTurn(
		turn: TurnState,
		stage: InterruptStage,
	): Promise<RunTurnResult> {
		const contextUpdated =
			(await turn.persistPendingMessages()) ?? turn.contextUpdateSnapshot();
		turn.emitProgress("turn_interrupted", {
			step: turn.lastStep,
			elapsedMs: Date.now() - turn.startedAtMs,
			stage,
			usage: turn.turnUsageReported ? turn.turnUsage : null,
		});

		return {
			completionStatus: "interrupted",
			outputText: null,
			steps: turn.lastStep,
			toolExecutions: turn.toolExecutions,
			contextSummary: this.context.getSummary(),
			contextMessageCount: this.context.getRecentMessages().length,
			contextUpdated,
			interruptSource: "user_escape",
			interruptStage: stage,
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

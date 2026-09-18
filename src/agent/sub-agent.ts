import { randomUUID } from "node:crypto";
import { TurnInterruptController, TurnInterruptedError } from "../interrupt.js";
import { compactWhitespace, truncate } from "../progress.js";
import type { ToolRegistry } from "../tools/registry.js";
import type {
	ContextBudget,
	ModelProvider,
	ModelUsage,
	RunTurnResult,
	RuntimeLogger,
	SubAgentProgressMarker,
	TurnProgressEvent,
} from "../types.js";
import { ConversationContext } from "./context.js";
import { AgentRunner } from "./runner.js";

export interface SubAgentTask {
	/** Natural-language description of the task handed to the sub-agent. */
	description: string;
	/** The parent tool call's abort signal, so a parent Esc cancels the child. */
	signal?: AbortSignal;
}

export interface SubAgentResult {
	/** The sub-agent's final assistant text — the only thing fed back to the parent. */
	outputText: string;
	/** Number of agent-loop steps the sub-agent took. */
	steps: number;
	completionStatus: RunTurnResult["completionStatus"];
	/** Accumulated provider usage for the run, or null when none was reported. */
	usage: ModelUsage | null;
}

/** One-shot sub-agent entry point. */
export interface SubAgentRunner {
	run(task: SubAgentTask): Promise<SubAgentResult>;
}

/**
 * The child events forwarded to the parent's progress stream: the child's
 * *activity* — its model requests, streamed text, and tool calls.
 *
 * The child's turn lifecycle (`turn_started` and the four terminal events) is
 * deliberately absent. Every frontend keys on those names to mean "the parent
 * turn started/ended" (transcript reset, turn clock, run stats, the session
 * event log's open-turn tracking), so forwarding them would make a sub-agent
 * run look like a whole extra turn. The parent's `SubAgent` tool line already
 * brackets the run (`tool_execution_started` → `tool_execution_finished`), and
 * a failure inside the child surfaces as that tool call's error result.
 */
const FORWARDED_SUB_AGENT_EVENTS: ReadonlySet<TurnProgressEvent["type"]> =
	new Set([
		"model_request_started",
		"model_delta",
		"model_request_finished",
		"assistant_message",
		"tool_calls_received",
		"tool_execution_started",
		"tool_execution_finished",
		"context_compacted",
		"context_elided",
	]);

/** Cap on the task label carried by every forwarded event (kept small: it
 *  rides on each frame, including every model delta). */
const MAX_MARKER_TASK_CHARS = 80;

/** Build the tag that identifies one run's events on the parent's stream. */
function createRunMarker(description: string): SubAgentProgressMarker {
	const task = compactWhitespace(description);
	return {
		id: randomUUID(),
		task: task ? truncate(task, MAX_MARKER_TASK_CHARS) : "(no description)",
	};
}

/**
 * Bridge an external abort signal onto a child turn's interrupt controller.
 *
 * `TurnInterruptController.requestInterrupt` only takes effect while the turn
 * is inside a model or tool stage and is a silent no-op otherwise. A signal
 * that is already aborted (or that fires between stages) would therefore be
 * dropped entirely. Mirror the request onto `throwIfInterrupted`, which the
 * runner calls at the head of every step and every stage, so the turn still
 * ends as interrupted.
 */
function bridgeAbortSignal(
	controller: TurnInterruptController,
	signal: AbortSignal | undefined,
): void {
	if (!signal) {
		return;
	}

	let requested = signal.aborted;
	const throwIfInterrupted = controller.throwIfInterrupted.bind(controller);
	controller.throwIfInterrupted = () => {
		if (requested) {
			throw new TurnInterruptedError(
				"user_escape",
				controller.getActiveStage() ?? "tool",
			);
		}
		throwIfInterrupted();
	};

	signal.addEventListener(
		"abort",
		() => {
			requested = true;
			controller.requestInterrupt();
		},
		{ once: true },
	);
}

/**
 * Build the one-shot sub-agent runner. Each call to {@link SubAgentRunner.run}
 * constructs its own {@link ConversationContext} + {@link AgentRunner}, so the
 * child's intermediate messages (its reads, greps, tool calls) live only for
 * the duration of that run and are discarded on return. Only `outputText` is
 * handed back to the parent.
 *
 * The runner never binds a session or registers a persist hook: the sub-agent
 * is purely in-memory and writes nothing to the session store.
 */
export function createSubAgentRunner(deps: {
	/** Shares the main agent's provider (generate is stateless per request). */
	provider: ModelProvider;
	/** Restricted registry — typically read-only tools only. */
	tools: ToolRegistry;
	/** Sub-agent-specific prompt, including the output contract. */
	systemPrompt: string;
	workingDirectory: string;
	maxSteps: number;
	runId?: string;
	sessionId?: string | null;
	logger?: RuntimeLogger;
	/** Optional context-budget getter, reused from the main agent when given. */
	getContextBudget?: () => ContextBudget;
	/**
	 * Optional progress forwarding: relays the child's activity to the parent's
	 * progress stream, each event tagged with a {@link SubAgentProgressMarker}
	 * so a frontend can nest it under the parent's `SubAgent` tool line. See
	 * {@link FORWARDED_SUB_AGENT_EVENTS} for what is — and is not — forwarded.
	 */
	onProgress?: (event: TurnProgressEvent) => void;
}): SubAgentRunner {
	return {
		async run(task: SubAgentTask): Promise<SubAgentResult> {
			const context = new ConversationContext({
				summaryEnabled: true,
				// Only override the default budget when a getter is supplied;
				// spreading an explicit `undefined` would clobber the default.
				...(deps.getContextBudget
					? { getContextBudget: deps.getContextBudget }
					: {}),
				logger: deps.logger,
				runId: deps.runId,
				sessionId: deps.sessionId ?? null,
			});

			const runner = new AgentRunner({
				provider: deps.provider,
				tools: deps.tools,
				context,
				systemPrompt: deps.systemPrompt,
				options: {
					maxSteps: deps.maxSteps,
					workingDirectory: deps.workingDirectory,
					runId: deps.runId,
					sessionId: deps.sessionId ?? null,
				},
			});

			let usage: ModelUsage | null = null;
			// One marker per run: every forwarded event carries it, so a frontend
			// can render the child's activity as a nested, labelled block and can
			// tell it apart from the parent turn's own events.
			const marker = createRunMarker(task.description);
			runner.onProgress((event) => {
				switch (event.type) {
					case "turn_finished":
					case "turn_interrupted":
					case "turn_failed":
					case "turn_max_steps_reached":
						usage = event.usage;
						break;
					default:
						break;
				}
				if (!FORWARDED_SUB_AGENT_EVENTS.has(event.type)) {
					return;
				}
				deps.onProgress?.({ ...event, subAgent: marker });
			});

			const controller = new TurnInterruptController();
			bridgeAbortSignal(controller, task.signal);

			const result = await runner.runTurn(task.description, controller);

			return {
				outputText: result.outputText ?? "",
				steps: result.steps,
				completionStatus: result.completionStatus,
				usage,
			};
		},
	};
}

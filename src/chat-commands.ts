import { stdin as processInput, stdout as processOutput } from "node:process";
import type { ReadStream, WriteStream } from "node:tty";
import { CompactionFailedError } from "./agent/compaction-error.js";
import {
	type ChatReplState,
	attachNewSession as defaultAttachNewSession,
	attachSessionFromSelector as defaultAttachSessionFromSelector,
	getResumeAvailability as defaultGetResumeAvailability,
} from "./chat-repl.js";
import { formatContextWindowSummary } from "./context-summary.js";
import { OpenAICompatibleProvider } from "./model/openai-compatible.js";
import type { SessionStore } from "./session/store.js";
import { setLastModelId } from "./state.js";
import type { BackgroundTaskManager } from "./tools/background.js";
import {
	type Component,
	ProcessTerminal,
	SelectList,
	Tui,
} from "./tui/index.js";
import type {
	ContextUpdateResult,
	LoadedSkill,
	PersistedSession,
	ProgressReporter,
	SessionTurnHistoryEntry,
} from "./types.js";

export interface ChatCommandMetadata {
	name: string;
	aliases?: readonly string[];
	description: string;
}

export interface ChatCommandContext {
	getState(): ChatReplState;
	setState(state: ChatReplState): void;
	store: SessionStore;
	progressReporter?: ProgressReporter;
	writeLine(line: string): void;
	/**
	 * Optional abort signal sourced from the surrounding chat loop (e.g.
	 * the active `TurnInterruptController`). When present, commands that
	 * perform long-running work (`/compact`) should forward it into any
	 * underlying async calls so the user can cancel with Ctrl-C.
	 */
	getInterruptSignal?(): AbortSignal | undefined;
}

export interface ChatCommandDefinition extends ChatCommandMetadata {
	handler: (
		context: ChatCommandContext,
		args: string[],
	) => Promise<ChatCommandOutcome> | ChatCommandOutcome;
}

export type ParsedChatCommand =
	| {
			kind: "command";
			command: ChatCommandDefinition;
			args: string[];
			rawName: string;
	  }
	| {
			kind: "unknown";
			args: string[];
			rawName: string;
	  }
	| {
			kind: "none";
	  };

export type ChatCommandOutcome =
	| {
			action: "continue";
	  }
	| {
			action: "exit";
	  }
	| {
			/** Run the given text as a model turn (used by `/skill` to inject instructions). */
			action: "run-turn";
			input: string;
	  };

export type ChatCommandExecutionResult =
	| {
			kind: "handled";
			action: ChatCommandOutcome["action"];
			input?: string;
	  }
	| {
			kind: "unknown-command";
			rawName: string;
	  }
	| {
			kind: "not-a-command";
	  };

export interface ChatCommandDependencies {
	attachSessionFromSelector: typeof defaultAttachSessionFromSelector;
	attachNewSession: typeof defaultAttachNewSession;
	getResumeAvailability: typeof defaultGetResumeAvailability;
	selectModelFromSelector: typeof selectModelInteractive;
	rememberModelSelection: typeof setLastModelId;
	backgroundTaskManager?: BackgroundTaskManager;
	/** Skills to expose as dynamic `/skill:<name>` commands. */
	loadedSkills?: readonly LoadedSkill[];
}

export const DOCUMENTED_CHAT_COMMAND_NAMES = [
	"/summary",
	"/compact",
	"/model",
	"/session",
	"/history",
	"/resume",
	"/new",
	"/tasks",
	"/skill",
	"/exit",
] as const;

export function formatDocumentedChatCommands(): string {
	return DOCUMENTED_CHAT_COMMAND_NAMES.join(", ");
}

export function createChatCommandDefinitions(
	dependencies: Partial<ChatCommandDependencies> = {},
): readonly ChatCommandDefinition[] {
	const attachSessionFromSelector =
		dependencies.attachSessionFromSelector ?? defaultAttachSessionFromSelector;
	const attachNewSession =
		dependencies.attachNewSession ?? defaultAttachNewSession;
	const getResumeAvailability =
		dependencies.getResumeAvailability ?? defaultGetResumeAvailability;
	const selectModelFromSelector =
		dependencies.selectModelFromSelector ?? selectModelInteractive;
	const rememberModelSelection =
		dependencies.rememberModelSelection ?? setLastModelId;
	const backgroundTaskManager = dependencies.backgroundTaskManager;

	const skillCommands = (
		dependencies.loadedSkills ?? []
	).map<ChatCommandDefinition>((skill) => ({
		name: `/skill:${skill.name}`,
		description: `Load the "${skill.name}" skill into the conversation: ${skill.description}`,
		handler: (_context, args) => {
			const message = args.join(" ").trim();
			return {
				action: "run-turn",
				input: buildSkillInjection(skill, message || undefined),
			};
		},
	}));

	return [
		{
			name: "/summary",
			description: "Show context window summary",
			handler: (context) => {
				context.writeLine(formatContextWindowSummary(context.getState()));
				return { action: "continue" };
			},
		},
		{
			name: "/compact",
			description: "Compact current context and save the snapshot",
			handler: async (context, args) => {
				const state = context.getState();
				const instructions = args.join(" ").trim();
				const abortSignal = context.getInterruptSignal?.();
				const compactOptions = {
					...(instructions ? { instructions } : {}),
					...(abortSignal ? { abortSignal } : {}),
				};
				let result: ContextUpdateResult;
				try {
					result =
						(await state.sessionRuntime?.compactContext(compactOptions)) ??
						(await state.runner.compactContext(compactOptions));
				} catch (error) {
					if (error instanceof CompactionFailedError) {
						context.writeLine(
							`Compaction failed: ${error.message} (reason: ${error.reason}).`,
						);
						context.writeLine(
							"Your messages are saved. The context was trimmed if it exceeded the limit; run /compact again later to generate a summary.",
						);
						return { action: "continue" };
					}
					throw error;
				}

				if (!result.summarized && !result.trimmed) {
					context.writeLine("Nothing to compact.");
					context.writeLine(
						`Recent messages: ${result.recentMessageCount}. Summary chars: ${result.summaryChars}. Estimated context size: ${result.tokensAfter} tokens.`,
					);
					return { action: "continue" };
				}

				const changes = [];
				if (result.summarized) {
					changes.push("summary updated");
				}
				if (result.trimmed) {
					changes.push("recent messages trimmed");
				}

				context.writeLine(
					`Context compacted: ${changes.join(", ")}.${
						state.sessionRuntime ? " Snapshot saved." : ""
					}`,
				);
				if (instructions) {
					context.writeLine(`Custom instructions applied to summary.`);
				}
				context.writeLine(
					`Recent messages: ${result.previousRecentMessageCount} -> ${result.recentMessageCount}.`,
				);
				context.writeLine(
					`Summary chars: ${result.previousSummaryChars} -> ${result.summaryChars}.`,
				);
				context.writeLine(
					`Estimated context size: ${result.tokensBefore} -> ${result.tokensAfter} tokens.`,
				);
				return { action: "continue" };
			},
		},
		{
			name: "/model",
			description: "Show or switch the active model",
			handler: async (context, args) => {
				const state = context.getState();
				const requestedModelId =
					args[0] === "switch" ? args[1]?.trim() : args[0]?.trim();

				if (args[0] === "switch" && !requestedModelId) {
					context.writeLine("Usage: /model [switch] <name>");
					return { action: "continue" };
				}

				if (!requestedModelId) {
					context.writeLine(formatModelList(state));
					const selectedModelId = await selectModelFromSelector(state);
					if (selectedModelId) {
						await switchActiveModel(
							context,
							selectedModelId,
							rememberModelSelection,
						);
					}
					return { action: "continue" };
				}

				if (args[0] === "switch" && args.length > 2) {
					context.writeLine("Usage: /model [switch] <name>");
					return { action: "continue" };
				}

				if (args[0] !== "switch" && args.length > 1) {
					context.writeLine("Usage: /model [switch] <name>");
					return { action: "continue" };
				}

				if (
					!(await switchActiveModel(
						context,
						requestedModelId,
						rememberModelSelection,
					))
				) {
					context.writeLine(`Unknown model: ${requestedModelId}`);
					context.writeLine(formatModelList(state));
					return { action: "continue" };
				}
				return { action: "continue" };
			},
		},
		{
			name: "/session",
			description: "Show current session JSON",
			handler: (context) => {
				const session = context.getState().sessionRuntime?.getCurrentSession();

				if (!session) {
					context.writeLine("(no active session)");
					return { action: "continue" };
				}

				context.writeLine(
					JSON.stringify(
						{
							sessionId: session.sessionId,
							title: session.title,
							status: session.status,
							updatedAt: session.updatedAt,
							turnCount: session.turnCount,
							lastTurn: session.lastTurn,
						},
						null,
						2,
					),
				);
				return { action: "continue" };
			},
		},
		{
			name: "/history",
			description: "Show saved turn history for the active session",
			handler: (context, args) => {
				const limit = parseHistoryLimit(args);
				if (limit === "invalid") {
					context.writeLine("Usage: /history [all|<count>]");
					return { action: "continue" };
				}

				const session = context.getState().sessionRuntime?.getCurrentSession();
				if (!session) {
					context.writeLine("(no active session)");
					return { action: "continue" };
				}

				context.writeLine(formatSessionHistory(session, limit));
				return { action: "continue" };
			},
		},
		{
			name: "/resume",
			description: "Switch to another saved session",
			handler: async (context) => {
				const availability = getResumeAvailability(context.getState());
				if (!availability.ok) {
					context.writeLine(availability.message);
					return { action: "continue" };
				}

				const sessions = await context.store.listSessions();
				if (sessions.length === 0) {
					context.writeLine("No saved sessions available to resume.");
					return { action: "continue" };
				}

				const attached = await attachSessionFromSelector(
					context.getState(),
					context.store,
					context.progressReporter,
				);

				if (!attached) {
					context.writeLine("Resume cancelled.");
					return { action: "continue" };
				}

				context.setState(attached.updatedState);
				context.writeLine(`Attached session: ${attached.selectedSessionId}`);
				for (const warning of attached.warnings) {
					context.writeLine(`[session-warning] ${warning}`);
				}
				return { action: "continue" };
			},
		},
		{
			name: "/new",
			description: "Start a fresh session",
			handler: async (context) => {
				const attached = await attachNewSession(context.progressReporter);
				context.setState(attached.updatedState);
				context.writeLine(`Started new session: ${attached.selectedSessionId}`);
				for (const warning of attached.warnings) {
					context.writeLine(`[session-warning] ${warning}`);
				}
				return { action: "continue" };
			},
		},
		{
			name: "/exit",
			aliases: ["/quit", "exit", "quit"],
			description: "Exit interactive chat",
			handler: (context) => {
				const session = context.getState().sessionRuntime?.getCurrentSession();
				if (session) {
					const title = session.title?.trim();
					context.writeLine(
						title
							? `Exiting session: ${title} (${session.sessionId})`
							: `Exiting session: ${session.sessionId}`,
					);
				} else {
					context.writeLine("Exiting chat (no active session).");
				}
				return { action: "exit" };
			},
		},
		{
			name: "/tasks",
			description:
				"List background tasks, or stop one with '/tasks stop <task-id>'",
			handler: (context, args) => {
				if (!backgroundTaskManager) {
					context.writeLine(
						"Background tasks are not available in this runtime.",
					);
					return { action: "continue" };
				}

				const subcommand = args[0]?.trim();
				if (subcommand === "stop") {
					const taskId = args[1]?.trim();
					if (!taskId) {
						context.writeLine("Usage: /tasks stop <task-id>");
						return { action: "continue" };
					}
					const stopped = backgroundTaskManager.stop(taskId);
					context.writeLine(
						stopped
							? `Stopped task ${taskId}.`
							: `Task ${taskId} not found or already finished.`,
					);
					return { action: "continue" };
				}

				if (subcommand && subcommand !== "list") {
					context.writeLine("Usage: /tasks [list | stop <task-id>]");
					return { action: "continue" };
				}

				const tasks = backgroundTaskManager.list();
				if (tasks.length === 0) {
					context.writeLine("No background tasks.");
					return { action: "continue" };
				}

				for (const task of tasks) {
					const label = task.description ? ` (${task.description})` : "";
					const lines = [
						`[${task.status}] ${task.id}${label}`,
						`  command: ${task.command}`,
						`  pid: ${task.pid ?? "-"}\n  cwd: ${task.cwd}`,
						`  log: ${task.logPath}`,
						`  started: ${new Date(task.startedAt).toISOString()}`,
					];
					if (task.status === "done") {
						lines.push(
							`  exit: ${task.exitCode ?? "unknown"}${task.signal ? ` (signal ${task.signal})` : ""}`,
						);
					}
					context.writeLine(lines.join("\n"));
				}
				return { action: "continue" };
			},
		},
		{
			name: "/skill",
			aliases: ["/skill:"],
			description:
				"List loaded skills (use /skill:<name> to load one; /skill:<name> <message> loads and chats)",
			handler: (context, args) => {
				const skills = context.getState().loadedSkills;
				if (skills.length === 0) {
					context.writeLine("No skills are loaded.");
					return { action: "continue" };
				}
				context.writeLine("Loaded skills:");
				for (const skill of skills) {
					context.writeLine(`- ${skill.name}: ${skill.description}`);
				}
				const name = args[0]?.trim();
				if (name) {
					context.writeLine(
						`There is no /skill <name> syntax. To load a skill, use /skill:${name}.`,
					);
				}
				return { action: "continue" };
			},
		},
		...skillCommands,
	];
}

function buildSkillInjection(skill: LoadedSkill, message?: string): string {
	const lines = [
		`Skill: ${skill.name}`,
		`Directory: ${skill.dir}`,
		"",
		skill.body,
		"",
		"Follow the instructions above. Any files referenced (scripts/, references/, assets/) are relative to the Directory above; use the read tool or bash to access them.",
	];
	if (message && message.length > 0) {
		lines.push("", "User request:", message);
	}
	return lines.join("\n");
}

class ModelSelectorComponent implements Component {
	public onResolve?: (result: string | null) => void;
	private readonly list: SelectList<string>;

	constructor(state: ChatReplState) {
		const entries = Object.entries(state.models);
		const selectedIndex = Math.max(
			0,
			entries.findIndex(([modelId]) => modelId === state.modelId),
		);

		this.list = new SelectList(
			entries.map(([modelId, model]) => ({
				label: modelId === state.modelId ? `${modelId} (current)` : modelId,
				description: model.name,
				value: modelId,
			})),
			{ selectedIndex },
		);
		this.list.onSelect = (item) => this.onResolve?.(item.value);
		this.list.onCancel = () => this.onResolve?.(null);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	render(width: number): string[] {
		return [
			"Select a model:",
			"",
			...this.list.render(width),
			"",
			"Use ArrowUp/ArrowDown to move, Enter to confirm, Esc or Ctrl+C to cancel.",
		];
	}
}

export async function selectModelInteractive(
	state: ChatReplState,
	args?: {
		input?: ReadStream;
		output?: WriteStream;
	},
): Promise<string | null> {
	const input = args?.input ?? processInput;
	const output = args?.output ?? processOutput;

	if (!input.isTTY || !output.isTTY || Object.keys(state.models).length === 0) {
		return null;
	}

	return new Promise<string | null>((resolve) => {
		const terminal = new ProcessTerminal(input, output);
		const tui = new Tui(terminal);
		const component = new ModelSelectorComponent(state);

		component.onResolve = (result) => {
			tui.stop();
			output.write("\x1B[2J\x1B[H");
			resolve(result);
		};

		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
	});
}

function switchActiveModel(
	context: ChatCommandContext,
	requestedModelId: string,
	rememberModelSelection: typeof setLastModelId,
): Promise<boolean> {
	const state = context.getState();
	const model = state.models[requestedModelId];
	if (!model) {
		return Promise.resolve(false);
	}

	state.runner.setProvider(new OpenAICompatibleProvider(model, state.logger));
	context.setState({
		...state,
		modelId: requestedModelId,
		modelName: model.name,
	});
	context.writeLine(`Switched model to ${requestedModelId} (${model.name}).`);
	return rememberModelSelection(requestedModelId)
		.then(() => true)
		.catch((error: unknown) => {
			state.logger?.warn?.("model_selection_state_save_failed", {
				modelId: requestedModelId,
				error: error instanceof Error ? error.message : String(error),
			});
			return true;
		});
}

function formatModelList(state: ChatReplState): string {
	const lines = [
		`Current model: ${state.modelId} (${state.modelName})`,
		"Available models:",
	];

	for (const [modelId, model] of Object.entries(state.models)) {
		const marker = modelId === state.modelId ? "*" : " ";
		lines.push(`${marker} ${modelId} (${model.name})`);
	}

	return lines.join("\n");
}

function parseHistoryLimit(args: string[]): number | "all" | "invalid" {
	if (args.length === 0) {
		return 5;
	}

	if (args.length === 1 && args[0]?.toLowerCase() === "all") {
		return "all";
	}

	if (args.length === 1 && /^[1-9]\d*$/.test(args[0] ?? "")) {
		return Number(args[0]);
	}

	return "invalid";
}

function formatSessionHistory(
	session: PersistedSession,
	limit: number | "all",
): string {
	if (session.turns.length === 0) {
		return "(no saved turns)";
	}

	const turns = limit === "all" ? session.turns : session.turns.slice(-limit);
	return turns.map(formatHistoryTurn).join("\n\n");
}

function formatHistoryTurn(turn: SessionTurnHistoryEntry): string {
	const lines = [
		`Turn ${turn.turnId} [${turn.status}] ${formatTurnTimeRange(turn)}`,
		`User: ${turn.userInput}`,
		`Assistant: ${turn.assistantOutput ?? "(no assistant output)"}`,
	];

	if (turn.errorMessage) {
		lines.push(`Error: ${turn.errorMessage}`);
	}

	if (turn.toolExecutions.length > 0) {
		lines.push(`Tools: ${turn.toolExecutions.length}`);
	}

	return lines.join("\n");
}

function formatTurnTimeRange(turn: SessionTurnHistoryEntry): string {
	return turn.finishedAt
		? `${turn.startedAt} -> ${turn.finishedAt}`
		: turn.startedAt;
}

export function parseChatCommand(
	input: string,
	commands: readonly ChatCommandDefinition[],
): ParsedChatCommand {
	const trimmed = input.trim();
	const [rawName = trimmed, ...args] = trimmed.split(/\s+/);
	const command = commands.find((entry) =>
		[entry.name, ...(entry.aliases ?? [])].includes(rawName),
	);

	if (command) {
		return {
			kind: "command",
			command,
			args,
			rawName,
		};
	}

	if (!trimmed.startsWith("/")) {
		return { kind: "none" };
	}

	return {
		kind: "unknown",
		args,
		rawName,
	};
}

export async function executeChatCommand(
	input: string,
	commands: readonly ChatCommandDefinition[],
	context: ChatCommandContext,
): Promise<ChatCommandExecutionResult> {
	const parsed = parseChatCommand(input, commands);
	if (parsed.kind === "none") {
		return { kind: "not-a-command" };
	}

	if (parsed.kind === "unknown") {
		return {
			kind: "unknown-command",
			rawName: parsed.rawName,
		};
	}

	const outcome = await parsed.command.handler(context, parsed.args);
	if (outcome.action === "run-turn") {
		return {
			kind: "handled",
			action: "run-turn",
			input: outcome.input,
		};
	}
	return {
		kind: "handled",
		action: outcome.action,
	};
}

export function getChatCommandSuggestions(
	buffer: string,
	commands: readonly ChatCommandMetadata[],
	limit = 5,
): ChatCommandMetadata[] {
	if (!/^\/\S*$/.test(buffer)) {
		return [];
	}

	return commands
		.filter((command) =>
			[command.name, ...(command.aliases ?? [])].some((name) =>
				name.startsWith(buffer),
			),
		)
		.slice(0, limit);
}

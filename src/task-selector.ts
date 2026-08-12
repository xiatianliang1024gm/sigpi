import { readFileSync } from "node:fs";
import { stdin as processInput, stdout as processOutput } from "node:process";
import {
	type Component,
	matchesKey,
	ProcessTerminal,
	type Terminal,
	TUI,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { BackgroundTask } from "./tools/background.js";
import { moveSelectedIndex } from "./tui/move-selected-index.js";

/**
 * Options for {@link selectTaskInteractive}.
 */
export interface SelectTaskOptions {
	/**
	 * Pi-tui Terminal to drive the picker. Defaults to a real ProcessTerminal
	 * (process.stdin/stdout) when omitted. Tests inject a fake terminal here so
	 * the overlay composite can be verified through the Terminal seam.
	 */
	terminal?: Terminal;
	/**
	 * Parent TUI instance to reuse for the task picker overlay. When provided,
	 * the picker is rendered as an overlay on the existing TUI instead of
	 * creating a separate TUI / ProcessTerminal (which would double-listen on
	 * process.stdin and break the parent REPL).
	 */
	parentTui?: TUI;
	/**
	 * Stop a task by id (e.g. `BackgroundTaskManager#stop`). Invoked from the
	 * detail view with the `k` key.
	 */
	killTask?: (taskId: string) => void;
}

export interface TaskSelectorState {
	readonly tasks: BackgroundTask[];
	readonly selectedIndex: number;
	/** Task id whose details are open; `null` while the list is shown. */
	readonly detailTaskId: string | null;
}

export type TaskSelectorResolution =
	| { status: "cancelled" }
	| { status: "closed"; taskId: string };

type TaskSelectorAction =
	| { type: "up" }
	| { type: "down" }
	| { type: "confirm" }
	| { type: "cancel" }
	| { type: "back" };

/** Rows the detail view reserves above the output box (header, fields, label). */
const DETAIL_LINES_BEFORE_BOX = 7;
/** Rows the detail view reserves below the output box (count, blank, footer). */
const DETAIL_LINES_AFTER_BOX = 3;
/** The box's top and bottom border rows. */
const DETAIL_BOX_BORDERS = 2;
/** Interval between live re-renders so Runtime / output stay fresh. */
const TASK_VIEW_REFRESH_MS = 1_000;

/** Strip ANSI escape sequences so log lines wrap and box-align cleanly. */
const ANSI_ESCAPE_RE = /\x1B(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*(?:\x07|\x1B\\))/g;

export function createTaskSelectorState(
	tasks: readonly BackgroundTask[],
): TaskSelectorState {
	return {
		tasks: [...tasks],
		selectedIndex: 0,
		detailTaskId: null,
	};
}

export function reduceTaskSelector(
	state: TaskSelectorState,
	action: TaskSelectorAction,
): TaskSelectorState | TaskSelectorResolution {
	if (action.type === "confirm") {
		if (state.detailTaskId != null) {
			return { status: "closed", taskId: state.detailTaskId };
		}
		const selected = state.tasks[state.selectedIndex];
		if (!selected) {
			return { status: "cancelled" };
		}
		return { ...state, detailTaskId: selected.id };
	}

	if (action.type === "cancel") {
		return state.detailTaskId != null
			? { status: "closed", taskId: state.detailTaskId }
			: { status: "cancelled" };
	}

	if (action.type === "back") {
		return state.detailTaskId != null
			? { ...state, detailTaskId: null }
			: state;
	}

	if (state.detailTaskId != null || state.tasks.length === 0) {
		return state;
	}

	return {
		...state,
		selectedIndex: moveSelectedIndex(
			state.selectedIndex,
			state.tasks.length,
			action.type === "up" ? -1 : 1,
		),
	};
}

/**
 * Render the picker as a full-screen modal: every visible row is either
 * picker content or a blank line, so background transcript text never bleeds
 * in around the list. `height` is the terminal's row count, taken live so a
 * terminal resize is picked up on the next render.
 */
export function renderTaskSelectorFullScreen(
	state: TaskSelectorState,
	width: number,
	height: number,
	now: Date = new Date(),
): string[] {
	const content =
		state.detailTaskId != null
			? renderTaskDetail(state, width, height, now)
			: renderTaskList(state, width, now).split("\n");
	return padToHeight(content, height, width);
}

/** Render the task list (header, one row per task, key hints). */
export function renderTaskList(
	state: TaskSelectorState,
	maxWidth = 100,
	now: Date = new Date(),
): string {
	const lines = ["Background tasks:", ""];

	for (const [index, task] of state.tasks.entries()) {
		lines.push(
			renderTaskLine(task, index === state.selectedIndex, maxWidth, now),
		);
	}

	lines.push("");
	lines.push(
		"Use ArrowUp/ArrowDown to move, Enter to view details, Esc or Ctrl+C to close.",
	);
	return lines.join("\n");
}

/** Render the detail page for the task opened from the list (reference layout). */
export function renderTaskDetail(
	state: TaskSelectorState,
	width: number,
	height: number,
	now: Date = new Date(),
): string[] {
	const task =
		state.tasks.find((candidate) => candidate.id === state.detailTaskId) ??
		state.tasks[state.selectedIndex];
	if (!task) {
		return ["No background tasks."];
	}

	const lines: string[] = [];
	const title = task.description
		? `Shell details: ${task.description}`
		: "Shell details";
	lines.push(truncateLine(title, width));
	lines.push("");
	lines.push(`Status: ${formatTaskStatus(task)}`);
	lines.push(`Runtime: ${formatRuntime(taskRuntimeMs(task, now))}`);
	lines.push(
		`Command: ${truncateLine(task.command, Math.max(1, width - "Command: ".length))}`,
	);
	lines.push(truncateLine(`Id: ${task.id}`, width));
	lines.push("Output:");

	const boxHeight = Math.max(
		1,
		height -
			DETAIL_LINES_BEFORE_BOX -
			DETAIL_LINES_AFTER_BOX -
			DETAIL_BOX_BORDERS,
	);
	const { rows, shownLines } = readOutputBox(task.logPath, width, boxHeight);
	lines.push(...renderBox(rows, width));
	lines.push(`Showing ${shownLines} lines`);
	lines.push("");
	lines.push(
		truncateLine("← to go back · Esc/Enter/Space to close · k to kill", width),
	);
	return lines;
}

/**
 * Elapsed time of a task in ms. While running it keeps counting from
 * `startedAt` to `now`; once the task has finished the timer freezes at
 * `endedAt`, so a stopped task's runtime stops moving.
 */
export function taskRuntimeMs(task: BackgroundTask, now: Date): number {
	const end =
		task.status === "done" && task.endedAt != null
			? task.endedAt
			: now.getTime();
	return end - task.startedAt;
}

/** Human-readable status for a task, e.g. `running` or `done (exit 0)`. */
export function formatTaskStatus(task: BackgroundTask): string {
	if (task.status === "running") {
		return task.killed ? "stopping" : "running";
	}
	const bits: string[] = [];
	if (task.exitCode != null) {
		bits.push(`exit ${task.exitCode}`);
	}
	if (task.signal) {
		bits.push(`signal ${task.signal}`);
	}
	if (task.timedOut) {
		bits.push("timed out");
	}
	return bits.length > 0 ? `done (${bits.join(", ")})` : "done";
}

/** Format an elapsed time as `24s`, `1m 5s`, `1h 2m`, ... */
export function formatRuntime(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) {
		parts.push(`${hours}h`);
	}
	if (minutes > 0) {
		parts.push(`${minutes}m`);
	}
	if (seconds > 0 || parts.length === 0) {
		parts.push(`${seconds}s`);
	}
	return parts.join(" ");
}

export class TaskSelectorComponent implements Component {
	public onResolve?: (result: string | null) => void;

	constructor(
		private state: TaskSelectorState,
		private readonly options: {
			/** Live terminal row count so the picker covers the whole viewport. */
			getHeight?: () => number;
			killTask?: (taskId: string) => void;
		} = {},
	) {}

	render(width: number): string[] {
		const height = this.options.getHeight?.() ?? 24;
		return renderTaskSelectorFullScreen(this.state, width, height);
	}

	handleInput(data: string): void {
		// Killing is a side effect on the task manager, handled outside the
		// pure reducer. Only reachable from the detail view.
		if (matchesKey(data, "k") && this.state.detailTaskId != null) {
			this.options.killTask?.(this.state.detailTaskId);
			return;
		}

		const action = inputToTaskAction(data);
		if (!action) {
			return;
		}

		const next = reduceTaskSelector(this.state, action);
		if ("status" in next) {
			this.onResolve?.(next.status === "cancelled" ? null : next.taskId);
			return;
		}

		this.state = next;
	}

	invalidate(): void {}
}

/**
 * Open the interactive task picker: list view with up/down navigation, Enter
 * to open a task's details, `k` to kill from the detail view, and Esc/Enter/
 * Space to close. Returns the id of the task whose details were open when the
 * picker closed, or `null` when it was cancelled from the list.
 */
export async function selectTaskInteractive(
	tasks: readonly BackgroundTask[],
	options?: SelectTaskOptions,
): Promise<string | null> {
	if (tasks.length === 0) {
		return null;
	}

	const parentTui = options?.parentTui;
	const usingProvidedTerminal = Boolean(options?.terminal);

	// In a non-interactive (piped) environment there is no TTY to drive an
	// interactive picker.
	if (
		!parentTui &&
		!usingProvidedTerminal &&
		(!processInput.isTTY || !processOutput.isTTY)
	) {
		return null;
	}

	return new Promise<string | null>((resolve) => {
		const terminal =
			parentTui?.terminal ?? options?.terminal ?? new ProcessTerminal();
		const tui = parentTui ?? new TUI(terminal);

		const component = new TaskSelectorComponent(
			createTaskSelectorState(tasks),
			{
				getHeight: () => terminal.rows,
				killTask: options?.killTask,
			},
		);

		// Live refresh: Runtime advances and task output grows while open.
		const tick = setInterval(() => tui.requestRender(), TASK_VIEW_REFRESH_MS);
		tick.unref?.();

		component.onResolve = (result) => {
			clearInterval(tick);
			if (parentTui) {
				parentTui.hideOverlay();
			} else {
				tui.stop();
				terminal.clearScreen();
			}
			resolve(result);
		};

		if (parentTui) {
			parentTui.showOverlay(component, {
				anchor: "center",
				width: "100%",
				maxHeight: "100%",
			});
			return;
		}

		tui.showOverlay(component, {
			anchor: "center",
			width: "100%",
			maxHeight: "100%",
		});
		tui.start();
	});
}

function inputToTaskAction(data: string): TaskSelectorAction | null {
	// Use pi-tui's matchesKey instead of exact byte comparisons so the Kitty
	// keyboard protocol (iTerm2/Ghostty/kitty) key encodings still work.
	if (matchesKey(data, "up")) {
		return { type: "up" };
	}
	if (matchesKey(data, "down")) {
		return { type: "down" };
	}
	// matchesKey treats `\n` as Enter only when the Kitty protocol is off;
	// keep accepting it unconditionally to preserve legacy behavior.
	if (matchesKey(data, "enter") || data === "\n") {
		return { type: "confirm" };
	}
	if (matchesKey(data, "left")) {
		return { type: "back" };
	}
	// Space closes the detail view (and confirms in the list), matching the
	// reference footer "Esc/Enter/Space to close".
	if (matchesKey(data, "space")) {
		return { type: "confirm" };
	}
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
		return { type: "cancel" };
	}
	return null;
}

function renderTaskLine(
	task: BackgroundTask,
	selected: boolean,
	maxWidth: number,
	now: Date,
): string {
	const prefix = selected ? "> " : "  ";
	// Show what the task is doing first (its label, falling back to the
	// command), then its status, then the (frozen) runtime. No task id.
	const content = task.description ?? task.command;
	const line =
		`${prefix}${content}  ${formatTaskStatus(task)}  ` +
		formatRuntime(taskRuntimeMs(task, now));
	return truncateLine(line, maxWidth);
}

/**
 * Read the task's log file, keep the tail that fits `boxHeight` rows, and
 * wrap long lines to the box's inner width. Returns the wrapped rows plus the
 * number of raw log lines that contributed to them (for "Showing N lines").
 */
function readOutputBox(
	logPath: string,
	boxWidth: number,
	boxHeight: number,
): { rows: string[]; shownLines: number } {
	let raw = "";
	try {
		raw = readFileSync(logPath, "utf8").replaceAll(ANSI_ESCAPE_RE, "");
	} catch {
		raw = "";
	}

	const contentWidth = Math.max(1, boxWidth - 4);
	const rawLines = raw.split(/\r?\n/);
	const rows: string[] = [];
	let shownLines = 0;

	for (
		let index = rawLines.length - 1;
		index >= 0 && rows.length < boxHeight;
		index -= 1
	) {
		const wrapped = wrapTextWithAnsi(rawLines[index], contentWidth);
		const available = boxHeight - rows.length;
		const take = wrapped.slice(-available);
		rows.unshift(...take);
		shownLines += 1;
	}

	while (rows.length < boxHeight) {
		rows.push("");
	}
	return { rows, shownLines };
}

/** Draw a single-line box around the output rows. */
function renderBox(rows: string[], width: number): string[] {
	const contentWidth = Math.max(0, width - 4);
	const horizontal = "─".repeat(Math.max(0, width - 2));
	const lines: string[] = [`╭${horizontal}╮`];
	for (const row of rows) {
		lines.push(`│ ${row.padEnd(contentWidth).slice(0, contentWidth)} │`);
	}
	lines.push(`╰${horizontal}╯`);
	return lines;
}

/** Pad content to exactly `height` full-width rows so the base screen is hidden. */
function padToHeight(
	content: string[],
	height: number,
	width: number,
): string[] {
	const lines: string[] = [];
	for (let row = 0; row < height; row += 1) {
		lines.push(truncateLine(content[row] ?? "", width).padEnd(width));
	}
	return lines;
}

/** Truncate a plain (ANSI-free) line to fit `maxWidth`, adding an ellipsis. */
function truncateLine(value: string, maxWidth: number): string {
	if (value.length <= maxWidth) {
		return value;
	}
	return `${value.slice(0, Math.max(0, maxWidth - 3))}...`;
}

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { type Component, TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
	createTaskSelectorState,
	formatRuntime,
	formatTaskStatus,
	reduceTaskSelector,
	renderTaskDetail,
	renderTaskList,
	renderTaskSelectorFullScreen,
	selectTaskInteractive,
	TaskSelectorComponent,
	type TaskSelectorResolution,
	type TaskSelectorState,
	taskRuntimeMs,
} from "../src/task-selector.js";
import type { BackgroundTask } from "../src/tools/background.js";
import { FakeTerminal } from "./helpers/fake-terminal.js";
import { createTempDir } from "./helpers.js";

/** A trivial base component for exercising overlay compositing. */
class BaseTextComponent implements Component {
	constructor(private readonly lines: string[]) {}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

/** Strip Pi-tui's reset/escape sequences so we can assert on visible text. */
function stripTerminalOutput(writes: string[]): string {
	return writes
		.join("")
		.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
		.replace(/\x1b\][^\x07]*\x07/g, "")
		.trim();
}

/** Split captured terminal output into per-line visible text. */
function renderedLines(writes: string[]): string[] {
	return stripTerminalOutput(writes)
		.split("\r\n")
		.map((line) => line.trimEnd());
}

/** Poll the terminal's captured writes until `predicate` holds. */
async function waitForWrite(
	terminal: FakeTerminal,
	predicate: (lines: string[]) => boolean,
	timeoutMs = 1_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate(renderedLines(terminal.writes))) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for terminal output");
}

function createTask(
	overrides: Partial<BackgroundTask> & Pick<BackgroundTask, "id" | "logPath">,
): BackgroundTask {
	return {
		pid: 1234,
		command: `bash ${overrides.id}.sh 2>&1`,
		cwd: "/tmp",
		description: null,
		startedAt: Date.now() - 24_000,
		endedAt: null,
		status: "running",
		exitCode: null,
		signal: null,
		killed: false,
		timedOut: false,
		...overrides,
	};
}

/** Narrow a reducer result to the still-open selector state. */
function expectOpenState(
	result: TaskSelectorState | TaskSelectorResolution,
): TaskSelectorState {
	if ("status" in result) {
		assert.fail("expected the picker to stay open");
	}
	return result;
}

test("selector arrows change the highlighted task and Enter opens its details", () => {
	const state = createTaskSelectorState([
		createTask({ id: "task-1", logPath: "/tmp/t1.log" }),
		createTask({ id: "task-2", logPath: "/tmp/t2.log" }),
	]);

	const movedDown = expectOpenState(
		reduceTaskSelector(state, { type: "down" }),
	);
	assert.equal(movedDown.selectedIndex, 1);

	const opened = expectOpenState(
		reduceTaskSelector(movedDown, { type: "confirm" }),
	);
	assert.equal(opened.detailTaskId, "task-2");
});

test("Enter or Esc in the detail view closes with the viewed task id", () => {
	const state = createTaskSelectorState([
		createTask({ id: "task-1", logPath: "/tmp/t1.log" }),
	]);
	const opened = expectOpenState(
		reduceTaskSelector(state, { type: "confirm" }),
	);

	assert.deepEqual(reduceTaskSelector(opened, { type: "confirm" }), {
		status: "closed",
		taskId: "task-1",
	});
	assert.deepEqual(reduceTaskSelector(opened, { type: "cancel" }), {
		status: "closed",
		taskId: "task-1",
	});
});

test("left arrow returns from details to the list", () => {
	const state = createTaskSelectorState([
		createTask({ id: "task-1", logPath: "/tmp/t1.log" }),
		createTask({ id: "task-2", logPath: "/tmp/t2.log" }),
	]);
	const opened = expectOpenState(
		reduceTaskSelector(state, { type: "confirm" }),
	);
	const back = expectOpenState(reduceTaskSelector(opened, { type: "back" }));

	assert.equal(back.detailTaskId, null);
	assert.equal(back.selectedIndex, 0, "selection stays on the viewed task");
});

test("Esc cancels from the list, and navigation is ignored in the detail view", () => {
	const state = createTaskSelectorState([
		createTask({ id: "task-1", logPath: "/tmp/t1.log" }),
		createTask({ id: "task-2", logPath: "/tmp/t2.log" }),
	]);

	assert.deepEqual(reduceTaskSelector(state, { type: "cancel" }), {
		status: "cancelled",
	});

	const opened = expectOpenState(
		reduceTaskSelector(state, { type: "confirm" }),
	);
	const movedInDetail = expectOpenState(
		reduceTaskSelector(opened, { type: "down" }),
	);
	assert.equal(movedInDetail.detailTaskId, "task-1");
});

test("formatRuntime renders seconds, minutes, and hours", () => {
	assert.equal(formatRuntime(0), "0s");
	assert.equal(formatRuntime(24_000), "24s");
	assert.equal(formatRuntime(65_000), "1m 5s");
	assert.equal(formatRuntime(3_661_000), "1h 1m 1s");
	assert.equal(formatRuntime(-5_000), "0s");
});

test("formatTaskStatus covers running, stopping, and done variants", () => {
	const base = createTask({ id: "task-1", logPath: "/tmp/t1.log" });

	assert.equal(formatTaskStatus(base), "running");
	assert.equal(formatTaskStatus({ ...base, killed: true }), "stopping");
	assert.equal(
		formatTaskStatus({ ...base, status: "done", exitCode: 0 }),
		"done (exit 0)",
	);
	assert.equal(
		formatTaskStatus({ ...base, status: "done", signal: "SIGTERM" }),
		"done (signal SIGTERM)",
	);
	assert.equal(
		formatTaskStatus({ ...base, status: "done", timedOut: true }),
		"done (timed out)",
	);
});

test("list render shows content, status, and runtime without the task id", () => {
	const now = new Date("2026-05-22T10:05:00.000Z");
	const rendered = renderTaskList(
		createTaskSelectorState([
			createTask({
				id: "task-1",
				logPath: "/tmp/t1.log",
				description: "background nap",
				startedAt: now.getTime() - 24_000,
			}),
			createTask({
				id: "task-2",
				logPath: "/tmp/t2.log",
				startedAt: now.getTime() - 65_000,
			}),
			createTask({
				id: "task-3",
				logPath: "/tmp/t3.log",
				startedAt: now.getTime() - 120_000,
				status: "done",
				exitCode: 0,
				endedAt: now.getTime() - 30_000,
			}),
		]),
		100,
		now,
	);

	const lines = rendered.split("\n");
	assert.ok(lines.some((line) => line.includes("Background tasks:")));
	// Described tasks lead with their label; described-less tasks with their
	// command. Status and runtime follow. The id never appears.
	assert.ok(lines.some((line) => line.startsWith("> background nap")));
	assert.ok(lines.some((line) => line.includes("running")));
	assert.ok(lines.some((line) => line.includes("24s")));
	assert.ok(lines.some((line) => line.startsWith("  bash task-2.sh 2>&1")));
	assert.ok(lines.some((line) => line.includes("1m 5s")));
	assert.ok(
		lines.some((line) => line.includes("done (exit 0)")),
		"finished task shows its status",
	);
	assert.ok(
		lines.some((line) => line.includes("1m 30s")),
		"finished task shows its frozen runtime, not the time since start",
	);
	assert.ok(
		!lines.some((line) => /^[> ] task-\d/.test(line)),
		"task ids are not displayed",
	);
	assert.ok(
		lines.some((line) => line.includes("Enter to view details, Esc or Ctrl+C")),
	);
});

test("taskRuntimeMs freezes once a task finishes and keeps counting while running", () => {
	const now = new Date("2026-05-22T10:05:00.000Z");
	const later = new Date(now.getTime() + 60_000);

	const done = createTask({
		id: "task-1",
		logPath: "/tmp/t1.log",
		startedAt: now.getTime() - 120_000,
		status: "done",
		exitCode: 0,
		endedAt: now.getTime() - 30_000,
	});
	assert.equal(taskRuntimeMs(done, later), 90_000, "timer stops at endedAt");

	const running = createTask({
		id: "task-2",
		logPath: "/tmp/t2.log",
		startedAt: now.getTime() - 24_000,
	});
	assert.equal(taskRuntimeMs(running, later), 84_000, "timer keeps counting");
});

test("detail render follows the reference layout (status, runtime, command, boxed output)", async () => {
	const logPath = path.join(
		await createTempDir("sigpi-tasks-detail-"),
		"t1.log",
	);
	writeFileSync(
		logPath,
		[
			"[heartbeat] started at 18:49:22, will exit after 60s (pid 3831)",
			"[heartbeat] 18:49:22 tick 00:00/60s alive",
			"[heartbeat] 18:49:27 tick 00:05/60s alive",
			"[heartbeat] 18:49:32 tick 00:10/60s alive",
			"[heartbeat] 18:49:37 tick 00:15/60s alive",
			"[heartbeat] 18:49:42 tick 00:20/60s alive",
		].join("\n"),
		"utf8",
	);

	const now = new Date("2026-05-22T10:05:00.000Z");
	const state = createTaskSelectorState([
		createTask({
			id: "task-1",
			logPath,
			command: "bash /tmp/heartbeat-demo.sh 2>&1",
			startedAt: now.getTime() - 24_000,
		}),
	]);
	const opened = expectOpenState(
		reduceTaskSelector(state, { type: "confirm" }),
	);
	const rendered = renderTaskDetail(opened, 100, 24, now);

	assert.equal(
		rendered.length,
		24,
		"detail page fits the terminal height exactly (footer included)",
	);
	assert.ok(rendered.some((line) => line.includes("Shell details")));
	assert.ok(rendered.some((line) => line.includes("Status: running")));
	assert.ok(rendered.some((line) => line.includes("Runtime: 24s")));
	assert.ok(rendered.some((line) => line.includes("Id: task-1")));
	assert.ok(
		rendered.some((line) =>
			line.includes("Command: bash /tmp/heartbeat-demo.sh 2>&1"),
		),
	);
	assert.ok(rendered.some((line) => line.includes("Output:")));
	assert.ok(rendered.some((line) => line.includes("╭")));
	assert.ok(rendered.some((line) => line.includes("│")));
	assert.ok(rendered.some((line) => line.includes("╰")));
	assert.ok(
		rendered.some((line) =>
			line.includes("[heartbeat] 18:49:42 tick 00:20/60s"),
		),
	);
	assert.ok(rendered.some((line) => line.includes("Showing 6 lines")));
	assert.ok(
		rendered.some((line) =>
			line.includes("← to go back · Esc/Enter/Space to close · k to kill"),
		),
	);
});

test("detail output box shows the log tail, wraps long lines, and reports the count", async () => {
	const logPath = path.join(await createTempDir("sigpi-tasks-tail-"), "t.log");
	writeFileSync(
		logPath,
		Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
		"utf8",
	);
	const longLine = "x".repeat(200);

	const state = createTaskSelectorState([
		createTask({ id: "task-1", logPath }),
	]);
	const opened = expectOpenState(
		reduceTaskSelector(state, { type: "confirm" }),
	);
	const rendered = renderTaskDetail(opened, 80, 24);

	// The tail is what shows: the last log line appears, the first does not
	// ("line 10".."line 15" are in the tail, but standalone "line 1" is not).
	assert.ok(rendered.some((line) => line.includes("line 20")));
	assert.ok(!rendered.some((line) => /\bline 1\b/.test(line)), "tail only");
	const showing = rendered.find((line) => line.startsWith("Showing ")) ?? "";
	const shown = Number(showing.match(/Showing (\d+) lines/)?.[1] ?? 0);
	assert.ok(shown > 0 && shown < 20, "only the lines that fit are counted");

	// Every box row fits within the terminal width (long lines wrap).
	const longLogPath = path.join(
		await createTempDir("sigpi-tasks-wrap-"),
		"t.log",
	);
	writeFileSync(longLogPath, longLine, "utf8");
	const wrapped = renderTaskDetail(
		expectOpenState(
			reduceTaskSelector(
				createTaskSelectorState([
					createTask({ id: "task-2", logPath: longLogPath }),
				]),
				{ type: "confirm" },
			),
		),
		40,
		24,
	);
	for (const line of wrapped) {
		assert.ok(
			line.length <= 40,
			`detail row exceeds width: ${JSON.stringify(line)}`,
		);
	}
});

test("full-screen picker render covers every terminal row", async () => {
	const logPath = path.join(await createTempDir("sigpi-tasks-cover-"), "t.log");
	writeFileSync(logPath, "output line\n", "utf8");
	const now = new Date("2026-05-22T10:05:00.000Z");

	const listLines = renderTaskSelectorFullScreen(
		createTaskSelectorState([
			createTask({ id: "task-1", logPath, startedAt: now.getTime() - 5_000 }),
		]),
		60,
		10,
		now,
	);
	assert.equal(listLines.length, 10, "one line per terminal row");
	for (const line of listLines) {
		assert.equal(visibleWidth(line), 60, "list row spans the full width");
	}

	const detailLines = renderTaskSelectorFullScreen(
		expectOpenState(
			reduceTaskSelector(
				createTaskSelectorState([
					createTask({
						id: "task-1",
						logPath,
						startedAt: now.getTime() - 5_000,
					}),
				]),
				{ type: "confirm" },
			),
		),
		60,
		10,
		now,
	);
	assert.equal(detailLines.length, 10, "one line per terminal row");
	for (const line of detailLines) {
		assert.equal(visibleWidth(line), 60, "detail row spans the full width");
	}
});

test("interactive picker: list, open details, kill, back, and close on the parent TUI", async () => {
	const terminal = new FakeTerminal();
	terminal.columns = 80;
	terminal.rows = 24;
	const tui = new TUI(terminal);
	tui.addChild(new BaseTextComponent(["BASE_ONE", "BASE_TWO"]));
	tui.start();
	// Wait for the base TUI's first render to flush, then snapshot the write
	// position: writes from here on must be the overlay composited over it
	// (base rows covered, never rewritten to the terminal).
	await waitForWrite(terminal, (lines) =>
		lines.some((line) => line.includes("BASE_ONE")),
	);
	const beforeOverlay = terminal.writes.length;

	const logPath = path.join(
		await createTempDir("sigpi-tasks-interactive-"),
		"t.log",
	);
	writeFileSync(logPath, "tick 00:00 alive\ntick 00:05 alive\n", "utf8");

	const now = Date.now();
	const tasks = [
		createTask({
			id: "task-1",
			logPath,
			description: "background nap",
			startedAt: now - 24_000,
		}),
		createTask({
			id: "task-2",
			logPath,
			startedAt: now - 65_000,
		}),
	];

	const killed: string[] = [];
	const selectionPromise = selectTaskInteractive(tasks, {
		parentTui: tui,
		killTask: (taskId) => {
			killed.push(taskId);
		},
	});

	// Let Pi-tui move focus to the overlay component, then wait for the list
	// to actually hit the terminal before asserting on what is on screen.
	await new Promise((resolve) => setTimeout(resolve, 20));
	await waitForWrite(terminal, (lines) =>
		lines.some((line) => line.includes("Background tasks:")),
	);

	const overlayLines = renderedLines(terminal.writes.slice(beforeOverlay));
	assert.ok(
		overlayLines.some((line) => line.includes("Background tasks:")),
		"list is rendered",
	);
	assert.ok(overlayLines.some((line) => line.includes("background nap")));
	assert.ok(overlayLines.some((line) => line.includes("bash task-2.sh 2>&1")));
	assert.ok(
		!overlayLines.some((line) => line.includes("BASE_ONE")),
		"base content is covered while the picker is open",
	);
	assert.ok(
		!overlayLines.some((line) => line.includes("BASE_TWO")),
		"base content is covered while the picker is open",
	);

	// Down arrow then Enter opens the second task's details.
	terminal.inputHandler?.("\x1B[B");
	terminal.inputHandler?.("\r");
	await waitForWrite(terminal, (lines) =>
		lines.some((line) => line.includes("Status: running")),
	);

	const linesAfterDetail = renderedLines(terminal.writes);
	assert.ok(
		linesAfterDetail.some((line) => line.includes("Status: running")),
		"detail page is rendered",
	);
	assert.ok(linesAfterDetail.some((line) => line.includes("Runtime: 1m 5s")));
	assert.ok(linesAfterDetail.some((line) => line.includes("Output:")));
	assert.ok(linesAfterDetail.some((line) => line.includes("tick 00:05 alive")));
	assert.ok(linesAfterDetail.some((line) => line.includes("k to kill")));

	// `k` kills the viewed task through the killTask callback.
	terminal.inputHandler?.("k");
	assert.deepEqual(killed, ["task-2"]);

	// Left arrow returns to the list without closing the picker.
	const beforeBack = terminal.writes.length;
	terminal.inputHandler?.("\x1B[D");
	await waitForWrite(terminal, () =>
		renderedLines(terminal.writes.slice(beforeBack)).some((line) =>
			line.includes("Background tasks:"),
		),
	);
	const backLines = renderedLines(terminal.writes.slice(beforeBack));
	assert.ok(
		backLines.some((line) => line.includes("Background tasks:")),
		"back to the list",
	);
	assert.ok(
		!backLines.some((line) => line.includes("Shell details:")),
		"detail page is gone",
	);

	// Re-open the details, then Esc closes the picker; it resolves with the
	// last-viewed task id.
	terminal.inputHandler?.("\r");
	await new Promise((resolve) => setTimeout(resolve, 50));
	terminal.inputHandler?.("\x1B");
	assert.equal(await selectionPromise, "task-2");

	// The parent TUI must survive the close: it must still show overlays and
	// route input (a second ProcessTerminal would pause stdin here and freeze
	// the REPL that owns this TUI).
	const probe = new TaskSelectorComponent(
		createTaskSelectorState([
			createTask({ id: "task-1", logPath, startedAt: now - 24_000 }),
		]),
	);
	let probeResult: string | null | undefined;
	probe.onResolve = (result) => {
		probeResult = result;
	};
	tui.showOverlay(probe, {
		anchor: "center",
		width: "100%",
		maxHeight: "100%",
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	terminal.inputHandler?.("\r");
	await new Promise((resolve) => setTimeout(resolve, 20));
	terminal.inputHandler?.("\x1B");
	await new Promise((resolve) => setTimeout(resolve, 20));

	assert.equal(probeResult, "task-1");

	tui.stop();
});

test("interactive picker handles Kitty CSI-u key encodings", async () => {
	const terminal = new FakeTerminal();
	terminal.columns = 80;
	terminal.rows = 24;
	const tui = new TUI(terminal);
	tui.addChild(new BaseTextComponent(["BASE"]));
	tui.start();

	const logPath = path.join(await createTempDir("sigpi-tasks-kitty-"), "t.log");
	writeFileSync(logPath, "out\n", "utf8");
	const tasks = [
		createTask({ id: "task-1", logPath }),
		createTask({ id: "task-2", logPath }),
	];

	const selectionPromise = selectTaskInteractive(tasks, { parentTui: tui });
	await new Promise((resolve) => setTimeout(resolve, 20));

	terminal.inputHandler?.("\x1b[1;1B"); // Kitty down arrow
	terminal.inputHandler?.("\x1b[13u"); // Kitty Enter
	await new Promise((resolve) => setTimeout(resolve, 50));

	const lines = renderedLines(terminal.writes);
	assert.ok(
		lines.some((line) => line.includes("Status: running")),
		"Kitty keys open the selected task's details",
	);

	terminal.inputHandler?.("\x1b[27u"); // Kitty Esc
	assert.equal(await selectionPromise, "task-2");

	tui.stop();
});

test("empty task list resolves immediately without opening a picker", async () => {
	const terminal = new FakeTerminal();
	const tui = new TUI(terminal);
	tui.addChild(new BaseTextComponent(["BASE"]));
	tui.start();

	assert.equal(await selectTaskInteractive([], { parentTui: tui }), null);

	tui.stop();
});

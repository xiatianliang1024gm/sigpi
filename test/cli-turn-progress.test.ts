import assert from "node:assert/strict";
import test from "node:test";
import { type Component, TUI } from "@earendil-works/pi-tui";
import {
	accumulateTurnStats,
	applyTurnProgress,
	createReplRunStats,
	formatReplRunSummary,
} from "../src/cli.js";
import type {
	AssistantMessageView,
	ReplView,
	ToolLineHandle,
} from "../src/tui/chat-renderer.js";
import type { StatusBarModel } from "../src/tui/status-bar.js";
import type { TurnProgressEvent } from "../src/types.js";
import { FakeTerminal } from "./helpers/fake-terminal.js";

/**
 * Faithful copy of `AssistantMessageComponent`'s `finalize()` contract: once
 * finalized, `appendContent`/`appendReasoning` silently drop further text.
 * Without this, the test would not catch the "conclusion dropped after the
 * first step finalized the shared component" regression.
 */
class FakeAssistantView implements AssistantMessageView {
	reasoning = "";
	content = "";
	private finalized = false;

	appendReasoning(text: string): void {
		if (this.finalized || !text) return;
		this.reasoning += text;
	}
	appendContent(text: string): void {
		if (this.finalized || !text) return;
		this.content += text;
	}
	finalize(): void {
		this.finalized = true;
	}
}

class FakeToolLineHandle implements ToolLineHandle {
	constructor(
		private readonly id: string,
		private readonly ops: string[],
	) {}

	finish(): void {
		this.ops.push(`tool-finish:${this.id}`);
	}
	fail(error: string): void {
		this.ops.push(`tool-fail:${this.id}:${error}`);
	}
}

/** Records the ordered child operations so we can assert render order. */
class RecordingReplView implements ReplView {
	readonly ops: string[] = [];
	readonly assistants: FakeAssistantView[] = [];
	readonly tui: TUI = new TUI(new FakeTerminal());

	getTuiInstance(): TUI {
		return this.tui;
	}

	beginAssistantMessage(): AssistantMessageView {
		const view = new FakeAssistantView();
		this.assistants.push(view);
		this.ops.push("answer");
		return view;
	}

	beginToolLine(id: string, label: string): ToolLineHandle {
		this.ops.push(`tool-start:${id}:${label}`);
		return new FakeToolLineHandle(id, this.ops);
	}

	start(): void {}
	stop(): void {}
	readInput(): Promise<string | null> {
		return Promise.resolve(null);
	}
	takeQueuedLines(): string[] {
		return [];
	}
	addUserMessage(): void {}
	beginTurn(): void {}
	endTurn(): void {}
	appendSystem(text: string, tone: "error" | "info" = "info"): void {
		this.ops.push(`system:${tone}:${text}`);
	}
	replaceTranscript(components: Component[]): void {
		this.ops.push(`transcript:${components.length}`);
	}
	setStatusBarModel(): void {}
	getStatusBarModel(): StatusBarModel | null {
		return null;
	}
	writeLine(): void {}
	writeError(): void {}
}

/**
 * Replays a multi-step turn that mirrors the reported session: several
 * tool-call steps followed by a separate final-answer model response.
 */
function replay(view: RecordingReplView): void {
	const events: TurnProgressEvent[] = [
		{ type: "model_request_started", step: 1 },
		{
			type: "model_delta",
			step: 1,
			contentDelta: "I'll explore the repo.",
		},
		{ type: "model_request_finished", step: 1 },
		{
			type: "tool_execution_started",
			step: 1,
			toolName: "bash",
			toolCallId: "tc-bash",
			message: "Run pwd",
		},
		{
			type: "tool_execution_finished",
			step: 1,
			toolName: "bash",
			toolCallId: "tc-bash",
			ok: true,
			elapsedMs: 1,
			result: "pwd",
		},
		{ type: "model_request_started", step: 2 },
		{
			type: "model_delta",
			step: 2,
			contentDelta: "Let me read the docs.",
		},
		{ type: "model_request_finished", step: 2 },
		{
			type: "tool_execution_started",
			step: 2,
			toolName: "read",
			toolCallId: "tc-read",
			message: "Read README",
		},
		{
			type: "tool_execution_finished",
			step: 2,
			toolName: "read",
			toolCallId: "tc-read",
			ok: true,
			elapsedMs: 1,
			result: "README",
		},
		{ type: "model_request_started", step: 3 },
		{
			type: "model_delta",
			step: 3,
			contentDelta: "Now the analysis.",
		},
		{ type: "model_request_finished", step: 3 },
		{
			type: "tool_execution_started",
			step: 3,
			toolName: "glob",
			toolCallId: "tc-glob",
			message: "Find docs",
		},
		{
			type: "tool_execution_finished",
			step: 3,
			toolName: "glob",
			toolCallId: "tc-glob",
			ok: true,
			elapsedMs: 1,
			result: "docs/adr/**/*.md",
		},
		// Final answer — a separate model response, content only, no tool calls.
		{ type: "model_request_started", step: 4 },
		{
			type: "model_delta",
			step: 4,
			contentDelta: "CONCLUSION: SigPi is a readable TS agent reference impl.",
		},
		{ type: "model_request_finished", step: 4 },
	];
	let current: AssistantMessageView | null = null;
	const toolLines = new Map<string, ToolLineHandle>();
	for (const event of events) {
		current = applyTurnProgress(view, event, current, toolLines);
	}
}

test("each agent step renders its own assistant component in order", () => {
	const view = new RecordingReplView();
	replay(view);

	// One component per model response (3 tool-call steps + 1 final answer).
	assert.equal(view.assistants.length, 4, "expected one component per step");
	// Chronological order: every answer is appended after the prior tools.
	// Tool lines are two-phase: start (label) then finish (result).
	assert.deepEqual(view.ops, [
		"answer", // step 1 text
		"tool-start:tc-bash:Run pwd",
		"tool-finish:tc-bash",
		"answer", // step 2 text
		"tool-start:tc-read:Read README",
		"tool-finish:tc-read",
		"answer", // step 3 text
		"tool-start:tc-glob:Find docs",
		"tool-finish:tc-glob",
		"answer", // step 4 final conclusion
	]);
});

test("the final conclusion is not dropped by an earlier finalize", () => {
	const view = new RecordingReplView();
	replay(view);

	const finalAnswer = view.assistants.at(-1);
	assert.ok(finalAnswer, "a component exists for the final answer");
	// This is the whole point: the bug left the last step's text appended to a
	// component finalized after step 1, where finalize() silently dropped it.
	assert.match(finalAnswer?.content, /CONCLUSION/);
});

test("a step with no text does not emit an empty assistant bubble", () => {
	const view = new RecordingReplView();
	const events: TurnProgressEvent[] = [
		{ type: "model_request_started", step: 1 },
		{ type: "model_request_finished", step: 1 },
		{
			type: "tool_execution_started",
			step: 1,
			toolName: "bash",
			toolCallId: "tc-bash",
			message: "Run pwd",
		},
		{
			type: "tool_execution_finished",
			step: 1,
			toolName: "bash",
			toolCallId: "tc-bash",
			ok: true,
			elapsedMs: 1,
			result: "pwd",
		},
		// Final answer only.
		{ type: "model_request_started", step: 2 },
		{ type: "model_delta", step: 2, contentDelta: "Done." },
		{ type: "model_request_finished", step: 2 },
	];
	let current: AssistantMessageView | null = null;
	const toolLines = new Map<string, ToolLineHandle>();
	for (const event of events) {
		current = applyTurnProgress(view, event, current, toolLines);
	}
	// Tool lines are two-phase: start + finish.
	assert.deepEqual(view.ops, [
		"tool-start:tc-bash:Run pwd",
		"tool-finish:tc-bash",
		"answer",
	]);
	assert.match(view.assistants.at(-1)?.content ?? "", /Done\./);
});

test("context_compacted renders a system message highlighting the window change", () => {
	const view = new RecordingReplView();
	let current: AssistantMessageView | null = null;
	const toolLines = new Map<string, ToolLineHandle>();

	current = applyTurnProgress(
		view,
		{ type: "model_delta", step: 1, contentDelta: "x" },
		current,
		toolLines,
	);
	current = applyTurnProgress(
		view,
		{
			type: "context_compacted",
			step: 1,
			tokensBefore: 12_345,
			tokensAfter: 6_789,
			trigger: "token",
		},
		current,
		toolLines,
	);

	assert.deepEqual(view.ops, [
		"answer",
		"system:info:Context compacted: context window 12.3K → 6.8K tokens.",
	]);
});

test("context_compacted without a token snapshot uses the plain notice", () => {
	const view = new RecordingReplView();
	applyTurnProgress(
		view,
		{
			type: "context_compacted",
			step: 1,
			tokensBefore: 0,
			tokensAfter: 0,
			trigger: "token",
		},
		null,
		new Map(),
	);
	assert.deepEqual(view.ops, ["system:info:Context compacted."]);
});

test("interrupt_requested renders a transcript line, not just the status bar", () => {
	const view = new RecordingReplView();
	applyTurnProgress(
		view,
		{
			type: "interrupt_requested",
			message: "Cancelling current model request",
			stage: "model",
		},
		null,
		new Map(),
	);
	assert.deepEqual(view.ops, ["system:info:Cancelling current model request"]);
});

test("turn_interrupted finalizes the assistant and renders a terminal message", () => {
	const view = new RecordingReplView();
	let current: AssistantMessageView | null = null;
	const toolLines = new Map<string, ToolLineHandle>();

	current = applyTurnProgress(
		view,
		{ type: "model_delta", step: 1, contentDelta: "partial" },
		current,
		toolLines,
	);
	current = applyTurnProgress(
		view,
		{
			type: "turn_interrupted",
			step: 1,
			elapsedMs: 1,
			stage: "model",
			usage: null,
		},
		current,
		toolLines,
	);

	assert.equal(current, null);
	// The terminal event must not spawn a new assistant bubble; it only
	// finalizes the in-flight one and appends the interruption notice.
	assert.deepEqual(view.ops, ["answer", "system:info:Turn interrupted."]);
	assert.equal(view.assistants.at(-1)?.content, "partial");
});

test("repl run stats sum elapsed time and usage across turns", () => {
	const stats = createReplRunStats();
	accumulateTurnStats(stats, {
		type: "turn_finished",
		step: 1,
		elapsedMs: 12_400,
		usage: {
			input: 2_200,
			output: 700,
			cacheRead: 100,
			cacheWrite: 50,
			totalTokens: 3_050,
		},
	});
	accumulateTurnStats(stats, {
		type: "turn_interrupted",
		step: 1,
		elapsedMs: 3_100,
		stage: "model",
		usage: {
			input: 800,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_000,
		},
	});
	assert.deepEqual(stats, {
		turnCount: 2,
		elapsedMs: 15_500,
		inputTokens: 3_000,
		outputTokens: 900,
		cacheReadTokens: 100,
		cacheWriteTokens: 50,
		totalTokens: 4_050,
	});
});

test("repl run stats still count elapsed time when the provider reports no usage", () => {
	const stats = createReplRunStats();
	accumulateTurnStats(stats, {
		type: "turn_finished",
		step: 1,
		elapsedMs: 500,
		// No `usage`: the provider omitted usage on the streaming path.
		usage: null,
	});
	assert.deepEqual(stats, {
		turnCount: 1,
		elapsedMs: 500,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
	});
});

test("repl run summary formats totals and omits the token segment without usage", () => {
	assert.equal(
		formatReplRunSummary({
			turnCount: 2,
			elapsedMs: 125_000,
			inputTokens: 3_000,
			outputTokens: 900,
			cacheReadTokens: 100,
			cacheWriteTokens: 50,
			totalTokens: 4_050,
		}),
		"Session: 2 turns · 2m 05s · 3.9K billed",
	);
	assert.equal(
		formatReplRunSummary({
			turnCount: 1,
			elapsedMs: 500,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
		}),
		"Session: 1 turn · 0s",
	);
	// An empty session prints nothing.
	assert.equal(formatReplRunSummary(createReplRunStats()), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import { applyTurnProgress } from "../src/cli.js";
import type {
	AssistantMessageView,
	ReplView,
} from "../src/tui/chat-renderer.js";
import type { TurnProgressEvent } from "../src/types.js";

/**
 * Faithful copy of `AssistantMessageComponent`'s `finalize()` contract: once
 * finalized, `appendContent`/`appendReasoning` silently drop further text.
 * Without this, the test would not catch the "conclusion dropped after the
 * first step finalized the shared component" regression.
 */
class FakeAssistantView implements AssistantMessageView {
	reasoning = "";
	content = "";
	private hasReasoning = false;
	private hasContent = false;
	private finalized = false;

	appendReasoning(text: string): void {
		if (this.finalized || !text) return;
		this.reasoning += text;
		this.hasReasoning = true;
	}
	appendContent(text: string): void {
		if (this.finalized || !text) return;
		this.content += text;
		this.hasContent = true;
	}
	finalize(): void {
		this.finalized = true;
	}
}

/** Records the ordered child operations so we can assert render order. */
class RecordingReplView implements ReplView {
	readonly ops: string[] = [];
	readonly assistants: FakeAssistantView[] = [];

	beginAssistantMessage(): AssistantMessageView {
		const view = new FakeAssistantView();
		this.assistants.push(view);
		this.ops.push("answer");
		return view;
	}
	addToolResult(rendered: string): void {
		this.ops.push(`tool:${rendered}`);
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
	appendSystem(): void {}
	setStatus(): void {}
	writeLine(): void {}
	writeError(): void {}
}

/**
 * Replays a multi-step turn that mirrors the reported session: several
 * tool-call steps followed by a separate final-answer model response.
 */
function replay(view: RecordingReplView): void {
	const events: TurnProgressEvent[] = [
		{ type: "model_request_started", step: 1, turnId: "t" },
		{
			type: "model_delta",
			step: 1,
			turnId: "t",
			contentDelta: "I'll explore the repo.",
		},
		{
			type: "model_request_finished",
			step: 1,
			turnId: "t",
			elapsedMs: 1,
			message: "Model returned tool calls",
		},
		{
			type: "tool_execution_finished",
			step: 1,
			turnId: "t",
			toolName: "bash",
			toolOk: true,
			toolResult: "pwd",
		},
		{ type: "model_request_started", step: 2, turnId: "t" },
		{
			type: "model_delta",
			step: 2,
			turnId: "t",
			contentDelta: "Let me read the docs.",
		},
		{
			type: "model_request_finished",
			step: 2,
			turnId: "t",
			elapsedMs: 1,
			message: "Model returned tool calls",
		},
		{
			type: "tool_execution_finished",
			step: 2,
			turnId: "t",
			toolName: "read",
			toolOk: true,
			toolResult: "README",
		},
		{ type: "model_request_started", step: 3, turnId: "t" },
		{
			type: "model_delta",
			step: 3,
			turnId: "t",
			contentDelta: "Now the analysis.",
		},
		{
			type: "model_request_finished",
			step: 3,
			turnId: "t",
			elapsedMs: 1,
			message: "Model returned tool calls",
		},
		{
			type: "tool_execution_finished",
			step: 3,
			turnId: "t",
			toolName: "glob",
			toolOk: true,
			toolResult: "docs/adr/**/*.md",
		},
		// Final answer — a separate model response, content only, no tool calls.
		{ type: "model_request_started", step: 4, turnId: "t" },
		{
			type: "model_delta",
			step: 4,
			turnId: "t",
			contentDelta: "CONCLUSION: SigPi is a readable TS agent reference impl.",
		},
		{
			type: "model_request_finished",
			step: 4,
			turnId: "t",
			elapsedMs: 1,
			message: "Model returned final answer",
		},
	];
	let current: AssistantMessageView | null = null;
	for (const event of events) {
		current = applyTurnProgress(view, event, current);
	}
}

test("each agent step renders its own assistant component in order", () => {
	const view = new RecordingReplView();
	replay(view);

	// One component per model response (3 tool-call steps + 1 final answer).
	assert.equal(view.assistants.length, 4, "expected one component per step");
	// Chronological order: every answer is appended after the prior tools.
	assert.deepEqual(view.ops, [
		"answer", // step 1 text
		"tool:• bash: pwd",
		"answer", // step 2 text
		"tool:• read: README",
		"answer", // step 3 text
		"tool:• glob: docs/adr/**/*.md",
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
	assert.match(finalAnswer!.content, /CONCLUSION/);
});

test("a step with no text does not emit an empty assistant bubble", () => {
	const view = new RecordingReplView();
	const events: TurnProgressEvent[] = [
		{ type: "model_request_started", step: 1, turnId: "t" },
		{
			type: "model_request_finished",
			step: 1,
			turnId: "t",
			elapsedMs: 1,
			message: "Model returned tool calls",
		},
		{
			type: "tool_execution_finished",
			step: 1,
			turnId: "t",
			toolName: "bash",
			toolOk: true,
			toolResult: "pwd",
		},
		// Final answer only.
		{ type: "model_request_started", step: 2, turnId: "t" },
		{ type: "model_delta", step: 2, turnId: "t", contentDelta: "Done." },
		{
			type: "model_request_finished",
			step: 2,
			turnId: "t",
			elapsedMs: 1,
			message: "Model returned final answer",
		},
	];
	let current: AssistantMessageView | null = null;
	for (const event of events) {
		current = applyTurnProgress(view, event, current);
	}
	// Only the final answer creates a component; the tool-only step adds none.
	assert.deepEqual(view.ops, ["tool:• bash: pwd", "answer"]);
	assert.match(view.assistants.at(-1)!.content, /Done\./);
});

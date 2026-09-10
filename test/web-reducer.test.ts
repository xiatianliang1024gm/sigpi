import assert from "node:assert/strict";
import test from "node:test";

/**
 * The browser reducer (`src/server/web/reducer.js`) is a verbatim port of
 * `applyTurnProgress` from `src/session/events.ts`; it ships to the client as a
 * plain ES module (no bundler). Load the compiled asset and drive it with a
 * lightweight fake transcript view to prove the SSE event semantics hold.
 */
const reducerUrl = new URL("../src/server/web/reducer.js", import.meta.url);

type Assistant = { reasoning: string; content: string; finalized: boolean };

async function loadReducer(): Promise<{
	applyTurnProgress: (
		view: unknown,
		event: Record<string, unknown>,
		current: unknown,
		toolLines: Map<string, unknown>,
	) => unknown;
	isTurnTerminalEvent: (event: Record<string, unknown>) => boolean;
}> {
	return (await import(reducerUrl.href)) as {
		applyTurnProgress: (
			view: unknown,
			event: Record<string, unknown>,
			current: unknown,
			toolLines: Map<string, unknown>,
		) => unknown;
		isTurnTerminalEvent: (event: Record<string, unknown>) => boolean;
	};
}

function makeView() {
	const assistants: Assistant[] = [];
	const log: string[] = [];
	const view = {
		beginAssistantMessage() {
			const assistant: Assistant = {
				reasoning: "",
				content: "",
				finalized: false,
			};
			assistants.push(assistant);
			return {
				appendReasoning(text: string) {
					if (!assistant.finalized) assistant.reasoning += text;
				},
				appendContent(text: string) {
					if (!assistant.finalized) assistant.content += text;
				},
				finalize() {
					assistant.finalized = true;
				},
			};
		},
		beginToolLine(id: string, label: string) {
			log.push(`start:${id}:${label}`);
			return {
				finish() {
					log.push(`finish:${id}`);
				},
				fail(error: string) {
					log.push(`fail:${id}:${error}`);
				},
			};
		},
		appendSystem(text: string, tone?: string) {
			log.push(`sys:${tone ?? "none"}:${text}`);
		},
	};
	return { view, assistants, log };
}

test("applyTurnProgress streams one assistant component per model response", async () => {
	const { applyTurnProgress } = await loadReducer();
	const { view, assistants } = makeView();
	const toolLines = new Map<string, unknown>();

	let current: unknown = null;
	current = applyTurnProgress(
		view,
		{ type: "model_delta", step: 1, contentDelta: "Hel" },
		current,
		toolLines,
	);
	current = applyTurnProgress(
		view,
		{ type: "model_delta", step: 1, contentDelta: "lo" },
		current,
		toolLines,
	);
	assert.equal(assistants.length, 1);
	assert.equal(assistants[0].content, "Hello");

	// A step boundary finalizes the component and starts a fresh one next step.
	current = applyTurnProgress(
		view,
		{ type: "model_request_finished", step: 1 },
		current,
		toolLines,
	);
	assert.equal(current, null);
	assert.equal(assistants[0].finalized, true);

	current = applyTurnProgress(
		view,
		{ type: "model_delta", step: 2, contentDelta: "done" },
		current,
		toolLines,
	);
	assert.equal(assistants.length, 2);
	assert.equal(assistants[1].content, "done");

	// A late delta for the finalized step 1 is dropped.
	current = applyTurnProgress(
		view,
		{ type: "model_delta", step: 1, contentDelta: "ignored" },
		current,
		toolLines,
	);
	assert.equal(assistants[0].content, "Hello");
});

test("applyTurnProgress resolves tool lines and fails stragglers on the terminal event", async () => {
	const { applyTurnProgress } = await loadReducer();
	const { view, log } = makeView();
	const toolLines = new Map<string, unknown>();

	applyTurnProgress(
		view,
		{
			type: "tool_execution_started",
			step: 1,
			toolName: "read",
			toolCallId: "t1",
			message: "Reading a.ts",
		},
		null,
		toolLines,
	);
	applyTurnProgress(
		view,
		{
			type: "tool_execution_finished",
			step: 1,
			toolName: "read",
			toolCallId: "t1",
			ok: true,
		},
		null,
		toolLines,
	);
	assert.deepEqual(log, ["start:t1:Reading a.ts", "finish:t1"]);
	assert.equal(toolLines.size, 0);

	// A tool that never finishes is failed when the turn ends.
	applyTurnProgress(
		view,
		{
			type: "tool_execution_started",
			step: 1,
			toolName: "bash",
			toolCallId: "t2",
			message: "Running tests",
		},
		null,
		toolLines,
	);
	applyTurnProgress(view, { type: "turn_failed", step: 1 }, null, toolLines);
	assert.deepEqual(log, [
		"start:t1:Reading a.ts",
		"finish:t1",
		"start:t2:Running tests",
		"fail:t2:interrupted",
	]);
});

test("applyTurnProgress surfaces interrupts, failures, and compactions as system lines", async () => {
	const { applyTurnProgress, isTurnTerminalEvent } = await loadReducer();
	const { view, log } = makeView();
	const toolLines = new Map<string, unknown>();

	applyTurnProgress(
		view,
		{
			type: "interrupt_requested",
			message: "Cancelling current model request",
		},
		null,
		toolLines,
	);
	applyTurnProgress(
		view,
		{
			type: "context_compacted",
			step: 2,
			tokensBefore: 12000,
			tokensAfter: 3000,
		},
		null,
		toolLines,
	);
	applyTurnProgress(
		view,
		{
			type: "tool_execution_finished",
			step: 2,
			toolName: "bash",
			toolCallId: "missing",
			ok: false,
			result: "boom",
		},
		null,
		toolLines,
	);
	applyTurnProgress(
		view,
		{ type: "turn_interrupted", step: 2 },
		null,
		toolLines,
	);

	assert.deepEqual(log, [
		"sys:info:Cancelling current model request",
		"sys:info:Context compacted: context window 12K → 3K tokens.",
		"sys:info:Turn interrupted.",
	]);

	assert.equal(isTurnTerminalEvent({ type: "turn_finished" }), true);
	assert.equal(isTurnTerminalEvent({ type: "turn_failed" }), true);
	assert.equal(isTurnTerminalEvent({ type: "model_delta" }), false);
});

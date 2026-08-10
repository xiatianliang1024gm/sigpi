import assert from "node:assert/strict";
import test from "node:test";

import {
	composeStatusBar,
	formatElapsed,
	getStatusEventLabel,
	type StatusBarModel,
} from "../src/tui/status-bar.js";
import type { TurnProgressEvent } from "../src/types.js";

/**
 * The status bar must never look idle while a turn is in flight: every
 * in-turn event maps to a visible "working"/"thinking" style label, and
 * "done" is reserved for the actual end of the turn. This matters because
 * tool execution previously reported "done" and several phases (streaming
 * deltas, tool dispatch) reported nothing at all.
 */

const inTurnEvents: TurnProgressEvent[] = [
	{ type: "turn_started", turnId: "t", userInput: "hi" },
	{ type: "step_started", step: 1 },
	{ type: "model_request_started", step: 1 },
	{ type: "model_delta", step: 1, contentDelta: "x" },
	{ type: "model_request_finished", step: 1 },
	{ type: "assistant_message", step: 1, text: "note" },
	{
		type: "context_compacted",
		step: 1,
		tokensBefore: 100,
		tokensAfter: 50,
		trigger: "token",
	},
	{ type: "tool_calls_received", step: 1, count: 1 },
	{
		type: "tool_execution_started",
		step: 1,
		toolName: "bash",
		toolCallId: "tc",
		message: "Run pwd",
	},
	{
		type: "tool_execution_finished",
		step: 1,
		toolName: "bash",
		toolCallId: "tc",
		ok: true,
		elapsedMs: 1,
	},
];

test("every in-turn event gets a visible label (working/thinking/checkpoint)", () => {
	for (const event of inTurnEvents) {
		const label = getStatusEventLabel(event);
		assert.ok(label, `expected a label for ${event.type}, got null`);
		assert.notEqual(
			label,
			"done",
			`${event.type} must not claim the turn is done`,
		);
	}
});

test("model generation phases map to thinking", () => {
	assert.equal(
		getStatusEventLabel({ type: "model_request_started", step: 1 }),
		"thinking",
	);
	assert.equal(
		getStatusEventLabel({ type: "model_delta", step: 1, contentDelta: "x" }),
		"thinking",
	);
});

test("tool execution maps to working, not done", () => {
	assert.equal(
		getStatusEventLabel({
			type: "tool_execution_started",
			step: 1,
			toolName: "bash",
			toolCallId: "tc",
			message: "Run pwd",
		}),
		"working",
	);
	assert.equal(
		getStatusEventLabel({
			type: "tool_execution_finished",
			step: 1,
			toolName: "bash",
			toolCallId: "tc",
			ok: true,
			elapsedMs: 1,
		}),
		"working",
	);
});

test("done is only reported when the turn actually finishes", () => {
	assert.equal(
		getStatusEventLabel({
			type: "turn_finished",
			step: 1,
			elapsedMs: 1,
			usage: null,
		}),
		"done",
	);
});

test("terminal states keep their explicit labels", () => {
	assert.equal(
		getStatusEventLabel({
			type: "turn_interrupted",
			step: 1,
			elapsedMs: 1,
			stage: "model",
			usage: null,
		}),
		"interrupted",
	);
	assert.equal(
		getStatusEventLabel({
			type: "turn_max_steps_reached",
			step: 1,
			elapsedMs: 1,
			usage: null,
		}),
		"max steps",
	);
	assert.equal(
		getStatusEventLabel({
			type: "turn_failed",
			step: 1,
			elapsedMs: 1,
			failureType: "Error",
			message: "boom",
			usage: null,
		}),
		"failed",
	);
	assert.equal(
		getStatusEventLabel({
			type: "context_compacted",
			step: 1,
			tokensBefore: 100,
			tokensAfter: 50,
			trigger: "token",
		}),
		"compacted",
	);
	assert.equal(
		getStatusEventLabel({
			type: "interrupt_requested",
			stage: "model",
			message: "cancelling",
		}),
		"cancelling",
	);
	assert.equal(
		getStatusEventLabel({
			type: "interrupt_requested",
			stage: "tool",
			message: "waiting",
		}),
		"interrupt requested",
	);
});

test("no event means no label (idle bar)", () => {
	assert.equal(getStatusEventLabel(null), null);
});

function model(overrides: Partial<StatusBarModel> = {}): StatusBarModel {
	return {
		modelName: "test-model",
		limit: 100_000,
		usedTokens: 1_000,
		usage: null,
		cwd: "/work",
		branch: "main",
		...overrides,
	};
}

test("formatElapsed renders whole seconds, then minutes and seconds", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(2_000), "2s");
	assert.equal(formatElapsed(59_999), "59s");
	assert.equal(formatElapsed(60_000), "1m 00s");
	assert.equal(formatElapsed(125_000), "2m 05s");
	assert.equal(formatElapsed(-5), "0s");
});

test("live turn clock advances with the render time, not the model", () => {
	const bar = model({ eventLabel: "thinking", turnStartedAt: 1_000 });
	assert.equal(
		composeStatusBar(bar, 3_000),
		"test-model | 1K/100K (1%) | /work (main) | thinking · 2s",
	);
	assert.equal(
		composeStatusBar(bar, 5_500),
		"test-model | 1K/100K (1%) | /work (main) | thinking · 4s",
	);
});

test("a completed turn freezes elapsed time and shows billed tokens", () => {
	const bar = model({
		eventLabel: "done",
		lastTurnStats: {
			label: "done",
			elapsedMs: 12_400,
			tokens: {
				input: 2_200,
				output: 700,
				cacheRead: 100,
				cacheWrite: 50,
				totalTokens: 3_050,
			},
		},
	});
	assert.equal(
		composeStatusBar(bar),
		"test-model | 1K/100K (1%) | /work (main) | done · 12s · 2.9K billed",
	);
});

test("a completed turn without provider usage omits the token segment", () => {
	const bar = model({
		eventLabel: "interrupted",
		lastTurnStats: { label: "interrupted", elapsedMs: 3_000, tokens: null },
	});
	assert.equal(
		composeStatusBar(bar),
		"test-model | 1K/100K (1%) | /work (main) | interrupted · 3s",
	);
});

test("the live clock takes precedence over last-turn stats while a turn runs", () => {
	const bar = model({
		eventLabel: "working",
		turnStartedAt: 10_000,
		lastTurnStats: { label: "done", elapsedMs: 5_000, tokens: null },
	});
	assert.equal(
		composeStatusBar(bar, 12_000),
		"test-model | 1K/100K (1%) | /work (main) | working · 2s",
	);
});

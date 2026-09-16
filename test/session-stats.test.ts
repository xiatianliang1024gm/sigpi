import assert from "node:assert/strict";
import test from "node:test";
import {
	derivePersistedStats,
	SessionStatsTracker,
} from "../src/server/session-stats.js";
import type { SessionEntry, TurnProgressEvent } from "../src/types.js";

/** A minimal message entry; only the fields the derivation reads are set. */
function entry(
	role: "user" | "assistant" | "tool",
	usage?: Record<string, number>,
): SessionEntry {
	return {
		kind: "message",
		id: `${role}-${Math.random()}`,
		turnId: "t1",
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role, content: "" },
		...(usage ? { usage } : {}),
	} as unknown as SessionEntry;
}

test("derivePersistedStats counts turns, steps and sums usage", () => {
	const stats = derivePersistedStats([
		entry("user"),
		entry("assistant", {
			input: 100,
			output: 20,
			cacheRead: 50,
			cacheWrite: 5,
			totalTokens: 175,
		}),
		entry("tool"),
		entry("user"),
		entry("assistant", {
			input: 200,
			output: 30,
			cacheRead: 60,
			cacheWrite: 0,
			totalTokens: 290,
		}),
		// A compaction entry is not a turn/step and its usage is the summarize call.
		{ kind: "compaction", id: "c1", usage: { input: 1, output: 1 } },
	] as unknown as SessionEntry[]);

	assert.equal(stats.turns, 2);
	assert.equal(stats.steps, 2);
	assert.equal(stats.inputTokens, 300);
	assert.equal(stats.outputTokens, 50);
	assert.equal(stats.cacheReadTokens, 110);
	assert.equal(stats.cacheWriteTokens, 5);
	assert.equal(stats.totalTokens, 465);
});

/** A fake progress source that hands back its listener so tests can emit. */
function fakeSource() {
	let listener: ((event: TurnProgressEvent) => void) | null = null;
	const source = {
		onProgress(fn: (event: TurnProgressEvent) => void) {
			listener = fn;
			return () => {
				listener = null;
			};
		},
	};
	return {
		source,
		emit(event: TurnProgressEvent) {
			listener?.(event);
		},
	};
}

test("SessionStatsTracker measures LLM, tool and first-token timings", () => {
	const { source, emit } = fakeSource();
	let clock = 1000;
	const tracker = new SessionStatsTracker(source, () => clock);

	clock = 1000;
	emit({ type: "model_request_started", step: 1 });
	clock = 1500;
	emit({ type: "model_delta", step: 1, contentDelta: "hi" });
	// A second delta must not be counted as another first token.
	clock = 2000;
	emit({ type: "model_delta", step: 1, contentDelta: "!" });
	clock = 4000;
	emit({ type: "model_request_finished", step: 1 });

	clock = 4100;
	emit({
		type: "tool_execution_finished",
		step: 1,
		toolName: "read",
		toolCallId: "c1",
		elapsedMs: 900,
		ok: true,
	});
	emit({ type: "turn_finished", step: 1, elapsedMs: 5000, usage: null });

	const snap = tracker.snapshot();
	assert.equal(snap.llmMs, 3000);
	assert.equal(snap.toolMs, 900);
	assert.equal(snap.firstTokenAvgMs, 500);
	// No output tokens were reported, so the rate is not claimed.
	assert.equal(snap.tokensPerSecond, null);
	tracker.dispose();
});

test("SessionStatsTracker averages first-token latency and derives the rate", () => {
	const { source, emit } = fakeSource();
	let clock = 0;
	const tracker = new SessionStatsTracker(source, () => clock);

	// Request 1: first token at 400ms, finishes at 1000ms, 300 output tokens.
	emit({ type: "model_request_started", step: 1 });
	clock = 400;
	emit({ type: "model_delta", step: 1, contentDelta: "a" });
	clock = 1000;
	emit({ type: "model_request_finished", step: 1 });
	emit({
		type: "turn_finished",
		step: 1,
		elapsedMs: 1000,
		usage: {
			input: 0,
			output: 300,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 300,
		},
	});

	// Request 2: first token at 600ms, finishes at 2000ms, 500 output tokens.
	emit({ type: "model_request_started", step: 2 });
	clock = 1600;
	emit({ type: "model_delta", step: 2, contentDelta: "b" });
	clock = 2000;
	emit({ type: "model_request_finished", step: 2 });
	emit({
		type: "turn_finished",
		step: 2,
		elapsedMs: 1000,
		usage: {
			input: 0,
			output: 500,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 500,
		},
	});

	const snap = tracker.snapshot();
	// First-token latencies 400ms + 600ms → mean 500ms.
	assert.equal(snap.firstTokenAvgMs, 500);
	// 800 output tokens over the two 1000ms requests (2000ms of measured time).
	assert.equal(snap.llmMs, 2000);
	assert.equal(snap.tokensPerSecond, 800 / 2);
	tracker.dispose();
});

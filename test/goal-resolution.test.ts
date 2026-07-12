import assert from "node:assert/strict";
import test from "node:test";
import {
	collectGoalCandidates,
	extractFirstFinding,
	extractGoalFromSummary,
	findPreviousUserGoal,
	isContinuationInput,
	resolveCurrentGoal,
} from "../src/agent/goal-resolution.js";
import type { Message } from "../src/types.js";

function user(content: string): Message {
	return { role: "user", content };
}

test("isContinuationInput recognizes bare continuations in several languages", () => {
	assert.equal(isContinuationInput("continue"), true);
	assert.equal(isContinuationInput("继续"), true);
	assert.equal(isContinuationInput("继续吧"), true);
	assert.equal(isContinuationInput("go on"), true);
	assert.equal(isContinuationInput("keep going"), true);
	assert.equal(isContinuationInput("  Go On  "), true);
	assert.equal(isContinuationInput("GO ON"), true);
});

test("isContinuationInput rejects real goals", () => {
	assert.equal(isContinuationInput("fix the login bug"), false);
	assert.equal(isContinuationInput("继续实现搜索功能"), false);
});

test("extractGoalFromSummary pulls the Goal section", () => {
	const summary = [
		"## Goal",
		"Analyze the auth module",
		"",
		"## Next Steps",
		"1. Read the file",
	].join("\n");
	assert.equal(extractGoalFromSummary(summary), "Analyze the auth module");
});

test("extractGoalFromSummary returns null without a Goal section", () => {
	assert.equal(extractGoalFromSummary(null), null);
	assert.equal(extractGoalFromSummary("just some notes"), null);
});

test("findPreviousUserGoal skips continuation inputs", () => {
	const messages: Message[] = [
		user("real task here"),
		user("继续"),
		{ role: "assistant", content: "ok" },
	];
	assert.equal(findPreviousUserGoal(messages), "real task here");
});

test("findPreviousUserGoal returns null when no real goal exists", () => {
	const messages: Message[] = [
		user("继续"),
		{ role: "assistant", content: "ok" },
	];
	assert.equal(findPreviousUserGoal(messages), null);
});

test("extractFirstFinding returns the first non-blank finding", () => {
	assert.equal(extractFirstFinding(["first", "second"]), "first");
	assert.equal(extractFirstFinding(["", "  ", "real"]), "real");
	assert.equal(extractFirstFinding([]), null);
	assert.equal(extractFirstFinding(undefined), null);
});

test("collectGoalCandidates ranks summary, ledger finding, then previous goal", () => {
	const candidates = collectGoalCandidates({
		summary: "## Goal\nSummarized goal",
		keyFindings: ["a ledger finding"],
		recentMessages: [user("previous real goal")],
	});
	assert.deepEqual(candidates, [
		"Summarized goal",
		"a ledger finding",
		"previous real goal",
	]);
});

test("collectGoalCandidates omits empty sources", () => {
	const candidates = collectGoalCandidates({
		summary: null,
		keyFindings: undefined,
		recentMessages: [user("only this one")],
	});
	assert.deepEqual(candidates, ["only this one"]);
});

test("resolveCurrentGoal returns a non-continuation input unchanged", () => {
	assert.equal(
		resolveCurrentGoal("implement the parser", {
			summary: null,
			keyFindings: undefined,
			recentMessages: [],
		}),
		"implement the parser",
	);
});

test("resolveCurrentGoal resolves a continuation to the highest-ranked candidate", () => {
	assert.equal(
		resolveCurrentGoal("继续", {
			summary: "## Goal\nSummarized goal",
			keyFindings: ["ledger finding"],
			recentMessages: [user("explicit previous goal")],
		}),
		"Summarized goal",
	);
});

test("resolveCurrentGoal falls back to the trimmed input with no candidates", () => {
	assert.equal(
		resolveCurrentGoal("  继续  ", {
			summary: null,
			keyFindings: undefined,
			recentMessages: [user("继续")],
		}),
		"继续",
	);
});

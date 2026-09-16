#!/usr/bin/env node
/**
 * Offline replay of a stored session through the micro-compaction planner.
 *
 * Answers "did the compaction change help?" without a single model call: the
 * tool-result view of a request is a pure function of the stored messages, so
 * the previous algorithm and the current one can both be replayed over the same
 * history and compared on the metrics that matter.
 *
 * Metrics, per variant:
 *
 * - **in-turn elided** — tokens of the *running turn's own* tool results that
 *   the request dropped. This is the number the refactor set out to drive down:
 *   the reported session lost 55,879 of them inside one implementation turn,
 *   and the model re-read the files it had just fetched.
 * - **cross-turn elided** — tokens of earlier turns' results dropped.
 * - **repeat reads** — read calls whose identical (path, offset, limit) had
 *   already been elided from the request the model was answering.
 * - **redundant share** — share of tool-result tokens in the history that are
 *   older copies of a range already present (reported as a property of the
 *   history, not as something the planner acts on: the planner deliberately
 *   does not model file identity).
 * - **stable prefix** — average tokens that render identically between a
 *   request and its predecessor within the same turn. This is the prompt-cache
 *   proxy: providers only pay out for a byte-stable prefix (DeepSeek matches
 *   persisted prefix units, Anthropic matches 64-token blocks), so higher is
 *   cheaper.
 * - **changed requests** — how often the prefix moved at all. Each of those is
 *   a potential cache miss.
 *
 * Usage:
 *   pnpm run test:compile
 *   node scripts/micro-compact-replay.mjs [session.jsonl ...]
 *
 * With no argument it replays the session that motivated the refactor, if that
 * file is still present.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
	MICRO_COMPACT_KEEP_TOOL_TOKENS,
	microCompactToolTokenBudget,
	planMicroCompaction,
} from "../dist/src/agent/compaction.js";
import { estimateMessageTokens } from "../dist/src/context-window.js";

const DEFAULT_SESSION = path.join(
	homedir(),
	".sigpi",
	"projects",
	"sigpi-71bea5b7c1053ad0",
	"sessions",
	"d1fe8c21-18b2-487c-b52f-dd5838c4ae9e.jsonl",
);

/** The window the reported session ran on (default config). */
const SESSION_WINDOW_TOKENS = 200_000;

/**
 * Frozen copy of the algorithm this repository shipped before the refactor —
 * `git show HEAD:src/agent/compaction.ts` at the time of writing. Kept here
 * rather than in `src/` so the baseline cannot drift while the current planner
 * evolves: pin the newest batch, then keep tool results from the tail while the
 * token budget lasts, with no notion of turn or target identity.
 */
function legacyPlan(messages, budget) {
	const keep = new Array(messages.length).fill(false);
	let keptTokens = 0;
	let keptCount = 0;
	const toolIndexes = [];
	for (let index = 0; index < messages.length; index += 1) {
		if (messages[index]?.role === "tool") {
			toolIndexes.push(index);
		}
	}

	let pinnedCallIds = null;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant" && message.toolCalls?.length) {
			pinnedCallIds = new Set(message.toolCalls.map((call) => call.id));
			break;
		}
	}
	if (pinnedCallIds) {
		for (const index of toolIndexes) {
			if (pinnedCallIds.has(messages[index].toolCallId)) {
				keep[index] = true;
				keptCount += 1;
				keptTokens += estimateMessageTokens(messages[index]);
			}
		}
	}
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "tool" || keep[index]) {
			continue;
		}
		if (keptCount < 3 || keptTokens < budget) {
			keep[index] = true;
			keptCount += 1;
			keptTokens += estimateMessageTokens(message);
		}
	}

	const elidedIndexes = new Set();
	for (const index of toolIndexes) {
		if (!keep[index]) {
			elidedIndexes.add(index);
		}
	}
	return { elidedIndexes, budget };
}

function readSession(file) {
	return readFileSync(file, "utf8")
		.split(/\r?\n/u)
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.kind === "message")
		.map((entry) => ({
			turnId: entry.turnId ?? null,
			message: entry.message,
			usage: entry.usage,
		}));
}

/** What the provider would actually receive for one message. */
function render(message, plan, index) {
	if (message.role !== "tool" || !plan.elidedIndexes.has(index)) {
		return String(message.content ?? "");
	}
	return "[context-elided]";
}

function readKeyOf(call) {
	if (call?.name !== "read") {
		return null;
	}
	const args = call.arguments ?? {};
	return `${args.file_path ?? "?"}|${args.offset ?? "-"}|${args.limit ?? "-"}`;
}

function analyze(entries, planner) {
	const callsById = new Map();
	for (const { message } of entries) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const call of message.toolCalls ?? []) {
			callsById.set(call.id, call);
		}
	}

	const requests = [];
	entries.forEach((slot, index) => {
		if (slot.message.role !== "assistant" || !slot.usage) {
			return;
		}
		const prefix = entries.slice(0, index);
		const protectedToolCallIds = new Set(
			prefix
				.filter((candidate) => candidate.turnId === slot.turnId)
				.map((candidate) => candidate.message.toolCallId)
				.filter(Boolean),
		);
		const plan = planner(prefix.map((candidate) => candidate.message), {
			protectedToolCallIds,
		});
		requests.push({ slot, prefix, plan });
	});

	let inTurnElided = 0;
	let crossTurnElided = 0;
	let inTurnReal = 0;
	let crossTurnReal = 0;
	let elidedTotal = 0;
	let toolTokens = 0;
	let repeatReads = 0;
	const resultsSoFar = [];
	let last = null;

	for (const request of requests) {
		const elidedIds = new Set();
		let requestInTurn = 0;
		let requestCrossTurn = 0;
		let requestElidedCount = 0;
		request.prefix.forEach((candidate, prefixIndex) => {
			const message = candidate.message;
			if (message.role !== "tool") {
				return;
			}
			const tokens = estimateMessageTokens(message);
			toolTokens += tokens;
			if (!request.plan.elidedIndexes.has(prefixIndex)) {
				return;
			}
			elidedIds.add(message.toolCallId);
			elidedTotal += 1;
			requestElidedCount += 1;
			if (candidate.turnId === request.slot.turnId) {
				inTurnReal += tokens;
				inTurnElided += tokens;
				requestInTurn += tokens;
			} else {
				crossTurnReal += tokens;
				crossTurnElided += tokens;
				requestCrossTurn += tokens;
			}
		});

		// A read call whose identical range had already been elided from the
		// request being answered: the model is fetching text it once had.
		for (const call of request.slot.message.toolCalls ?? []) {
			const key = readKeyOf(call);
			if (!key) {
				continue;
			}
			const elidedPrior = resultsSoFar.some(
				(result) => result.key === key && elidedIds.has(result.toolCallId),
			);
			if (elidedPrior) {
				repeatReads += 1;
			}
		}
		request.prefix.forEach((candidate) => {
			if (candidate.message.role !== "tool") {
				return;
			}
			const key = readKeyOf(callsById.get(candidate.message.toolCallId));
			if (key) {
				resultsSoFar.push({ key, toolCallId: candidate.message.toolCallId });
			}
		});

		last = {
			elidedCount: requestElidedCount,
			inTurnElided: requestInTurn,
			crossTurnElided: requestCrossTurn,
			toolTokens: request.prefix
				.filter((candidate) => candidate.message.role === "tool")
				.reduce(
					(total, candidate) => total + estimateMessageTokens(candidate.message),
					0,
				),
			promptTokens: request.prefix.reduce(
				(total, candidate) => total + estimateMessageTokens(candidate.message),
				0,
			),
		};
	}

	// Information-free redundancy is a property of the history, not of the
	// planner: count every tool result that an identical later copy supersedes.
	const newestByKey = new Map();
	const byKey = new Map();
	entries.forEach((slot, index) => {
		if (slot.message.role !== "tool") {
			return;
		}
		const key = readKeyOf(callsById.get(slot.message.toolCallId));
		if (!key) {
			return;
		}
		newestByKey.set(key, index);
		byKey.set(key, [...(byKey.get(key) ?? []), slot.message]);
	});
	let historyToolTokens = 0;
	let redundantTokens = 0;
	for (const [, list] of byKey) {
		list.forEach((message, position) => {
			const tokens = estimateMessageTokens(message);
			historyToolTokens += tokens;
			if (position < list.length - 1) {
				redundantTokens += tokens;
			}
		});
	}

	// Prefix stability: the longest leading run of messages that renders
	// identically in consecutive requests, compared within a turn only (a new
	// turn changes the tail by construction, which no planner can prevent).
	let stableTotal = 0;
	let changedRequests = 0;
	let comparisons = 0;
	let lastStable = 0;
	for (let cursor = 1; cursor < requests.length; cursor += 1) {
		const previous = requests[cursor - 1];
		const current = requests[cursor];
		if (previous.slot.turnId !== current.slot.turnId) {
			continue;
		}
		comparisons += 1;
		const shared = Math.min(previous.prefix.length, current.prefix.length);
		let firstChanged = shared;
		for (let index = 0; index < shared; index += 1) {
			if (
				render(previous.prefix[index].message, previous.plan, index) !==
				render(current.prefix[index].message, current.plan, index)
			) {
				firstChanged = index;
				break;
			}
		}
		if (firstChanged < shared) {
			changedRequests += 1;
		}
		let stable = 0;
		for (let index = 0; index < firstChanged; index += 1) {
			stable += estimateMessageTokens(current.prefix[index].message);
		}
		stableTotal += stable;
	}

	return {
		requests: requests.length,
		toolTokens,
		elidedTotal,
		inTurnElided,
		crossTurnElided,
		inTurnReal,
		crossTurnReal,
		historyToolTokens,
		redundantShare:
			historyToolTokens > 0 ? redundantTokens / historyToolTokens : 0,
		repeatReads,
		stablePrefix: comparisons > 0 ? Math.round(stableTotal / comparisons) : 0,
		changedRequests,
		comparisons,
		budget: requests[0]?.plan.budget ?? 0,
		last,
	};
}

const variants = [
	{
		label: "before",
		run: (messages) => legacyPlan(messages, MICRO_COMPACT_KEEP_TOOL_TOKENS),
	},
	{
		label: `after (${MICRO_COMPACT_KEEP_TOOL_TOKENS / 1000}k flat)`,
		run: (messages, options) =>
			planMicroCompaction(messages, {
				keepToolTokens: MICRO_COMPACT_KEEP_TOOL_TOKENS,
				protectedToolCallIds: options.protectedToolCallIds,
			}),
	},
	{
		label: `after (${microCompactToolTokenBudget(SESSION_WINDOW_TOKENS) / 1000}k scaled)`,
		run: (messages, options) =>
			planMicroCompaction(messages, {
				keepToolTokens: microCompactToolTokenBudget(SESSION_WINDOW_TOKENS),
				protectedToolCallIds: options.protectedToolCallIds,
			}),
	},
];

const rows = [
	["tool budget", (state) => state.budget],
	["— at the last request —", () => ""],
	["tool tokens in history", (state) => state.last?.toolTokens ?? 0],
	["results elided", (state) => state.last?.elidedCount ?? 0],
	["real IN-TURN loss", (state) => state.last?.inTurnElided ?? 0],
	["real cross-turn loss", (state) => state.last?.crossTurnElided ?? 0],
	["— summed over requests —", () => ""],
	["real IN-TURN loss", (state) => state.inTurnReal],
	["real cross-turn loss", (state) => state.crossTurnReal],
	["repeat reads", (state) => state.repeatReads],
	["— prefix stability (same-turn) —", () => ""],
	["stable prefix tokens", (state) => state.stablePrefix],
	["prefix changed requests", (state) => state.changedRequests],
	["of comparisons", (state) => state.comparisons],
];

const files = process.argv.slice(2);
const targets = files.length
	? files
	: existsSync(DEFAULT_SESSION)
		? [DEFAULT_SESSION]
		: [];

if (targets.length === 0) {
	console.error("no session file to replay (pass one as an argument)");
	process.exit(1);
}

for (const file of targets) {
	const entries = readSession(file);
	const states = variants.map((variant) => ({
		label: variant.label,
		state: analyze(entries, variant.run),
	}));

	console.log(`\n=== ${path.basename(file)} ===`);
	console.log(
		`${states[0]?.state.requests} requests, ${states[0]?.state.historyToolTokens.toLocaleString("en-US")} tool-result tokens in the history`,
	);
	console.log(
		`information-free redundancy in that history: ${((states[0]?.state.redundantShare ?? 0) * 100).toFixed(1)}% (older copies of a range already present)\n`,
	);
	const width = 20;
	console.log(
		["metric".padEnd(26), ...states.map((state) => state.label.padStart(width))].join(" | "),
	);
	console.log("-".repeat(26 + states.length * (width + 3)));
	for (const [label, get] of rows) {
		console.log(
			[
				label.padEnd(26),
				...states.map((state) => String(get(state.state)).padStart(width)),
			].join(" | "),
		);
	}
}

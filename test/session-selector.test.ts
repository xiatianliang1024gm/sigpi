import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
	createSessionSelectorState,
	prepareSessionChoices,
	reduceSessionSelector,
	renderSessionSelectorWithWidth,
	selectSessionInteractive,
} from "../src/session-selector.js";
import type { SessionSummary } from "../src/types.js";

function createSessionSummary(
	overrides?: Partial<SessionSummary> &
		Pick<SessionSummary, "sessionId" | "updatedAt">,
): SessionSummary {
	return {
		sessionId: overrides?.sessionId ?? "11111111-1111-4111-8111-111111111111",
		title: overrides?.title === undefined ? "session" : overrides.title,
		lastCompletedUserInput:
			overrides?.lastCompletedUserInput === undefined
				? "recent user input"
				: overrides.lastCompletedUserInput,
		updatedAt: overrides?.updatedAt ?? "2026-05-22T00:00:00.000Z",
		status: overrides?.status ?? "active",
		cwd: overrides?.cwd ?? "/tmp/project",
		turnCount: overrides?.turnCount ?? 0,
		lastTurnStatus: overrides?.lastTurnStatus ?? null,
		estimatedTokens: overrides?.estimatedTokens ?? null,
	};
}

test("prepareSessionChoices sorts by updatedAt and limits results", () => {
	const sessions = [
		createSessionSummary({
			sessionId: "11111111-1111-4111-8111-111111111111",
			updatedAt: "2026-05-20T00:00:00.000Z",
		}),
		createSessionSummary({
			sessionId: "22222222-2222-4222-8222-222222222222",
			updatedAt: "2026-05-22T00:00:00.000Z",
		}),
		createSessionSummary({
			sessionId: "33333333-3333-4333-8333-333333333333",
			updatedAt: "2026-05-21T00:00:00.000Z",
		}),
	];

	const selected = prepareSessionChoices(sessions, 2);

	assert.deepEqual(
		selected.map((session) => session.sessionId),
		[
			"22222222-2222-4222-8222-222222222222",
			"33333333-3333-4333-8333-333333333333",
		],
	);
});

test("prepareSessionChoices sorts by absolute time when offsets differ", () => {
	const sessions = [
		createSessionSummary({
			sessionId: "11111111-1111-4111-8111-111111111111",
			updatedAt: "2026-05-22T00:30:00.000+08:00",
		}),
		createSessionSummary({
			sessionId: "22222222-2222-4222-8222-222222222222",
			updatedAt: "2026-05-21T20:00:00.000+00:00",
		}),
	];

	const selected = prepareSessionChoices(sessions, 2);

	assert.deepEqual(
		selected.map((session) => session.sessionId),
		[
			"22222222-2222-4222-8222-222222222222",
			"11111111-1111-4111-8111-111111111111",
		],
	);
});

test("prepareSessionChoices excludes sessions without a title", () => {
	const sessions = [
		createSessionSummary({
			sessionId: "11111111-1111-4111-8111-111111111111",
			updatedAt: "2026-05-22T00:00:00.000Z",
			title: null,
		}),
		createSessionSummary({
			sessionId: "22222222-2222-4222-8222-222222222222",
			updatedAt: "2026-05-21T00:00:00.000Z",
			title: "real question",
		}),
	];

	const selected = prepareSessionChoices(sessions);

	assert.deepEqual(
		selected.map((session) => session.sessionId),
		["22222222-2222-4222-8222-222222222222"],
	);
});

test("selector arrows change highlighted session", () => {
	const state = createSessionSelectorState([
		createSessionSummary({
			sessionId: "11111111-1111-4111-8111-111111111111",
			updatedAt: "2026-05-22T00:00:00.000Z",
		}),
		createSessionSummary({
			sessionId: "22222222-2222-4222-8222-222222222222",
			updatedAt: "2026-05-21T00:00:00.000Z",
		}),
	]);

	const movedDown = reduceSessionSelector(state, { type: "down" });
	assert.equal("selectedIndex" in movedDown ? movedDown.selectedIndex : -1, 1);

	const movedUp = reduceSessionSelector(
		"selectedIndex" in movedDown ? movedDown : state,
		{ type: "up" },
	);
	assert.equal("selectedIndex" in movedUp ? movedUp.selectedIndex : -1, 0);
});

test("selector enter returns the selected session id", () => {
	const state = createSessionSelectorState([
		createSessionSummary({
			sessionId: "11111111-1111-4111-8111-111111111111",
			updatedAt: "2026-05-22T00:00:00.000Z",
		}),
		createSessionSummary({
			sessionId: "22222222-2222-4222-8222-222222222222",
			updatedAt: "2026-05-21T00:00:00.000Z",
		}),
	]);

	const movedDown = reduceSessionSelector(state, { type: "down" });
	const resolved = reduceSessionSelector(
		"selectedIndex" in movedDown ? movedDown : state,
		{ type: "confirm" },
	);

	assert.deepEqual(resolved, {
		status: "selected",
		sessionId: "22222222-2222-4222-8222-222222222222",
	});
});

test("selector escape and ctrl+c cancel", () => {
	const state = createSessionSelectorState([
		createSessionSummary({
			sessionId: "11111111-1111-4111-8111-111111111111",
			updatedAt: "2026-05-22T00:00:00.000Z",
		}),
	]);

	assert.deepEqual(reduceSessionSelector(state, { type: "cancel" }), {
		status: "cancelled",
	});
});

test("selector render shows one line per session with message, relative time, and tokens", () => {
	const now = new Date("2026-05-22T10:05:00.000Z");
	const rendered = renderSessionSelectorWithWidth(
		createSessionSelectorState([
			createSessionSummary({
				sessionId: "aaaaaaaa-1111-4111-8111-111111111111",
				title: "find why parser skips the final token",
				updatedAt: "2026-05-22T10:00:00.000Z",
				estimatedTokens: 1800,
			}),
		]),
		100,
		now,
	);

	const lines = rendered.split("\n").filter((line) => line.startsWith("> "));
	assert.equal(lines.length, 1);
	assert.match(lines[0], /find why parser skips the final token/);
	assert.match(lines[0], /5 minutes ago/);
	assert.match(lines[0], /1\.8K/);
});

test("selector render truncates long message and shows em dash for missing tokens", () => {
	const now = new Date("2026-05-22T10:05:00.000Z");
	const rendered = renderSessionSelectorWithWidth(
		createSessionSelectorState([
			createSessionSummary({
				sessionId: "bbbbbbbb-1111-4111-8111-111111111111",
				title:
					"find why the parser skips the final token after a multiline string with trailing whitespace and comments",
				updatedAt: "2026-05-22T10:00:00.000Z",
				estimatedTokens: null,
			}),
		]),
		60,
		now,
	);

	const line = rendered.split("\n").find((l) => l.startsWith("> ")) ?? "";
	assert.match(line, /> find why the parser skips/);
	assert.match(line, /\.\.\./);
	assert.match(line, /5 minutes ago/);
	assert.match(line, /—/);
});

test("interactive selector resumes paused input and returns the confirmed session", async () => {
	class FakeInput extends PassThrough {
		public isTTY = true;
		public isRaw = false;
		public paused = false;

		setRawMode(value: boolean): this {
			this.isRaw = value;
			return this;
		}

		override pause(): this {
			this.paused = true;
			return super.pause() as this;
		}

		override resume(): this {
			this.paused = false;
			return super.resume() as this;
		}
	}

	class FakeOutput extends PassThrough {
		public isTTY = true;
		public columns = 100;
		public rows = 24;
	}

	const input = new FakeInput();
	const output = new FakeOutput();
	input.pause();

	const selectionPromise = selectSessionInteractive(
		[
			createSessionSummary({
				sessionId: "11111111-1111-4111-8111-111111111111",
				updatedAt: "2026-05-22T00:00:00.000Z",
			}),
		],
		{
			input: input as never,
			output: output as never,
		},
	);

	process.nextTick(() => {
		input.write("\r");
	});

	assert.equal(await selectionPromise, "11111111-1111-4111-8111-111111111111");
	assert.equal(input.isRaw, false);
	assert.equal(input.paused, true);
});

test("interactive selector handles raw arrow navigation and cancel", async () => {
	class FakeInput extends PassThrough {
		public isTTY = true;
		public isRaw = false;

		setRawMode(value: boolean): this {
			this.isRaw = value;
			return this;
		}
	}

	class FakeOutput extends PassThrough {
		public isTTY = true;
		public columns = 100;
		public rows = 24;
	}

	const input = new FakeInput();
	const output = new FakeOutput();
	const selectionPromise = selectSessionInteractive(
		[
			createSessionSummary({
				sessionId: "11111111-1111-4111-8111-111111111111",
				updatedAt: "2026-05-22T00:00:00.000Z",
			}),
			createSessionSummary({
				sessionId: "22222222-2222-4222-8222-222222222222",
				updatedAt: "2026-05-21T00:00:00.000Z",
			}),
		],
		{
			input: input as never,
			output: output as never,
		},
	);

	process.nextTick(() => {
		input.write("\x1B[B");
		input.write("\r");
	});

	assert.equal(await selectionPromise, "22222222-2222-4222-8222-222222222222");

	const cancelInput = new FakeInput();
	const cancelOutput = new FakeOutput();
	const cancelPromise = selectSessionInteractive(
		[
			createSessionSummary({
				sessionId: "11111111-1111-4111-8111-111111111111",
				updatedAt: "2026-05-22T00:00:00.000Z",
			}),
		],
		{
			input: cancelInput as never,
			output: cancelOutput as never,
		},
	);

	process.nextTick(() => {
		cancelInput.write("\x1B");
	});

	assert.equal(await cancelPromise, null);
});

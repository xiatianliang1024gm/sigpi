import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getDefaultSessionsRoot } from "../src/config.js";
import { deriveContextStateFromEntries } from "../src/session/format.js";
import {
	createProjectKey,
	resolveSessionStoragePaths,
} from "../src/session/paths.js";
import {
	createSystemPromptFingerprint,
	sessionToContextState,
} from "../src/session/store.js";
import {
	createTempDir,
	createTestSessionStore,
	createTestToolExecution,
	stripMessageIds,
} from "./helpers.js";

test("session storage paths derive a stable per-project bucket from cwd", () => {
	const first = resolveSessionStoragePaths({
		cwd: "/tmp/work/project-a",
		sessionsRoot: "/tmp/home/.sigpi/projects",
	});
	const second = resolveSessionStoragePaths({
		cwd: "/tmp/work/project-a",
		sessionsRoot: "/tmp/home/.sigpi/projects",
	});
	const other = resolveSessionStoragePaths({
		cwd: "/tmp/work/project-b",
		sessionsRoot: "/tmp/home/.sigpi/projects",
	});

	assert.equal(first.projectKey, second.projectKey);
	assert.equal(first.projectDir, second.projectDir);
	assert.notEqual(first.projectKey, other.projectKey);
	assert.equal(first.sessionsDir, path.join(first.projectDir, "sessions"));
	assert.equal(first.indexPath, path.join(first.projectDir, "index.json"));
});

test("session store persists and restores session state", async () => {
	const cwd = await createTempDir("sigpi-session-store-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const created = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		title: "test session",
		loadedSkillNames: ["doc-skill"],
		skillsFingerprint: "skills-fingerprint-1",
	});

	await store.markTurnStarted({
		sessionId: created.sessionId,
		userInput: "inspect repo",
	});
	await store.markTurnCompleted({
		sessionId: created.sessionId,
		userInput: "inspect repo",
		assistantOutput: "done",
		steps: 2,
		toolExecutions: [
			createTestToolExecution({
				toolCall: {
					id: "call_2",
					name: "grep",
					arguments: { pattern: "inspect repo" },
					rawArguments: '{"pattern":"inspect repo"}',
				},
				result: {
					ok: true,
					data: { matches: ["src/index.ts:1"] },
				},
			}),
		],
		contextState: {
			summary: "summary",
			recentMessages: [
				{ role: "user", content: "inspect repo" },
				{ role: "assistant", content: "done" },
			],
			explorationLedger: {
				searchedQueries: [
					{
						query: "inspect repo",
						glob: null,
						output: "files",
						caseSensitive: null,
						resultCount: 1,
						truncated: false,
						repeatedCount: 1,
					},
				],
				candidateFiles: ["src/index.ts"],
				readRanges: [],
				rejectedPaths: [],
				keyFindings: [],
				modifiedFiles: [],
			},
		},
	});

	const loaded = await store.loadSession({
		sessionId: created.sessionId,
		cwd,
		systemPromptFingerprint: fingerprint,
	});

	assert.equal(loaded.warnings.length, 0);
	assert.equal(loaded.session.version, 4);
	assert.deepEqual(loaded.session.loadedSkillNames, ["doc-skill"]);
	assert.equal(loaded.session.skillsFingerprint, "skills-fingerprint-1");
	assert.equal(loaded.session.turnCount, 1);
	assert.equal(
		deriveContextStateFromEntries(loaded.session.entries).summary,
		"summary",
	);
	assert.equal(loaded.session.lastTurn?.status, "completed");
	assert.equal(loaded.session.turns.length, 1);
	assert.equal(loaded.session.turns[0]?.status, "completed");
	assert.equal(loaded.session.turns[0]?.steps, 2);
	assert.equal(loaded.session.turns[0]?.toolExecutions.length, 1);
	assert.deepEqual(loaded.session.explorationLedger?.candidateFiles, [
		"src/index.ts",
	]);
	assert.deepEqual(loaded.session.turns[0]?.toolExecutions[0]?.result.data, {
		matches: ["src/index.ts:1"],
	});
	const derivedState = sessionToContextState(loaded.session);
	assert.equal(derivedState.summary, "summary");
	assert.deepEqual(stripMessageIds(derivedState.recentMessages), [
		{ role: "user", content: "inspect repo" },
		{ role: "assistant", content: "done" },
	]);
	assert.deepEqual(derivedState.explorationLedger, {
		searchedQueries: [
			{
				query: "inspect repo",
				glob: null,
				output: "files",
				caseSensitive: null,
				resultCount: 1,
				truncated: false,
				repeatedCount: 1,
			},
		],
		candidateFiles: ["src/index.ts"],
		readRanges: [],
		rejectedPaths: [],
		keyFindings: [],
		modifiedFiles: [],
	});
});

test("session load marks in-progress turn as interrupted", async () => {
	const cwd = await createTempDir("sigpi-session-interrupted-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const created = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: [],
		skillsFingerprint: null,
	});

	await store.markTurnStarted({
		sessionId: created.sessionId,
		userInput: "unfinished task",
	});

	const loaded = await store.loadSession({
		sessionId: created.sessionId,
		cwd,
		systemPromptFingerprint: fingerprint,
	});

	assert.equal(loaded.session.status, "interrupted");
	assert.equal(loaded.session.lastTurn?.status, "interrupted");
	assert.equal(loaded.session.turns.length, 1);
	assert.equal(loaded.session.turns[0]?.status, "interrupted");
	assert.equal(loaded.session.turns[0]?.userInput, "unfinished task");
	assert.match(
		loaded.warnings[0] ?? "",
		/restored the last completed turn only/i,
	);
});

test("session store rejects cwd mismatches", async () => {
	const cwd = await createTempDir("sigpi-session-cwd-");
	const otherCwd = await createTempDir("sigpi-session-cwd-other-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const created = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: [],
		skillsFingerprint: null,
	});

	await assert.rejects(
		() =>
			store.loadSession({
				sessionId: created.sessionId,
				cwd: otherCwd,
				systemPromptFingerprint: fingerprint,
			}),
		/was created for/,
	);
});

test("session store list is sorted by most recent update", async () => {
	const cwd = await createTempDir("sigpi-session-list-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const first = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		title: "first",
		loadedSkillNames: [],
		skillsFingerprint: null,
	});
	const second = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		title: "second",
		loadedSkillNames: [],
		skillsFingerprint: null,
	});

	await store.markTurnStarted({
		sessionId: first.sessionId,
		userInput: "older",
	});
	await store.markTurnStarted({
		sessionId: second.sessionId,
		userInput: "newer",
	});

	const sessions = await store.listSessions();
	assert.equal(sessions[0]?.sessionId, second.sessionId);
	assert.equal(sessions[1]?.sessionId, first.sessionId);
});

test("session summary estimates tokens from persisted entries", async () => {
	const cwd = await createTempDir("sigpi-session-tokens-");
	const homeDir = await createTempDir("sigpi-session-tokens-home-");
	const store = createTestSessionStore({ cwd, homeDir });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const session = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: [],
		skillsFingerprint: null,
	});

	await store.markTurnStarted({
		sessionId: session.sessionId,
		userInput: "what is the meaning of life in forty two words",
	});
	await store.markTurnCompleted({
		sessionId: session.sessionId,
		userInput: "what is the meaning of life in forty two words",
		assistantOutput: "forty two",
		steps: 1,
		toolExecutions: [],
		contextState: {
			summary: null,
			recentMessages: [
				{
					role: "user",
					content: "what is the meaning of life in forty two words",
				},
				{ role: "assistant", content: "forty two" },
			],
		},
	});

	const [summary] = await store.listSessions();
	assert.equal(typeof summary?.estimatedTokens, "number");
	assert.ok((summary?.estimatedTokens ?? 0) > 0);
});

test("session store writes local timestamps instead of UTC Z timestamps", async () => {
	const cwd = await createTempDir("sigpi-session-local-time-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const session = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: [],
		skillsFingerprint: null,
	});

	assert.match(
		session.createdAt,
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/,
	);
	assert.equal(session.createdAt.endsWith("Z"), false);
	assert.equal(session.updatedAt.endsWith("Z"), false);
});

test("session store normalizes legacy UTC timestamps on read", async () => {
	const cwd = await createTempDir("sigpi-session-normalize-");
	const homeDir = await createTempDir("sigpi-session-normalize-home-");
	const store = createTestSessionStore({ cwd, homeDir });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const sessionId = "11111111-1111-4111-8111-111111111111";
	const sessionsDir = resolveSessionStoragePaths({
		cwd,
		sessionsRoot: getDefaultSessionsRoot(homeDir),
	}).sessionsDir;
	await mkdir(sessionsDir, { recursive: true });
	await writeFile(
		path.join(sessionsDir, `${sessionId}.meta.json`),
		`${JSON.stringify(
			{
				version: 4,
				sessionId,
				title: "demo",
				createdAt: "2026-05-22T00:00:00.000Z",
				updatedAt: "2026-05-22T00:04:00.000Z",
				cwd,
				systemPromptFingerprint: fingerprint,
				loadedSkillNames: [],
				skillsFingerprint: null,
				persistedEntryCount: 0,
				turnCount: 1,
				lastCompletedUserInput: "latest question",
				status: "active",
				lastTurn: {
					startedAt: "2026-05-22T00:03:00.000Z",
					finishedAt: "2026-05-22T00:04:00.000Z",
					status: "completed",
					userInput: "latest question",
					assistantOutput: "latest answer",
					toolExecutionCount: 0,
					errorMessage: null,
				},
				turns: [
					{
						turnId: 1,
						startedAt: "2026-05-22T00:03:00.000Z",
						finishedAt: "2026-05-22T00:04:00.000Z",
						status: "completed",
						userInput: "latest question",
						assistantOutput: "latest answer",
						steps: 1,
						toolExecutions: [],
						errorMessage: null,
					},
				],
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	const loaded = await store.getSession(sessionId);

	assert.equal(loaded.createdAt.endsWith("Z"), false);
	assert.equal(loaded.updatedAt.endsWith("Z"), false);
	assert.equal(loaded.lastTurn?.startedAt.endsWith("Z"), false);
	assert.equal(loaded.lastTurn?.finishedAt?.endsWith("Z"), false);
	assert.equal(loaded.turns[0]?.startedAt.endsWith("Z"), false);
});

test("session store can update the recovery snapshot without adding a turn", async () => {
	const cwd = await createTempDir("sigpi-session-snapshot-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const session = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: [],
		skillsFingerprint: null,
	});

	const updated = await store.updateSnapshot({
		sessionId: session.sessionId,
		contextState: {
			summary: "manual summary",
			recentMessages: [{ role: "assistant", content: "latest answer" }],
		},
	});

	const updatedDerived = deriveContextStateFromEntries(updated.entries);
	assert.equal(updated.turnCount, 0);
	assert.equal(updatedDerived.summary, "manual summary");
	assert.deepEqual(stripMessageIds(updatedDerived.recentMessages), [
		{ role: "assistant", content: "latest answer" },
	]);

	const loaded = await store.getSession(session.sessionId);
	const loadedDerived = deriveContextStateFromEntries(loaded.entries);
	assert.equal(loadedDerived.summary, "manual summary");
	assert.deepEqual(stripMessageIds(loadedDerived.recentMessages), [
		{ role: "assistant", content: "latest answer" },
	]);
});

test("markTurnFailed can persist a failed-turn recovery snapshot", async () => {
	const cwd = await createTempDir("sigpi-session-failed-snapshot-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const session = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: [],
		skillsFingerprint: null,
	});

	await store.markTurnStarted({
		sessionId: session.sessionId,
		userInput: "investigate timeout",
	});
	await store.markTurnFailed({
		sessionId: session.sessionId,
		userInput: "investigate timeout",
		errorMessage: "Model request timed out after 30000ms.",
		contextState: {
			summary: null,
			recentMessages: [
				{ role: "user", content: "investigate timeout" },
				{ role: "assistant", content: null, toolCalls: [] },
			],
		},
	});

	const persisted = await store.getSession(session.sessionId);
	assert.equal(persisted.turnCount, 0);
	assert.equal(persisted.lastTurn?.status, "failed");
	assert.equal(persisted.turns.length, 1);
	assert.equal(persisted.turns[0]?.status, "failed");
	assert.deepEqual(
		stripMessageIds(
			deriveContextStateFromEntries(persisted.entries).recentMessages,
		),
		[
			{ role: "user", content: "investigate timeout" },
			{ role: "assistant", content: null, toolCalls: [] },
		],
	);
});

test("session list exposes last completed user input in summaries", async () => {
	const cwd = await createTempDir("sigpi-session-list-summary-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const session = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		title: "investigate parser",
		loadedSkillNames: [],
		skillsFingerprint: null,
	});

	await store.markTurnStarted({
		sessionId: session.sessionId,
		userInput: "find parser regression",
	});
	await store.markTurnCompleted({
		sessionId: session.sessionId,
		userInput: "find parser regression",
		assistantOutput: "done",
		steps: 1,
		toolExecutions: [],
		contextState: {
			summary: null,
			recentMessages: [
				{ role: "user", content: "find parser regression" },
				{ role: "assistant", content: "done" },
			],
		},
	});

	const sessions = await store.listSessions();

	assert.equal(sessions[0]?.sessionId, session.sessionId);
	assert.equal(sessions[0]?.lastCompletedUserInput, "find parser regression");
});

test("session files are written to the expected store path", async () => {
	const cwd = await createTempDir("sigpi-session-file-");
	const homeDir = await createTempDir("sigpi-session-file-home-");
	const store = createTestSessionStore({ cwd, homeDir });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const session = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: [],
		skillsFingerprint: null,
	});

	const storagePaths = resolveSessionStoragePaths({
		cwd,
		sessionsRoot: getDefaultSessionsRoot(homeDir),
	});
	const filePath = path.join(
		storagePaths.projectDir,
		"sessions",
		`${session.sessionId}.meta.json`,
	);
	const raw = await readFile(filePath, "utf8");
	assert.match(raw, new RegExp(session.sessionId));
	// The header must not embed the transcript inline; entries belong in the
	// append-only .jsonl transcript, not the .meta.json header.
	assert.doesNotMatch(raw, /"entries"/);
	assert.equal(storagePaths.projectKey, createProjectKey(cwd));
});

test("new sessions initialize with empty turn history", async () => {
	const cwd = await createTempDir("sigpi-session-empty-history-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");

	const session = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: [],
		skillsFingerprint: null,
	});

	assert.equal(session.version, 4);
	assert.deepEqual(session.turns, []);
});

test("untitled sessions derive their title from the first completed user input", async () => {
	const cwd = await createTempDir("sigpi-session-derived-title-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const session = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
	});

	await store.markTurnStarted({
		sessionId: session.sessionId,
		userInput:
			"investigate why the parser drops the last token in the config loader",
	});
	await store.markTurnCompleted({
		sessionId: session.sessionId,
		userInput:
			"investigate why the parser drops the last token in the config loader",
		assistantOutput: "done",
		steps: 1,
		toolExecutions: [],
		contextState: {
			summary: null,
			recentMessages: [
				{
					role: "user",
					content:
						"investigate why the parser drops the last token in the config loader",
				},
				{ role: "assistant", content: "done" },
			],
		},
	});

	const persisted = await store.getSession(session.sessionId);
	assert.equal(
		persisted.title,
		"investigate why the parser drops the last token in the config loader",
	);
});

test("pruneEmptySessions removes session files that never recorded any turns", async () => {
	const cwd = await createTempDir("sigpi-session-prune-empty-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const empty = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
	});
	const active = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
	});

	await store.markTurnStarted({
		sessionId: active.sessionId,
		userInput: "keep me",
	});
	await store.markTurnCompleted({
		sessionId: active.sessionId,
		userInput: "keep me",
		assistantOutput: "done",
		steps: 1,
		toolExecutions: [],
		contextState: {
			summary: null,
			recentMessages: [
				{ role: "user", content: "keep me" },
				{ role: "assistant", content: "done" },
			],
		},
	});

	const prunedCount = await store.pruneEmptySessions();
	const sessions = await store.listSessions();

	assert.equal(prunedCount, 1);
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0]?.sessionId, active.sessionId);
	await assert.rejects(
		() => store.getSession(empty.sessionId),
		/ENOENT|no such file|not found/i,
	);
});

test("session history preserves completed turns even when snapshot changes", async () => {
	const cwd = await createTempDir("sigpi-session-history-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const session = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: [],
		skillsFingerprint: null,
	});

	await store.markTurnStarted({
		sessionId: session.sessionId,
		userInput: "first turn",
	});
	await store.markTurnCompleted({
		sessionId: session.sessionId,
		userInput: "first turn",
		assistantOutput: "first answer",
		steps: 1,
		toolExecutions: [createTestToolExecution()],
		contextState: {
			summary: null,
			recentMessages: [
				{ role: "user", content: "first turn" },
				{ role: "assistant", content: "first answer" },
			],
		},
	});

	await store.markTurnStarted({
		sessionId: session.sessionId,
		userInput: "second turn",
	});
	await store.markTurnCompleted({
		sessionId: session.sessionId,
		userInput: "second turn",
		assistantOutput: "second answer",
		steps: 3,
		toolExecutions: [
			createTestToolExecution({
				toolCall: {
					id: "call_2",
					name: "glob",
					arguments: { pattern: "*", path: "." },
					rawArguments: '{"pattern":"*","path":"."}',
				},
				result: {
					ok: true,
					data: { entries: ["src", "test"] },
				},
			}),
		],
		contextState: {
			summary: "first turn compressed away",
			recentMessages: [
				{ role: "user", content: "second turn" },
				{ role: "assistant", content: "second answer" },
			],
		},
	});

	const persisted = await store.getSession(session.sessionId);
	const persistedDerived = deriveContextStateFromEntries(persisted.entries);
	assert.equal(persisted.turnCount, 2);
	assert.equal(persistedDerived.summary, "first turn compressed away");
	assert.deepEqual(stripMessageIds(persistedDerived.recentMessages), [
		{ role: "user", content: "second turn" },
		{ role: "assistant", content: "second answer" },
	]);
	assert.equal(persisted.turns.length, 2);
	assert.equal(persisted.turns[0]?.userInput, "first turn");
	assert.equal(persisted.turns[1]?.userInput, "second turn");
});

test("session restore warns when loaded skills change but still succeeds", async () => {
	const cwd = await createTempDir("sigpi-session-skills-changed-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const session = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: ["alpha"],
		skillsFingerprint: "fingerprint-alpha",
	});

	const loaded = await store.loadSession({
		sessionId: session.sessionId,
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: ["beta"],
		skillsFingerprint: "fingerprint-beta",
	});

	assert.equal(loaded.session.sessionId, session.sessionId);
	assert.match(loaded.warnings.join("\n"), /Loaded skills changed/);
});

test("session store rejects old schema files", async () => {
	const cwd = await createTempDir("sigpi-session-old-schema-");
	const homeDir = await createTempDir("sigpi-session-old-schema-home-");
	const store = createTestSessionStore({ cwd, homeDir });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const sessionId = "11111111-1111-4111-8111-111111111111";
	const sessionsDir = resolveSessionStoragePaths({
		cwd,
		sessionsRoot: getDefaultSessionsRoot(homeDir),
	}).sessionsDir;
	await mkdir(sessionsDir, { recursive: true });
	await writeFile(
		path.join(sessionsDir, `${sessionId}.json`),
		`${JSON.stringify(
			{
				version: 1,
				sessionId,
				title: null,
				createdAt: "2026-05-22T00:00:00.000Z",
				updatedAt: "2026-05-22T00:00:00.000Z",
				cwd,
				systemPromptFingerprint: fingerprint,
				summary: null,
				recentMessages: [],
				turnCount: 0,
				lastCompletedUserInput: null,
				status: "active",
				lastTurn: null,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	await assert.rejects(() => store.getSession(sessionId), /legacy/i);
});

test("session store rejects a malformed session header", async () => {
	const cwd = await createTempDir("sigpi-session-bad-header-");
	const homeDir = await createTempDir("sigpi-session-bad-header-home-");
	const store = createTestSessionStore({ cwd, homeDir });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const sessionId = "22222222-2222-4222-8222-222222222222";
	const sessionsDir = resolveSessionStoragePaths({
		cwd,
		sessionsRoot: getDefaultSessionsRoot(homeDir),
	}).sessionsDir;
	await mkdir(sessionsDir, { recursive: true });
	await writeFile(
		path.join(sessionsDir, `${sessionId}.meta.json`),
		`${JSON.stringify(
			{
				version: 4,
				sessionId,
				title: null,
				createdAt: "2026-05-22T00:00:00.000Z",
				updatedAt: "2026-05-22T00:04:00.000Z",
				cwd,
				systemPromptFingerprint: fingerprint,
				loadedSkillNames: [],
				skillsFingerprint: null,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	await assert.rejects(() => store.getSession(sessionId), /header is invalid/);
});

test("session store appends transcript deltas across turns instead of rewriting", async () => {
	const cwd = await createTempDir("sigpi-session-delta-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const created = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: [],
		skillsFingerprint: null,
	});

	await store.markTurnStarted({
		sessionId: created.sessionId,
		userInput: "first task",
	});
	await store.markTurnCompleted({
		sessionId: created.sessionId,
		userInput: "first task",
		assistantOutput: "first answer",
		steps: 1,
		toolExecutions: [],
		contextState: {
			summary: null,
			recentMessages: [
				{ role: "user", content: "first task" },
				{ role: "assistant", content: "first answer" },
			],
			explorationLedger: {
				searchedQueries: [],
				candidateFiles: [],
				readRanges: [],
				rejectedPaths: [],
				keyFindings: [],
				modifiedFiles: [],
			},
		},
	});
	const afterFirst = await store.getSession(created.sessionId);

	await store.markTurnStarted({
		sessionId: created.sessionId,
		userInput: "second task",
	});
	await store.markTurnCompleted({
		sessionId: created.sessionId,
		userInput: "second task",
		assistantOutput: "second answer",
		steps: 1,
		toolExecutions: [],
		contextState: {
			summary: null,
			recentMessages: [
				{ role: "user", content: "second task" },
				{ role: "assistant", content: "second answer" },
			],
			explorationLedger: {
				searchedQueries: [],
				candidateFiles: [],
				readRanges: [],
				rejectedPaths: [],
				keyFindings: [],
				modifiedFiles: [],
			},
		},
	});
	const afterSecond = await store.getSession(created.sessionId);

	const storagePaths = resolveSessionStoragePaths({
		cwd,
		sessionsRoot: getDefaultSessionsRoot(cwd),
	});
	const jsonlPath = path.join(
		storagePaths.sessionsDir,
		`${created.sessionId}.jsonl`,
	);
	const transcript1 = await readFile(jsonlPath, "utf8");

	await store.markTurnStarted({
		sessionId: created.sessionId,
		userInput: "third task",
	});
	await store.markTurnCompleted({
		sessionId: created.sessionId,
		userInput: "third task",
		assistantOutput: "third answer",
		steps: 1,
		toolExecutions: [],
		contextState: {
			summary: null,
			recentMessages: [
				{ role: "user", content: "third task" },
				{ role: "assistant", content: "third answer" },
			],
			explorationLedger: {
				searchedQueries: [],
				candidateFiles: [],
				readRanges: [],
				rejectedPaths: [],
				keyFindings: [],
				modifiedFiles: [],
			},
		},
	});
	const transcript2 = await readFile(jsonlPath, "utf8");

	// The first turn's lines must remain verbatim on disk (append-only).
	assert.ok(
		transcript2.startsWith(transcript1),
		"transcript must be append-only",
	);
	assert.notEqual(transcript2, transcript1, "a new turn should append lines");
	const lineCount1 = transcript1
		.split("\n")
		.filter((l) => l.trim().length > 0).length;
	const lineCount2 = transcript2
		.split("\n")
		.filter((l) => l.trim().length > 0).length;
	assert.equal(afterFirst.entries.length, lineCount1 - 2);
	assert.equal(afterSecond.entries.length, lineCount1);
	const afterThird = await store.getSession(created.sessionId);
	assert.equal(afterThird.entries.length, lineCount2);
});

test("session store tolerates a single torn transcript line on read", async () => {
	const cwd = await createTempDir("sigpi-session-torn-");
	const store = createTestSessionStore({ cwd, homeDir: cwd });
	const fingerprint = createSystemPromptFingerprint("system prompt");
	const created = await store.createSession({
		cwd,
		systemPromptFingerprint: fingerprint,
		loadedSkillNames: [],
		skillsFingerprint: null,
	});

	await store.markTurnStarted({
		sessionId: created.sessionId,
		userInput: "task",
	});
	await store.markTurnCompleted({
		sessionId: created.sessionId,
		userInput: "task",
		assistantOutput: "answer",
		steps: 1,
		toolExecutions: [],
		contextState: {
			summary: null,
			recentMessages: [
				{ role: "user", content: "task" },
				{ role: "assistant", content: "answer" },
			],
			explorationLedger: {
				searchedQueries: [],
				candidateFiles: [],
				readRanges: [],
				rejectedPaths: [],
				keyFindings: [],
				modifiedFiles: [],
			},
		},
	});
	const before = await store.getSession(created.sessionId);
	const expectedCount = before.entries.length;

	const storagePaths = resolveSessionStoragePaths({
		cwd,
		sessionsRoot: getDefaultSessionsRoot(cwd),
	});
	const jsonlPath = path.join(
		storagePaths.sessionsDir,
		`${created.sessionId}.jsonl`,
	);
	// Simulate a partial/corrupt final write with no trailing newline.
	await writeFile(jsonlPath, '{"id":"torn","kind":"message","mess', {
		flag: "a",
	});

	const loaded = await store.getSession(created.sessionId);
	assert.equal(loaded.entries.length, expectedCount);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveSessionStoragePaths } from "../dist/src/session/paths.js";
import {
	createTempDir,
	runCliCommand,
	writeTestConfig,
} from "../dist/test/helpers.js";

const bootstrapPath = path.resolve("scripts/fake-openai-bootstrap.mjs");
const handlerPath = path.resolve("scripts/fake-openai-cli-handler.mjs");
const cwd = await createTempDir("sigpi-cli-int-");

await writeTestConfig(cwd, {
	modelBaseURL: "https://fake-openai.local/v1",
	contextWindow: 1_000_000,
	reserveTokens: 0,
});

const validatedConfig = await runCliCommand({
	cwd,
	commandArgs: ["config", "validate"],
});
assert.equal(validatedConfig.code, 0);
assert.match(validatedConfig.stdout, /"ok": true/);
assert.match(validatedConfig.stdout, /"apiKey": "te\*\*\*\*ey"/);
assert.doesNotMatch(validatedConfig.stdout, /test-key/);

const childEnv = {
	TINYPI_FAKE_OPENAI_HANDLER: handlerPath,
	AGENT_SESSIONS_ROOT: path.join(cwd, ".sessions-root"),
};
const nodeArgs = ["--import", bootstrapPath];

const firstAsk = await runCliCommand({
	cwd,
	commandArgs: ["ask", "--new", "--title", "save-session", "save state"],
	env: childEnv,
	nodeArgs,
});
assert.equal(firstAsk.code, 0);
assert.match(firstAsk.stdout, /\[session\] /);
assert.match(firstAsk.stdout, /ack:save state/);
const savedSessionId = extractSessionId(firstAsk.stdout);
const storagePaths = resolveSessionStoragePaths({
	cwd,
	sessionsRoot: childEnv.AGENT_SESSIONS_ROOT,
});
const sessionPath = path.join(storagePaths.sessionsDir, `${savedSessionId}.jsonl`);
assert.match(await readFile(sessionPath, "utf8"), /save state/);

const resumedAsk = await runCliCommand({
	cwd,
	commandArgs: ["ask", "--session", savedSessionId, "follow up"],
	env: childEnv,
	nodeArgs,
});
assert.equal(resumedAsk.code, 0);
assert.match(resumedAsk.stdout, /resume ok/);
assert.match(resumedAsk.stdout, new RegExp(savedSessionId));

const shownSession = await runCliCommand({
	cwd,
	commandArgs: ["session", "show", savedSessionId],
	env: childEnv,
	nodeArgs,
});
assert.equal(shownSession.code, 0);
assert.match(shownSession.stdout, /"turnCount": 2/);
assert.match(shownSession.stdout, /"lastCompletedUserInput": "follow up"/);

const baseChat = await runCliCommand({
	cwd,
	commandArgs: ["ask", "--new", "--title", "chat-base", "base state"],
	env: childEnv,
	nodeArgs,
});
const baseChatSessionId = extractSessionId(baseChat.stdout);
const updatedTarget = await runCliCommand({
	cwd,
	commandArgs: ["ask", "--session", savedSessionId, "refresh target"],
	env: childEnv,
	nodeArgs,
});
assert.equal(updatedTarget.code, 0);

const chat = await runCliCommand({
	cwd,
	commandArgs: ["chat", "--session", baseChatSessionId],
	input: "chat question\n",
	env: childEnv,
	nodeArgs,
	timeoutMs: 30_000,
});
assert.equal(chat.code, 0);
assert.match(chat.stdout, /chat ok/);
assert.match(chat.stdout, new RegExp(baseChatSessionId));

const refreshBeforeResume = await runCliCommand({
	cwd,
	commandArgs: ["ask", "--session", savedSessionId, "refresh before resume"],
	env: childEnv,
	nodeArgs,
});
assert.equal(refreshBeforeResume.code, 0);

const sessionCommand = await runCliCommand({
	cwd,
	commandArgs: ["chat", "--session", baseChatSessionId],
	input: "/session\n",
	env: childEnv,
	nodeArgs,
	timeoutMs: 30_000,
});
assert.equal(sessionCommand.code, 0);
assert.match(sessionCommand.stdout, new RegExp(baseChatSessionId));

const summaryCommand = await runCliCommand({
	cwd,
	commandArgs: ["chat", "--session", baseChatSessionId],
	input: "/summary\n",
	env: childEnv,
	nodeArgs,
	timeoutMs: 30_000,
});
assert.equal(summaryCommand.code, 0);
assert.match(summaryCommand.stdout, /Context window:/);

const compactCommand = await runCliCommand({
	cwd,
	commandArgs: ["chat", "--session", baseChatSessionId],
	input: "/compact\n",
	env: childEnv,
	nodeArgs,
	timeoutMs: 30_000,
});
assert.equal(compactCommand.code, 0);
assert.match(compactCommand.stdout, /Context compacted/);

const resumeCommand = await runCliCommand({
	cwd,
	commandArgs: ["chat", "--session", baseChatSessionId],
	input: "/resume\n",
	env: childEnv,
	nodeArgs,
	timeoutMs: 30_000,
});
assert.equal(resumeCommand.code, 0);
assert.match(resumeCommand.stdout, /Attached session:/);
assert.match(resumeCommand.stdout, new RegExp(baseChatSessionId));

const exitCommand = await runCliCommand({
	cwd,
	commandArgs: ["chat", "--session", baseChatSessionId],
	input: "/exit\n",
	env: childEnv,
	nodeArgs,
	timeoutMs: 30_000,
});
assert.equal(exitCommand.code, 0);

// No-args invocation must default to interactive chat (not print usage).
const noArgsChat = await runCliCommand({
  cwd,
  commandArgs: [],
  input: "/exit\n",
  env: childEnv,
  nodeArgs,
  timeoutMs: 30_000,
});
assert.equal(noArgsChat.code, 0);
assert.match(noArgsChat.stdout, /Interactive chat started/);
assert.doesNotMatch(noArgsChat.stdout, /Usage:/);

const toolFailure = await runCliCommand({
	cwd,
	commandArgs: ["ask", "tool fail"],
	env: childEnv,
	nodeArgs,
});
assert.equal(toolFailure.code, 0);
assert.match(toolFailure.stdout, /tool error surfaced/);

const modelFailure = await runCliCommand({
	cwd,
	commandArgs: ["ask", "model boom"],
	env: childEnv,
	nodeArgs,
});
assert.equal(modelFailure.code, 1);
assert.match(modelFailure.stderr, /server error \(HTTP 500\)/);

function extractSessionId(stdout) {
	const match = stdout.match(/\[session\]\s+([0-9a-f-]{36})/i);
	assert(match?.[1]);
	return match[1];
}

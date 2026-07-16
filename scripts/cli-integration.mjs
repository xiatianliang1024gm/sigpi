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
// Run the child CLI with a hermetic HOME so the test never depends on the
// host machine's ~/.sigpi config (a stray global config masked a real bug,
// and a missing one broke CI). The project fixtures are still loaded via
// --approve below.
const trustHome = await createTempDir("sigpi-cli-int-home-");

await writeTestConfig(cwd, {
	modelBaseURL: "https://fake-openai.local/v1",
	contextWindow: 1_000_000,
	reserveTokens: 0,
});

const validatedConfig = await runTrustedCli({
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
// The integration harness runs SigPi's own test fixtures in a project directory
// that carries a gating marker (.sigpi/config.toml). Because ADR 0022 gates
// project-local resources behind trust and headless runs default to deny,
// every command opts into the project config/skills via --approve.
async function runTrustedCli(args) {
	return runCliCommand({
		...args,
		// Override HOME so the child cannot read the host's ~/.sigpi config.
		// (runCliCommand keeps process.env by default; we replace HOME only.)
		env: { ...args.env, HOME: trustHome },
		commandArgs: [...args.commandArgs, "--approve"],
	});
}


const firstAsk = await runTrustedCli({
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
const sessionPath = path.join(storagePaths.sessionsDir, `${savedSessionId}.meta.json`);
assert.match(await readFile(sessionPath, "utf8"), /save state/);

const resumedAsk = await runTrustedCli({
	cwd,
	commandArgs: ["ask", "--session", savedSessionId, "follow up"],
	env: childEnv,
	nodeArgs,
});
assert.equal(resumedAsk.code, 0);
assert.match(resumedAsk.stdout, /resume ok/);
assert.match(resumedAsk.stdout, new RegExp(savedSessionId));

const shownSession = await runTrustedCli({
	cwd,
	commandArgs: ["session", "show", savedSessionId],
	env: childEnv,
	nodeArgs,
});
assert.equal(shownSession.code, 0);
assert.match(shownSession.stdout, /"turnCount": 2/);
assert.match(shownSession.stdout, /"lastCompletedUserInput": "follow up"/);

const baseChat = await runTrustedCli({
	cwd,
	commandArgs: ["ask", "--new", "--title", "chat-base", "base state"],
	env: childEnv,
	nodeArgs,
});
const baseChatSessionId = extractSessionId(baseChat.stdout);
const updatedTarget = await runTrustedCli({
	cwd,
	commandArgs: ["ask", "--session", savedSessionId, "refresh target"],
	env: childEnv,
	nodeArgs,
});
assert.equal(updatedTarget.code, 0);

const chat = await runTrustedCli({
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

const refreshBeforeResume = await runTrustedCli({
	cwd,
	commandArgs: ["ask", "--session", savedSessionId, "refresh before resume"],
	env: childEnv,
	nodeArgs,
});
assert.equal(refreshBeforeResume.code, 0);

const sessionCommand = await runTrustedCli({
	cwd,
	commandArgs: ["chat", "--session", baseChatSessionId],
	input: "/session\n",
	env: childEnv,
	nodeArgs,
	timeoutMs: 30_000,
});
assert.equal(sessionCommand.code, 0);
assert.match(sessionCommand.stdout, new RegExp(baseChatSessionId));

const summaryCommand = await runTrustedCli({
	cwd,
	commandArgs: ["chat", "--session", baseChatSessionId],
	input: "/summary\n",
	env: childEnv,
	nodeArgs,
	timeoutMs: 30_000,
});
assert.equal(summaryCommand.code, 0);
assert.match(summaryCommand.stdout, /Context window:/);

const compactCommand = await runTrustedCli({
	cwd,
	commandArgs: ["chat", "--session", baseChatSessionId],
	input: "/compact\n",
	env: childEnv,
	nodeArgs,
	timeoutMs: 30_000,
});
assert.equal(compactCommand.code, 0);
assert.match(compactCommand.stdout, /Context compacted/);

const resumeCommand = await runTrustedCli({
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

const exitCommand = await runTrustedCli({
	cwd,
	commandArgs: ["chat", "--session", baseChatSessionId],
	input: "/exit\n",
	env: childEnv,
	nodeArgs,
	timeoutMs: 30_000,
});
assert.equal(exitCommand.code, 0);

// No-args invocation must default to interactive chat (not print usage).
const noArgsChat = await runTrustedCli({
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

const toolFailure = await runTrustedCli({
	cwd,
	commandArgs: ["ask", "tool fail"],
	env: childEnv,
	nodeArgs,
});
assert.equal(toolFailure.code, 0);
assert.match(toolFailure.stdout, /tool error surfaced/);

const modelFailure = await runTrustedCli({
	cwd,
	commandArgs: ["ask", "model boom"],
	env: childEnv,
	nodeArgs,
});
assert.equal(modelFailure.code, 1);
assert.match(
	modelFailure.stderr,
	/The model provider returned a server error \(HTTP 500\)\. Retry shortly\./,
);

const maxStepsAsk = await runTrustedCli({
	cwd,
	commandArgs: ["ask", "loop steps"],
	env: { ...childEnv, AGENT_MAX_STEPS: "3" },
	nodeArgs,
});
assert.equal(maxStepsAsk.code, 0);
assert.match(maxStepsAsk.stdout, /I reached the maximum tool-call steps/);
assert.match(maxStepsAsk.stdout, /go on/);

function extractSessionId(stdout) {
	const match = stdout.match(/\[session\]\s+([0-9a-f-]{36})/i);
	assert(match?.[1]);
	return match[1];
}

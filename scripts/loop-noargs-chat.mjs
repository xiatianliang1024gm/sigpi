// Feedback loop for: `sigpi` with no args should enter chat, not print usage.
// Red-capable: exits non-zero when the no-args invocation prints usage
// (the bug) instead of starting interactive chat.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bootstrapPath = path.resolve("scripts/fake-openai-bootstrap.mjs");
const handlerPath = path.resolve("scripts/fake-openai-cli-handler.mjs");

const cwd = await mkdtemp(path.join(os.tmpdir(), "sigpi-noargs-loop-"));
const configDir = path.join(cwd, ".sigpi");
await mkdir(configDir, { recursive: true });
await writeFile(
  path.join(configDir, "config.toml"),
  [
    "[model]",
    'active = "test"',
    "",
    "[models.test]",
    'base_url = "https://example.test/v1"',
    'api_key = "test-key"',
    'name = "test-model"',
    "timeout_ms = 2000",
    "max_retries = 0",
    "",
    "[agent]",
    "context_window = 200000",
    "reserve_tokens = 16384",
  ].join("\n"),
  "utf8",
);

const captureDir = await mkdtemp(path.join(os.tmpdir(), "sigpi-noargs-cap-"));
const stdoutPath = path.join(captureDir, "stdout.log");
const stderrPath = path.join(captureDir, "stderr.log");
// Feed a single "/exit" so chat starts, then terminates deterministically.
const stdinPath = path.join(captureDir, "stdin.txt");
await writeFile(stdinPath, "/exit\n", "utf8");

const cliPath = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
const childEnv = {
  ...process.env,
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  http_proxy: "",
  https_proxy: "",
  TINYPI_FAKE_OPENAI_HANDLER: handlerPath,
  AGENT_SESSIONS_ROOT: path.join(cwd, ".sessions-root"),
};

const command = `node --import ${JSON.stringify(bootstrapPath)} ${JSON.stringify(cliPath)} < ${JSON.stringify(stdinPath)} > ${JSON.stringify(stdoutPath)} 2> ${JSON.stringify(stderrPath)}`;

const code = await new Promise((resolve) => {
  const child = spawn("sh", ["-lc", command], { cwd, env: childEnv });
  child.on("close", (c) => resolve(c));
});

const stdout = await readFile(stdoutPath, "utf8");
const stderr = await readFile(stderrPath, "utf8");

await rm(captureDir, { recursive: true, force: true });
await rm(cwd, { recursive: true, force: true });

console.log("=== exit code:", code, "===");
console.log("=== STDOUT ===");
console.log(stdout);
console.log("=== STDERR ===");
console.log(stderr);

// RED-CAPABLE ASSERTION: the user's symptom is "sigpi 提示需要传参数"
// (prints usage / needs args). The fix is that no-args enters chat.
try {
  assert.match(stdout, /Interactive chat started/);
  assert.doesNotMatch(stdout, /Usage:/);
  console.log("\nLOOP: GREEN — no-args entered chat as expected.");
  process.exit(0);
} catch (error) {
  console.log("\nLOOP: RED — no-args did NOT enter chat (bug reproduced).");
  console.log(String(error));
  process.exit(1);
}

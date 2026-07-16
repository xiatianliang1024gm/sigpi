import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
	createTempDir,
	runCliCommand,
	writeTestConfig,
} from "../dist/test/helpers.js";

const execFileAsync = promisify(execFile);
const bootstrapPath = path.resolve("scripts/fake-openai-bootstrap.mjs");
const handlerPath = path.resolve("scripts/fake-openai-pack-handler.mjs");

const packDir = await createTempDir("sigpi-pack-out-");
const cacheDir = await createTempDir("sigpi-pack-cache-");
const extractDir = await createTempDir("sigpi-pack-extract-");

await execFileAsync("npm", ["pack", "--pack-destination", packDir], {
	cwd: process.cwd(),
	env: {
		...process.env,
		npm_config_cache: cacheDir,
	},
});
const tarball = (await readdir(packDir)).find((entry) => entry.endsWith(".tgz"));
assert(tarball);

await execFileAsync("tar", [
	"-xf",
	path.join(packDir, tarball),
	"-C",
	extractDir,
]);
const packageDir = path.join(extractDir, "package");
const cliPath = path.join(packageDir, "dist/src/cli.js");
await symlink(path.resolve("node_modules"), path.join(packageDir, "node_modules"));

await writeTestConfig(packageDir, {
	modelBaseURL: "https://fake-openai.local/v1",
});

const childEnv = {
	TINYPI_FAKE_OPENAI_HANDLER: handlerPath,
};
const nodeArgs = ["--import", bootstrapPath];

const help = await runCliCommand({
	cwd: packageDir,
	commandArgs: ["--help"],
	cliPath,
	env: childEnv,
	nodeArgs,
});
assert.equal(help.code, 0);
assert.match(help.stdout, /Usage:/);

const ask = await runCliCommand({
	cwd: packageDir,
	commandArgs: ["ask", "--approve", "pack smoke"],
	cliPath,
	env: childEnv,
	nodeArgs,
});
assert.equal(ask.code, 0);
assert.match(ask.stdout, /packed:pack smoke/);

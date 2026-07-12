#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const benchRoot = path.join(repoRoot, "bench");
const casesRoot = path.join(benchRoot, "cases");
const resultsRoot = path.join(benchRoot, "results");

const args = parseArgs(process.argv.slice(2));

if (args.help) {
	printUsage();
	process.exit(0);
}

const agentCommand = args.agent ?? process.env.BENCH_AGENT_COMMAND;
if (!agentCommand) {
	console.error(
		'Missing agent command. Pass --agent "your-agent" or set BENCH_AGENT_COMMAND.',
	);
	printUsage();
	process.exit(2);
}

const selectedCases = await loadCases(args.cases);
if (selectedCases.length === 0) {
	console.error("No benchmark cases found.");
	process.exit(2);
}

await mkdir(resultsRoot, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(resultsRoot, runId);
await mkdir(runDir, { recursive: true });

const results = [];
for (const testCase of selectedCases) {
	const result = await runCase({
		testCase,
		agentCommand,
		runDir,
		keepWorkspaces: args.keepWorkspaces,
	});
	results.push(result);
	printCaseResult(result);
}

const summary = {
	runId,
	agentCommand,
	startedAt: runIdToIso(runId),
	caseCount: results.length,
	passCount: results.filter((result) => result.pass).length,
	failCount: results.filter((result) => !result.pass).length,
	results,
};
const summaryPath = path.join(runDir, "summary.json");
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log("");
console.log(
	`Summary: ${summary.passCount}/${summary.caseCount} passed. Results: ${summaryPath}`,
);

process.exit(summary.failCount === 0 ? 0 : 1);

async function loadCases(caseNames) {
	const allEntries = await readdir(casesRoot, { withFileTypes: true });
	const allCaseDirs = allEntries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const names = caseNames.length > 0 ? caseNames : allCaseDirs;

	return Promise.all(
		names.map(async (name) => {
			const caseDir = path.join(casesRoot, name);
			const manifestPath = path.join(caseDir, "case.json");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
			return {
				name,
				caseDir,
				workspaceTemplatePath: path.join(caseDir, "workspace"),
				checkerPath: path.join(caseDir, manifest.checker ?? "checker.mjs"),
				prompt: manifest.prompt,
				timeoutMs: manifest.timeoutMs ?? 120_000,
			};
		}),
	);
}

async function runCase({ testCase, agentCommand, runDir, keepWorkspaces }) {
	const caseResultDir = path.join(runDir, testCase.name);
	await mkdir(caseResultDir, { recursive: true });
	const workspacePath = await copyWorkspace(testCase);
	const stdoutPath = path.join(caseResultDir, "stdout.log");
	const stderrPath = path.join(caseResultDir, "stderr.log");
	const startedAt = Date.now();
	const commandLine = `${agentCommand} ${shellEscape(testCase.prompt)}`;

	let processResult;
	try {
		processResult = await runCommand({
			commandLine,
			cwd: workspacePath,
			timeoutMs: testCase.timeoutMs,
			stdoutPath,
			stderrPath,
		});
	} catch (error) {
		processResult = {
			exitCode: null,
			timedOut: false,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}

	const durationMs = Date.now() - startedAt;
	let checker = {
		pass: false,
		message: "checker did not run",
	};
	if (processResult.timedOut) {
		checker = {
			pass: false,
			message: `agent timed out after ${testCase.timeoutMs}ms`,
		};
	} else {
		checker = await runChecker({
			checkerPath: testCase.checkerPath,
			workspacePath,
			stdout: processResult.stdout,
			stderr: processResult.stderr,
			exitCode: processResult.exitCode,
			durationMs,
		});
	}

	const result = {
		case: testCase.name,
		pass: Boolean(checker.pass),
		durationMs,
		exitCode: processResult.exitCode,
		timedOut: Boolean(processResult.timedOut),
		commandLine,
		checkerMessage: checker.message ?? "",
		workspacePath,
		stdoutPath,
		stderrPath,
	};
	await writeFile(
		path.join(caseResultDir, "result.json"),
		`${JSON.stringify(result, null, 2)}\n`,
		"utf8",
	);

	if (!keepWorkspaces && result.pass) {
		await rm(workspacePath, { recursive: true, force: true });
		result.workspacePath = null;
	}

	return result;
}

async function copyWorkspace(testCase) {
	await mkdir(os.tmpdir(), { recursive: true });
	const workspacePath = await mkdtemp(
		path.join(os.tmpdir(), `sigpi-bench-${testCase.name}-`),
	);
	await cp(testCase.workspaceTemplatePath, workspacePath, {
		recursive: true,
		errorOnExist: false,
	});
	return workspacePath;
}

async function runCommand({
	commandLine,
	cwd,
	timeoutMs,
	stdoutPath,
	stderrPath,
}) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const redirectedCommand = `${commandLine} > ${shellEscape(stdoutPath)} 2> ${shellEscape(stderrPath)}`;
		const child = spawn("sh", ["-lc", redirectedCommand], {
			cwd,
			env: process.env,
			stdio: "ignore",
		});

		const timeout = setTimeout(() => {
			settled = true;
			child.kill("SIGKILL");
			setTimeout(async () => {
				resolve({
					exitCode: null,
					timedOut: true,
					stdout: await readCapture(stdoutPath),
					stderr: await readCapture(stderrPath),
				});
			}, 0);
		}, timeoutMs);

		child.on("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (exitCode) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			resolveCapture({
				exitCode,
				timedOut: false,
			});
		});

		async function resolveCapture(result) {
			resolve({
				...result,
				stdout: await readCapture(stdoutPath),
				stderr: await readCapture(stderrPath),
			});
		}
	});
}

async function runChecker(args) {
	try {
		const checkerModule = await import(pathToFileURL(args.checkerPath).href);
		const check = checkerModule.check ?? checkerModule.default;
		if (typeof check !== "function") {
			return {
				pass: false,
				message: "checker must export check() or default function",
			};
		}
		const result = await check(args);
		if (typeof result === "boolean") {
			return {
				pass: result,
				message: result ? "passed" : "failed",
			};
		}
		return {
			pass: Boolean(result?.pass),
			message: result?.message ?? "",
		};
	} catch (error) {
		return {
			pass: false,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

function parseArgs(argv) {
	const parsed = {
		agent: undefined,
		cases: [],
		keepWorkspaces: false,
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") {
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg === "--agent") {
			parsed.agent = argv[index + 1];
			index += 1;
			continue;
		}
		if (arg === "--case") {
			parsed.cases.push(argv[index + 1]);
			index += 1;
			continue;
		}
		if (arg === "--keep-workspaces") {
			parsed.keepWorkspaces = true;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return parsed;
}

function printUsage() {
	console.log("Usage:");
	console.log('  pnpm bench -- --agent "your-agent"');
	console.log('  pnpm bench -- --agent "your-agent" --case read-package-name');
	console.log("");
	console.log("Environment:");
	console.log("  BENCH_AGENT_COMMAND  Agent command prefix to run in each workspace");
}

function printCaseResult(result) {
	const status = result.pass ? "PASS" : "FAIL";
	console.log(
		`${status} ${result.case} (${result.durationMs}ms, exit=${result.exitCode ?? "null"}) - ${result.checkerMessage}`,
	);
}

function shellEscape(value) {
	if (value.length === 0) {
		return "''";
	}
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function readCapture(filePath) {
	try {
		return await readFile(filePath, "utf8");
	} catch {
		return "";
	}
}

function runIdToIso(runId) {
	return runId.replace(
		/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
		"$1:$2:$3.$4Z",
	);
}

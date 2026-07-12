#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const defaultWorkDir = path.join(repoRoot, "bench", "swebench-work");
const defaultPredictionsPath = path.join(
	repoRoot,
	"bench",
	"results",
	"swebench-lite-predictions.jsonl",
);

const args = parseArgs(process.argv.slice(2));

if (args.help) {
	printUsage();
	process.exit(0);
}

const agentCommand = args.agent ?? process.env.SWEBENCH_AGENT_COMMAND;
if (!agentCommand) {
	console.error(
		'Missing agent command. Pass --agent "node /absolute/path/to/dist/src/cli.js ask --new" or set SWEBENCH_AGENT_COMMAND.',
	);
	printUsage();
	process.exit(2);
}

await mkdir(args.workDir, { recursive: true });
await mkdir(path.dirname(args.predictionsPath), { recursive: true });

const tasks = await loadTasks(args);
const predictions = [];

for (const task of tasks) {
	const result = await runTask({ task, args, agentCommand });
	predictions.push({
		instance_id: task.instance_id,
		model_name_or_path: args.modelName,
		model_patch: result.patch,
	});
	await writePredictions(args.predictionsPath, predictions);
	printTaskResult(result);
}

console.log("");
console.log(
	`Generated ${predictions.length} prediction(s): ${args.predictionsPath}`,
);
console.log("");
console.log("Evaluate with the official SWE-bench harness:");
console.log(
	[
		"python -m swebench.harness.run_evaluation",
		"--dataset_name princeton-nlp/SWE-bench_Lite",
		"--split test",
		`--predictions_path ${shellEscape(args.predictionsPath)}`,
		`--run_id ${shellEscape(args.runId)}`,
	].join(" "),
);

async function loadTasks(options) {
	const cacheDir = await mkdtemp(path.join(os.tmpdir(), "sigpi-swebench-"));
	const tasksPath = path.join(cacheDir, "tasks.json");
	const code = `
import json
import sys

try:
    from datasets import load_dataset
except ModuleNotFoundError:
    print("Missing Python package: datasets. Install with: python -m pip install datasets", file=sys.stderr)
    sys.exit(3)

dataset_name = sys.argv[1]
split = sys.argv[2]
limit = int(sys.argv[3])
instances = set(filter(None, sys.argv[4].split(",")))
output_path = sys.argv[5]

rows = []
for row in load_dataset(dataset_name, split=split):
    if instances and row["instance_id"] not in instances:
        continue
    rows.append(dict(row))
    if limit > 0 and len(rows) >= limit:
        break

with open(output_path, "w", encoding="utf-8") as handle:
    json.dump(rows, handle)
`;

	try {
		await runProcess({
			command: "python",
			args: [
				"-c",
				code,
				options.dataset,
				options.split,
				String(options.limit ?? 0),
				options.instances.join(","),
				tasksPath,
			],
			cwd: repoRoot,
			timeoutMs: options.datasetTimeoutMs,
		});
		const tasks = JSON.parse(await readFile(tasksPath, "utf8"));
		if (tasks.length === 0) {
			throw new Error("No SWE-bench tasks matched the selected filters.");
		}
		return tasks;
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
	}
}

async function runTask({ task, args, agentCommand }) {
	const safeId = sanitizePathSegment(task.instance_id);
	const taskDir = path.join(args.workDir, safeId);
	const repoDir = path.join(taskDir, "repo");
	const logsDir = path.join(taskDir, "logs");
	const stdoutPath = path.join(logsDir, "stdout.log");
	const stderrPath = path.join(logsDir, "stderr.log");

	if (!args.keepWorkspaces) {
		await rm(taskDir, { recursive: true, force: true });
	}
	await mkdir(logsDir, { recursive: true });

	const startedAt = Date.now();
	try {
		await checkoutTaskRepo({ task, repoDir, timeoutMs: args.gitTimeoutMs });
		const prompt = formatPrompt(task);
		const commandLine = `${agentCommand} ${shellEscape(prompt)}`;
		const agent = await runShellCommand({
			commandLine,
			cwd: repoDir,
			timeoutMs: args.timeoutMs,
			stdoutPath,
			stderrPath,
		});
		const patchResult = await runProcess({
			command: "git",
			args: ["diff", "--binary"],
			cwd: repoDir,
			timeoutMs: 30_000,
			capture: true,
		});
		const patch = patchResult.stdout;
		return {
			instanceId: task.instance_id,
			ok: agent.exitCode === 0 && patch.trim().length > 0,
			exitCode: agent.exitCode,
			timedOut: agent.timedOut,
			durationMs: Date.now() - startedAt,
			patch,
			stdoutPath,
			stderrPath,
		};
	} catch (error) {
		return {
			instanceId: task.instance_id,
			ok: false,
			exitCode: null,
			timedOut: false,
			durationMs: Date.now() - startedAt,
			patch: "",
			stdoutPath,
			stderrPath,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function checkoutTaskRepo({ task, repoDir, timeoutMs }) {
	await mkdir(path.dirname(repoDir), { recursive: true });
	await runProcess({
		command: "git",
		args: [
			"clone",
			"--quiet",
			"--filter=blob:none",
			"--no-checkout",
			`https://github.com/${task.repo}.git`,
			repoDir,
		],
		cwd: path.dirname(repoDir),
		timeoutMs,
	});
	await runProcess({
		command: "git",
		args: ["checkout", "--quiet", task.base_commit],
		cwd: repoDir,
		timeoutMs,
	});
}

function formatPrompt(task) {
	const hints = task.hints_text?.trim()
		? `\n\nHints from the original issue:\n${task.hints_text.trim()}`
		: "";
	return `We need solve this SWE-bench Lite issue in the current repository.

Modify the repository files to fix the issue. Do not commit changes. Keep the final response brief; the evaluator will use the git diff.

Repository: ${task.repo}
Instance: ${task.instance_id}

Issue:
${task.problem_statement.trim()}${hints}
`;
}

async function writePredictions(predictionsPath, predictions) {
	const lines = predictions.map((prediction) => JSON.stringify(prediction));
	await writeFile(predictionsPath, `${lines.join("\n")}\n`, "utf8");
}

async function runShellCommand({
	commandLine,
	cwd,
	timeoutMs,
	stdoutPath,
	stderrPath,
}) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const redirected = `${commandLine} > ${shellEscape(stdoutPath)} 2> ${shellEscape(stderrPath)}`;
		const child = spawn("sh", ["-lc", redirected], {
			cwd,
			env: process.env,
			stdio: "ignore",
		});
		const timeout = setTimeout(() => {
			settled = true;
			child.kill("SIGKILL");
			resolve({ exitCode: null, timedOut: true });
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
			resolve({ exitCode, timedOut: false });
		});
	});
}

async function runProcess({
	command,
	args,
	cwd,
	timeoutMs,
	capture = false,
}) {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const child = spawn(command, args, {
			cwd,
			env: process.env,
			stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "pipe"],
		});
		const timeout = setTimeout(() => {
			settled = true;
			child.kill("SIGKILL");
			reject(
				new Error(
					`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`,
				),
			);
		}, timeoutMs);

		if (child.stdout) {
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
		}
		if (child.stderr) {
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
		}
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
			if (exitCode !== 0) {
				reject(
					new Error(
						`${command} ${args.join(" ")} exited ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`,
					),
				);
				return;
			}
			resolve({ stdout, stderr, exitCode });
		});
	});
}

function parseArgs(argv) {
	const parsed = {
		agent: undefined,
		dataset: "princeton-nlp/SWE-bench_Lite",
		split: "test",
		limit: 1,
		instances: [],
		modelName: "sigpi",
		runId: `sigpi-${new Date().toISOString().replace(/[:.]/g, "-")}`,
		workDir: defaultWorkDir,
		predictionsPath: defaultPredictionsPath,
		timeoutMs: 900_000,
		gitTimeoutMs: 300_000,
		datasetTimeoutMs: 300_000,
		keepWorkspaces: false,
		help: false,
		limitExplicit: false,
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
			parsed.agent = requireValue(argv, ++index, arg);
			continue;
		}
		if (arg === "--dataset") {
			parsed.dataset = requireValue(argv, ++index, arg);
			continue;
		}
		if (arg === "--split") {
			parsed.split = requireValue(argv, ++index, arg);
			continue;
		}
		if (arg === "--limit") {
			parsed.limit = parsePositiveInteger(requireValue(argv, ++index, arg), arg);
			parsed.limitExplicit = true;
			continue;
		}
		if (arg === "--all") {
			parsed.limit = 0;
			continue;
		}
		if (arg === "--instance") {
			parsed.instances.push(requireValue(argv, ++index, arg));
			continue;
		}
		if (arg === "--model-name") {
			parsed.modelName = requireValue(argv, ++index, arg);
			continue;
		}
		if (arg === "--run-id") {
			parsed.runId = requireValue(argv, ++index, arg);
			continue;
		}
		if (arg === "--work-dir") {
			parsed.workDir = path.resolve(requireValue(argv, ++index, arg));
			continue;
		}
		if (arg === "--predictions-path") {
			parsed.predictionsPath = path.resolve(requireValue(argv, ++index, arg));
			continue;
		}
		if (arg === "--timeout-ms") {
			parsed.timeoutMs = parsePositiveInteger(requireValue(argv, ++index, arg), arg);
			continue;
		}
		if (arg === "--keep-workspaces") {
			parsed.keepWorkspaces = true;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (parsed.instances.length > 0 && !parsed.limitExplicit) {
		parsed.limit = 0;
	}
	delete parsed.limitExplicit;

	return parsed;
}

function requireValue(argv, index, flag) {
	const value = argv[index];
	if (!value || value.startsWith("--")) {
		throw new Error(`Missing value for ${flag}`);
	}
	return value;
}

function parsePositiveInteger(value, flag) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${flag} must be a positive integer`);
	}
	return parsed;
}

function printTaskResult(result) {
	const status = result.ok ? "PATCH" : "NO_PATCH";
	const details = result.error
		? ` - ${result.error}`
		: `, exit=${result.exitCode ?? "null"}, timedOut=${result.timedOut}`;
	console.log(
		`${status} ${result.instanceId} (${result.durationMs}ms${details})`,
	);
}

function printUsage() {
	console.log("Usage:");
	console.log(
		'  pnpm bench:swebench-lite -- --agent "node /absolute/path/to/dist/src/cli.js ask --new" --limit 1',
	);
	console.log(
		'  pnpm bench:swebench-lite -- --agent "sigpi ask --new" --all',
	);
	console.log("");
	console.log("Options:");
	console.log("  --agent <command>           Agent command prefix");
	console.log("  --dataset <name>            Hugging Face dataset name");
	console.log("  --split <name>              Dataset split, default: test");
	console.log("  --limit <n>                 Number of tasks, default: 1");
	console.log("  --all                       Run all selected tasks");
	console.log("  --instance <id>             Run a specific instance; repeatable");
	console.log("  --model-name <name>         Prediction model_name_or_path");
	console.log("  --run-id <id>               Suggested harness run id");
	console.log("  --work-dir <path>           Checkout/log workspace");
	console.log("  --predictions-path <path>   JSONL predictions output");
	console.log("  --timeout-ms <n>            Per-instance agent timeout");
	console.log("  --keep-workspaces           Keep checkouts between runs");
	console.log("");
	console.log("Environment:");
	console.log("  SWEBENCH_AGENT_COMMAND      Agent command prefix");
}

function sanitizePathSegment(value) {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "__");
}

function shellEscape(value) {
	if (value.length === 0) {
		return "''";
	}
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

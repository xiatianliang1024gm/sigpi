import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildSystemPrompt } from "../src/defaults.js";
import {
	buildShellInvocation,
	createShellRuntime,
	detectShellRuntime,
} from "../src/shell.js";
import { BackgroundTaskManager } from "../src/tools/background.js";
import { bashTool, createBashTool } from "../src/tools/builtin/bash.js";
import { createEditTool } from "../src/tools/builtin/edit.js";
import { createGlobTool, globTool } from "../src/tools/builtin/glob.js";
import { createGrepTool, grepTool } from "../src/tools/builtin/grep.js";
import {
	createReadTool,
	DEFAULT_READ_MAX_LINES,
	readTool,
} from "../src/tools/builtin/read.js";
import {
	createUpdatePlanTool,
	updatePlanTool,
} from "../src/tools/builtin/update-plan.js";
import { createWriteTool } from "../src/tools/builtin/write.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";
import { ReadTracker } from "../src/tools/read-tracker.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createTempDir, waitFor, writeWorkspaceFile } from "./helpers.js";

function decodePowerShellEncodedCommand(encodedCommand: string): string {
	return Buffer.from(encodedCommand, "base64").toString("utf16le");
}

function extractWrappedPowerShellCommand(script: string): string {
	const encodedCommand =
		/\[System\.Convert\]::FromBase64String\('([^']+)'\)/u.exec(script)?.[1];

	if (typeof encodedCommand !== "string") {
		assert.fail("PowerShell wrapper did not contain an encoded command");
	}

	return Buffer.from(encodedCommand, "base64").toString("utf8");
}

test("bash executes a command and returns stdout", async () => {
	const tools = new ToolRegistry([bashTool]);

	const result = await tools.execute(
		{
			id: "call_shell_1",
			name: "bash",
			arguments: { command: "printf 'hello'" },
			rawArguments: '{"command":"printf \'hello\'"}',
		},
		{ cwd: process.cwd() },
	);

	assert.equal(result.ok, true);
	assert.equal(typeof result.data, "object");
	assert.equal((result.data as { stdout: string }).stdout, "hello");
});

test("bash captures command failure without throwing", async () => {
	const tools = new ToolRegistry([bashTool]);

	const result = await tools.execute(
		{
			id: "call_shell_2",
			name: "bash",
			arguments: { command: "nonexistent-command-xyz" },
			rawArguments: '{"command":"nonexistent-command-xyz"}',
		},
		{ cwd: process.cwd() },
	);

	assert.equal(result.ok, true);
	assert.equal(typeof result.data, "object");
	assert.equal((result.data as { ok: boolean }).ok, false);
	assert.match(
		(result.data as { stderr: string }).stderr,
		/not found|command not found/i,
	);
});

test("bash read_only mode rejects write commands before execution", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const tools = new ToolRegistry([
		createBashTool(shellRuntime, { mode: "read_only" }, new ReadTracker()),
	]);

	const result = await tools.execute(
		{
			id: "call_shell_ro_1",
			name: "bash",
			arguments: { command: "touch blocked.txt" },
			rawArguments: '{"command":"touch blocked.txt"}',
		},
		{ cwd: process.cwd(), shell: shellRuntime },
	);

	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /read_only mode blocks write/i);
});

test("bash workspace_write mode rejects writes outside the workspace", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const tools = new ToolRegistry([
		createBashTool(
			shellRuntime,
			{ mode: "workspace_write" },
			new ReadTracker(),
		),
	]);

	const result = await tools.execute(
		{
			id: "call_shell_ww_1",
			name: "bash",
			arguments: { command: "touch ../escape.txt" },
			rawArguments: '{"command":"touch ../escape.txt"}',
		},
		{ cwd: process.cwd(), shell: shellRuntime },
	);

	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /outside the workspace/);
});

test("bash workspace_write mode detects common external write targets", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const tools = new ToolRegistry([
		createBashTool(
			shellRuntime,
			{ mode: "workspace_write" },
			new ReadTracker(),
		),
	]);

	for (const command of [
		"printf 'x' > ../escape.txt",
		"printf 'x' | tee ../escape.txt",
		"cp source.txt ../escape.txt",
		"mv source.txt '../escape file.txt'",
		"install source.txt ../bin/escape.txt",
	]) {
		const result = await tools.execute(
			{
				id: `call_shell_external_${command}`,
				name: "bash",
				arguments: { command },
				rawArguments: JSON.stringify({ command }),
			},
			{ cwd: process.cwd(), shell: shellRuntime },
		);

		assert.equal(result.ok, false, command);
		assert.match(result.error ?? "", /outside the workspace/, command);
	}
});

test("bash reports timeouts in command results", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const tools = new ToolRegistry([
		createBashTool(
			shellRuntime,
			{ mode: "workspace_write" },
			new ReadTracker(),
		),
	]);

	const result = await tools.execute(
		{
			id: "call_shell_timeout_1",
			name: "bash",
			arguments: { command: "sleep 1", timeout: 20 },
			rawArguments: '{"command":"sleep 1","timeout":20}',
		},
		{ cwd: process.cwd(), shell: shellRuntime },
	);

	assert.equal(result.ok, true);
	assert.equal(typeof result.data, "object");
	assert.equal((result.data as { ok: boolean }).ok, false);
	assert.equal((result.data as { timedOut: boolean }).timedOut, true);
});

test("bash truncates long output and marks truncation flags", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const tools = new ToolRegistry([
		createBashTool(
			shellRuntime,
			{ mode: "workspace_write" },
			new ReadTracker(),
		),
	]);

	const result = await tools.execute(
		{
			id: "call_shell_long_1",
			name: "bash",
			arguments: {
				command: "python3 -c \"print('x' * 200)\"",
				maxOutputChars: 120,
			},
			rawArguments:
				'{"command":"python3 -c \\"print(\'x\' * 200)\\"","maxOutputChars":120}',
		},
		{ cwd: process.cwd(), shell: shellRuntime },
	);

	assert.equal(result.ok, true);
	const longData = result.data as {
		stdoutTruncated: boolean;
		overflowPath?: string;
		stdout: string;
	};
	assert.equal(longData.stdoutTruncated, true);
	assert.ok(longData.overflowPath, "expected an overflow file path");
	assert.match(longData.stdout, /x/);
	// The full output must be preserved in the overflow file.
	const overflowFile = longData.overflowPath;
	assert.ok(typeof overflowFile === "string", "expected an overflow file path");
	const overflow = await readFile(overflowFile, "utf8");
	assert.match(overflow, /x{200}/);
});

test("bash carries the working directory across calls within the project", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const startDir = process.cwd();
	const workingDir = {
		current: startDir,
		projectDir: startDir,
		maintainProjectWorkingDir: false,
	};
	const outputDir = await createTempDir("sigpi-bash-test-");
	const tools = new ToolRegistry([
		createBashTool(
			shellRuntime,
			{ mode: "workspace_write" },
			new ReadTracker(),
		),
	]);
	const ctx = {
		cwd: startDir,
		bash: { workingDir, outputDir },
		allowedReadRoots: [outputDir],
	};

	const subDir = path.join(startDir, `bash-cd-${randomUUID()}`);
	await mkdir(subDir, { recursive: true });
	try {
		await tools.execute(
			{
				id: "cd_1",
				name: "bash",
				arguments: { command: `cd '${subDir}'` },
				rawArguments: `{"command":"cd '${subDir}'"}`,
			},
			ctx,
		);
		assert.equal(workingDir.current, subDir);

		const pwd = await tools.execute(
			{
				id: "pwd_1",
				name: "bash",
				arguments: { command: "pwd" },
				rawArguments: '{"command":"pwd"}',
			},
			ctx,
		);
		assert.equal((pwd.data as { stdout: string }).stdout.trim(), subDir);
	} finally {
		await rm(subDir, { recursive: true, force: true }).catch(() => {});
	}
});

test("bash resets the working directory to the project dir when a command escapes it", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const startDir = process.cwd();
	const workingDir = {
		current: startDir,
		projectDir: startDir,
		maintainProjectWorkingDir: false,
	};
	const outputDir = await createTempDir("sigpi-bash-test-");
	const tools = new ToolRegistry([
		createBashTool(
			shellRuntime,
			{ mode: "workspace_write" },
			new ReadTracker(),
		),
	]);
	const ctx = {
		cwd: startDir,
		bash: { workingDir, outputDir },
		allowedReadRoots: [outputDir],
	};

	await tools.execute(
		{
			id: "cd_esc",
			name: "bash",
			arguments: { command: "cd /tmp" },
			rawArguments: '{"command":"cd /tmp"}',
		},
		ctx,
	);
	assert.equal(
		workingDir.current,
		startDir,
		"cwd outside the project should reset to the project dir",
	);
});

test("bash runs a command in the background and tracks it", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const startDir = process.cwd();
	const workingDir = {
		current: startDir,
		projectDir: startDir,
		maintainProjectWorkingDir: false,
	};
	const outputDir = await createTempDir("sigpi-bash-test-");
	const manager = new BackgroundTaskManager();
	const tools = new ToolRegistry([
		createBashTool(
			shellRuntime,
			{ mode: "workspace_write" },
			new ReadTracker(),
		),
	]);
	const ctx = {
		cwd: startDir,
		bash: {
			workingDir,
			outputDir,
			tasks: manager,
		},
		allowedReadRoots: [outputDir],
	};

	const result = await tools.execute(
		{
			id: "bg_1",
			name: "bash",
			arguments: { command: "sleep 2", run_in_background: true },
			rawArguments: '{"command":"sleep 2","run_in_background":true}',
		},
		ctx,
	);

	assert.equal(result.ok, true);
	const data = result.data as {
		task_id: string;
		status: string;
		log_path: string;
		pid: number | null;
	};
	assert.equal(data.status, "running");
	assert.ok(data.task_id);
	assert.ok(data.log_path);
	assert.equal(existsSync(data.log_path), true);

	const task = manager.get(data.task_id);
	assert.ok(task);
	assert.equal(task?.status, "running");

	assert.equal(manager.stop(data.task_id), true);
	await waitFor(() => manager.get(data.task_id)?.status === "done", 3000);
	assert.equal(manager.get(data.task_id)?.status, "done");
});

test("bash rejects run_in_background when no task manager is available", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const tools = new ToolRegistry([
		createBashTool(
			shellRuntime,
			{ mode: "workspace_write" },
			new ReadTracker(),
		),
	]);
	const ctx = { cwd: process.cwd() };

	const result = await tools.execute(
		{
			id: "bg_2",
			name: "bash",
			arguments: { command: "sleep 2", run_in_background: true },
			rawArguments: '{"command":"sleep 2","run_in_background":true}',
		},
		ctx,
	);

	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /background task manager/);
});

test("bash does not hit E2BIG with a very large captured-rc preamble", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const startDir = process.cwd();
	const workingDir = {
		current: startDir,
		projectDir: startDir,
		maintainProjectWorkingDir: false,
	};
	const outputDir = await createTempDir("sigpi-bash-test-");
	const rcDir = await createTempDir("sigpi-bash-test-");
	const rcFile = path.join(rcDir, "rc.sh");
	// Simulate a heavy rc (oh-my-zsh + many aliases/functions) that previously
	// blew past the OS single-argument limit when inlined into the command.
	const huge = Array.from(
		{ length: 30000 },
		(_, i) => `alias hugealias${i}='echo ${i}'`,
	).join("\n");
	await writeFile(rcFile, huge);
	const tools = new ToolRegistry([
		createBashTool(
			shellRuntime,
			{ mode: "workspace_write" },
			new ReadTracker(),
		),
	]);
	const ctx = {
		cwd: startDir,
		bash: {
			workingDir,
			outputDir,
			rcDefinitionsFile: rcFile,
		},
		allowedReadRoots: [outputDir],
	};

	const result = await tools.execute(
		{
			id: "e2big_1",
			name: "bash",
			arguments: { command: "pwd && ls -la" },
			rawArguments: '{"command":"pwd && ls -la"}',
		},
		ctx,
	);

	assert.equal(result.ok, true);
});

test("bash resets to the project working dir when maintainProjectWorkingDir is set", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const startDir = process.cwd();
	const workingDir = {
		current: startDir,
		projectDir: startDir,
		maintainProjectWorkingDir: true,
	};
	const outputDir = await createTempDir("sigpi-bash-test-");
	const tools = new ToolRegistry([
		createBashTool(
			shellRuntime,
			{ mode: "workspace_write" },
			new ReadTracker(),
		),
	]);
	const ctx = {
		cwd: startDir,
		bash: { workingDir, outputDir },
		allowedReadRoots: [outputDir],
	};

	await tools.execute(
		{
			id: "cd_2",
			name: "bash",
			arguments: { command: "cd /tmp" },
			rawArguments: '{"command":"cd /tmp"}',
		},
		ctx,
	);
	assert.equal(
		workingDir.current,
		startDir,
		"cwd should reset to project dir after the command",
	);

	const pwd = await tools.execute(
		{
			id: "pwd_2",
			name: "bash",
			arguments: { command: "pwd" },
			rawArguments: '{"command":"pwd"}',
		},
		ctx,
	);
	assert.equal((pwd.data as { stdout: string }).stdout.trim(), startDir);
});

test("detectShellRuntime defaults to powershell on Windows", () => {
	const shellRuntime = detectShellRuntime({}, "win32");

	assert.equal(shellRuntime.shell, "powershell");
	assert.equal(shellRuntime.executable, "powershell.exe");
});

test("detectShellRuntime prefers bash in Windows Git Bash environments", () => {
	const shellRuntime = detectShellRuntime({}, "win32", {
		SHELL: "/usr/bin/bash",
		MSYSTEM: "MINGW64",
		TERM_PROGRAM: "mintty",
	});

	assert.equal(shellRuntime.shell, "bash");
	assert.equal(shellRuntime.executable, "bash");
});

test("detectShellRuntime infers shell kind from configured executable path", () => {
	const shellRuntime = detectShellRuntime(
		{
			path: "C:\\Program Files\\Git\\bin\\bash.exe",
		},
		"win32",
	);

	assert.equal(shellRuntime.shell, "bash");
	assert.equal(
		shellRuntime.executable,
		"C:\\Program Files\\Git\\bin\\bash.exe",
	);
});

test("buildShellInvocation uses Windows PowerShell command flags", () => {
	const shellRuntime = createShellRuntime("powershell", "win32");
	const command = "Write-Output '编译失败'";
	const invocation = buildShellInvocation(shellRuntime, command);

	assert.equal(invocation.executable, "powershell.exe");
	assert.deepEqual(invocation.args.slice(0, -1), [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-EncodedCommand",
	]);
	assert.notEqual(invocation.args.at(-1), command);

	const script = decodePowerShellEncodedCommand(invocation.args.at(-1) ?? "");
	assert.match(script, /\[Console\]::InputEncoding = \$__sigpiUtf8/);
	assert.match(script, /\[Console\]::OutputEncoding = \$__sigpiUtf8/);
	assert.match(script, /\$OutputEncoding = \$__sigpiUtf8/);
	assert.match(script, /Invoke-Expression \$__sigpiCommand/);
	assert.equal(extractWrappedPowerShellCommand(script), command);
});

test("buildShellInvocation uses encoded command flags for PowerShell 7", () => {
	const shellRuntime = createShellRuntime("pwsh", "win32");
	const invocation = buildShellInvocation(shellRuntime, "Get-ChildItem");

	assert.equal(invocation.executable, "pwsh.exe");
	assert.deepEqual(invocation.args.slice(0, -1), [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-EncodedCommand",
	]);
	assert.equal(
		extractWrappedPowerShellCommand(
			decodePowerShellEncodedCommand(invocation.args.at(-1) ?? ""),
		),
		"Get-ChildItem",
	);
});

test("buildSystemPrompt includes platform, shell, and tool safety details", () => {
	const prompt = buildSystemPrompt(createShellRuntime("powershell", "win32"));

	assert.match(prompt, /Current platform: win32/);
	assert.match(prompt, /Current shell for bash: powershell/);
	assert.match(prompt, /Tool safety mode: workspace_write/);
	assert.match(prompt, /not a strong sandbox/i);
	assert.match(prompt, /glob tool with a pattern to find files by name/i);
	assert.match(prompt, /when glob can answer it/i);
	assert.match(prompt, /edit tool for targeted changes/i);
	assert.match(prompt, /read-before-edit/i);
	assert.match(prompt, /old_string/i);
	assert.match(prompt, /new_string/i);
	assert.match(
		prompt,
		/use the provided offset and limit metadata to continue/i,
	);
	assert.match(prompt, /Use the tool's continuation metadata/i);
	assert.doesNotMatch(prompt, /replace_in_file/);
	assert.doesNotMatch(prompt, /apply_text_edits/);
	assert.match(
		prompt,
		/treat the task as incomplete until you verify the change/i,
	);
	assert.match(
		prompt,
		/use bash for the narrowest relevant validation command/i,
	);
	assert.match(prompt, /update_plan/i);
	assert.doesNotMatch(prompt, /apply_unified_patch/i);
});

test("glob schema describes pattern-based file search", () => {
	const parameters = globTool.parameters as {
		properties?: {
			pattern?: { description?: string };
			path?: { description?: string };
		};
	};

	assert.match(globTool.description, /glob patterns/i);
	assert.match(globTool.description, /modification time/i);
	assert.match(
		String(parameters.properties?.pattern?.description),
		/glob pattern/i,
	);
	assert.match(
		String(parameters.properties?.path?.description),
		/subdirectory/i,
	);
});

test("edit schema describes old_string, new_string, and replace_all", () => {
	const edit = createEditTool({ mode: "workspace_write" }, new ReadTracker());
	const parameters = edit.parameters as {
		properties?: {
			file_path?: { description?: string };
			old_string?: { description?: string };
			new_string?: { description?: string };
			replace_all?: { description?: string };
		};
		required?: string[];
	};

	assert.match(edit.description, /exact string replacement/i);
	assert.match(edit.description, /read-before-edit/i);
	assert.equal(typeof parameters.properties?.file_path, "object");
	assert.equal(typeof parameters.properties?.old_string, "object");
	assert.equal(typeof parameters.properties?.new_string, "object");
	assert.equal(typeof parameters.properties?.replace_all, "object");
	assert.deepEqual([...new Set(parameters.required ?? [])].sort(), [
		"file_path",
		"new_string",
		"old_string",
	]);
});

test("update_plan tracks exactly one in-progress step while active", async () => {
	const tools = new ToolRegistry([createUpdatePlanTool()]);

	const result = await tools.execute(
		{
			id: "call_plan_1",
			name: "update_plan",
			arguments: {
				plan: [
					{ step: "Inspect code", status: "completed" },
					{ step: "Patch behavior", status: "in_progress" },
					{ step: "Run tests", status: "pending" },
				],
			},
			rawArguments: "{}",
		},
		{ cwd: process.cwd() },
	);

	assert.equal(result.ok, true);
	assert.match(
		(result.data as { rendered: string }).rendered,
		/🔄 Patch behavior/,
	);
});

test("update_plan progress renders a concise checklist instead of JSON", () => {
	const describePlan = updatePlanTool.describeProgress;
	assert.ok(describePlan);
	const progress = describePlan({
		explanation: "Tighten progress output",
		plan: [
			{ step: "Inspect logging", status: "completed" },
			{ step: "Patch rendering", status: "in_progress" },
			{ step: "Run tests", status: "pending" },
		],
	});

	assert.equal(progress.summary, "plan");
	assert.match(progress.detail ?? "", /1\. ✅ Inspect logging/);
	assert.match(progress.detail ?? "", /2\. 🔄 Patch rendering/);
	assert.match(progress.detail ?? "", /3\. ⬜ Run tests/);
	assert.doesNotMatch(progress.detail ?? "", /"status"/);
});

test("update_plan shows activeForm for the in_progress step", () => {
	const describePlan = updatePlanTool.describeProgress;
	assert.ok(describePlan);
	const progress = describePlan({
		plan: [
			{ step: "Inspect logging", status: "completed" },
			{
				step: "Patch rendering",
				status: "in_progress",
				activeForm: "Patching the renderer",
			},
			{ step: "Run tests", status: "pending" },
		],
	});

	assert.equal(progress.summary, "plan");
	assert.match(progress.detail ?? "", /🔄 Patching the renderer/);
	assert.doesNotMatch(progress.detail ?? "", /Patch rendering/);
});

test("update_plan accepts blank activeForm on non-active steps", async () => {
	const tools = new ToolRegistry([createUpdatePlanTool()]);

	const result = await tools.execute(
		{
			id: "call_plan_blank_active_form",
			name: "update_plan",
			arguments: {
				plan: [
					{ step: "Inspect code", status: "completed", activeForm: "" },
					{
						step: "Patch behavior",
						status: "in_progress",
						activeForm: "Patching behavior",
					},
					{ step: "Run tests", status: "pending", activeForm: "" },
				],
			},
			rawArguments: "{}",
		},
		{ cwd: process.cwd() },
	);

	assert.equal(result.ok, true);
	assert.match(
		(result.data as { rendered: string }).rendered,
		/🔄 Patching behavior/,
	);
});

test("write returns edit summary for TUI display", async () => {
	const cwd = await createTempDir("sigpi-write-edit-summary-");
	await writeWorkspaceFile(cwd, "demo.txt", "alpha\nold\n");
	const tools = new ToolRegistry([
		createWriteTool({ mode: "workspace_write" }, new ReadTracker()),
	]);

	const result = await tools.execute(
		{
			id: "call_write_summary_1",
			name: "write",
			arguments: {
				file_path: "demo.txt",
				content: "alpha\nnew\n",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);

	assert.equal(result.ok, true);
	assert.deepEqual((result.data as { editSummary: unknown }).editSummary, {
		kind: "file_edit",
		path: "demo.txt",
		paths: ["demo.txt"],
		additions: 2,
		deletions: 2,
		preview: [
			{ kind: "remove", lineNumber: 1, text: "alpha" },
			{ kind: "remove", lineNumber: 2, text: "old" },
			{ kind: "add", lineNumber: 1, text: "alpha" },
			{ kind: "add", lineNumber: 2, text: "new" },
		],
		truncated: false,
	});
});

test("update_plan accepts a plan with no in_progress step", async () => {
	const tools = new ToolRegistry([createUpdatePlanTool()]);

	const result = await tools.execute(
		{
			id: "call_plan_2",
			name: "update_plan",
			arguments: {
				plan: [
					{ step: "Inspect code", status: "pending" },
					{ step: "Patch behavior", status: "pending" },
				],
			},
			rawArguments: "{}",
		},
		{ cwd: process.cwd() },
	);

	assert.equal(result.ok, true);
});

test("edit requires a prior read and performs an exact unique replacement", async () => {
	const cwd = await createTempDir("sigpi-edit-basic-");
	await writeWorkspaceFile(cwd, "demo.txt", "alpha\nbeta\n");
	const tracker = new ReadTracker();
	const tools = new ToolRegistry([
		createReadTool(tracker),
		createEditTool({ mode: "workspace_write" }, tracker),
	]);

	// Without reading first, edit is rejected (read-before-edit).
	const beforeRead = await tools.execute(
		{
			id: "call_edit_noread",
			name: "edit",
			arguments: {
				file_path: "demo.txt",
				old_string: "beta",
				new_string: "gamma",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(beforeRead.ok, false);
	assert.match(beforeRead.error ?? "", /not been read/i);

	// Reading records the file; now edit succeeds.
	await tools.execute(
		{
			id: "call_read_first",
			name: "read",
			arguments: { file_path: "demo.txt" },
			rawArguments: "{}",
		},
		{ cwd },
	);

	const result = await tools.execute(
		{
			id: "call_edit_1",
			name: "edit",
			arguments: {
				file_path: "demo.txt",
				old_string: "beta",
				new_string: "gamma",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);

	assert.equal(result.ok, true);
	assert.equal(
		await readFile(path.join(cwd, "demo.txt"), "utf8"),
		"alpha\ngamma\n",
	);
});

test("edit rejects editing a file that does not exist", async () => {
	const cwd = await createTempDir("sigpi-edit-noexist-");
	const tools = new ToolRegistry([
		createEditTool({ mode: "workspace_write" }, new ReadTracker()),
	]);

	const result = await tools.execute(
		{
			id: "call_edit_missing",
			name: "edit",
			arguments: {
				file_path: "missing.txt",
				old_string: "x",
				new_string: "y",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);

	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /does not exist/i);
});

test("read_only tool safety mode rejects edit and write", async () => {
	const cwd = await createTempDir("sigpi-read-only-tools-");
	await writeWorkspaceFile(cwd, "demo.txt", "alpha\n");
	const tools = createDefaultToolRegistry(undefined, { mode: "read_only" });

	await tools.execute(
		{
			id: "call_read_ro",
			name: "read",
			arguments: { file_path: "demo.txt" },
			rawArguments: "{}",
		},
		{ cwd },
	);

	const editResult = await tools.execute(
		{
			id: "call_edit_ro_1",
			name: "edit",
			arguments: {
				file_path: "demo.txt",
				old_string: "alpha",
				new_string: "beta",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(editResult.ok, false);
	assert.match(editResult.error ?? "", /read_only tool safety mode/);

	const writeResult = await tools.execute(
		{
			id: "call_write_ro_1",
			name: "write",
			arguments: { file_path: "demo.txt", content: "beta\n" },
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(writeResult.ok, false);
	assert.match(writeResult.error ?? "", /read_only tool safety mode/);
	assert.equal(await readFile(path.join(cwd, "demo.txt"), "utf8"), "alpha\n");
});

test("createBashTool respects shell runtime in results", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const tools = new ToolRegistry([
		createBashTool(
			shellRuntime,
			{ mode: "workspace_write" },
			new ReadTracker(),
		),
	]);

	const result = await tools.execute(
		{
			id: "call_shell_3",
			name: "bash",
			arguments: { command: "printf 'ok'" },
			rawArguments: '{"command":"printf \'ok\'"}',
		},
		{
			cwd: process.cwd(),
			shell: shellRuntime,
		},
	);

	assert.equal(result.ok, true);
	assert.equal(typeof result.data, "object");
	assert.equal((result.data as { shell: string }).shell, "sh");
});

test("glob lists matching files efficiently", async () => {
	const tools = new ToolRegistry([globTool]);

	const result = await tools.execute(
		{
			id: "call_list_1",
			name: "glob",
			arguments: { pattern: "src/tools/**/*.ts" },
			rawArguments: '{"pattern":"src/tools/**/*.ts"}',
		},
		{ cwd: process.cwd() },
	);

	assert.equal(result.ok, true);
	assert.equal(typeof result.data, "object");
	assert.match(JSON.stringify(result.data), /src\/tools\/index\.ts/);
	assert.match((result.data as { rendered: string }).rendered, /Files:/);
});

test("grep finds content matches with line numbers", async () => {
	const tools = new ToolRegistry([grepTool]);

	const result = await tools.execute(
		{
			id: "call_search_1",
			name: "grep",
			arguments: {
				pattern: "createDefaultToolRegistry",
				glob: "src/**/*.ts",
				output_mode: "content",
			},
			rawArguments:
				'{"pattern":"createDefaultToolRegistry","glob":"src/**/*.ts","output_mode":"content"}',
		},
		{ cwd: process.cwd() },
	);

	assert.equal(result.ok, true);
	assert.equal(typeof result.data, "object");
	assert.match(
		(result.data as { matches: string }).matches,
		/src\/tools\/index\.ts:\d+:/,
	);
	assert.match((result.data as { rendered: string }).rendered, /Matches:/);
});

test("grep lists matching files in files_with_matches output mode", async () => {
	const tools = new ToolRegistry([grepTool]);

	const result = await tools.execute(
		{
			id: "call_search_2",
			name: "grep",
			arguments: {
				pattern: "createDefaultToolRegistry",
				glob: "src/**/*.ts",
				output_mode: "files_with_matches",
			},
			rawArguments:
				'{"pattern":"createDefaultToolRegistry","glob":"src/**/*.ts","output_mode":"files_with_matches"}',
		},
		{ cwd: process.cwd() },
	);

	assert.equal(result.ok, true);
	assert.equal(typeof result.data, "object");
	assert.match(
		(result.data as { matches: string }).matches,
		/src\/tools\/index\.ts/,
	);
	assert.match(
		(result.data as { rendered: string }).rendered,
		/Total match count:/,
	);
});

test("grep budgets content output with truncation metadata", async () => {
	const tools = new ToolRegistry([
		createGrepTool((async () => ({
			stdout: Array.from(
				{ length: 30 },
				(_, i) => `src/file${i}.ts:${i + 1}:${"x".repeat(600)}`,
			).join("\n"),
			stderr: "",
		})) as never),
	]);

	const result = await tools.execute(
		{
			id: "call_search_budget_1",
			name: "grep",
			arguments: {
				pattern: "x",
				glob: "src/**/*.ts",
				output_mode: "content",
			},
			rawArguments:
				'{"pattern":"x","glob":"src/**/*.ts","output_mode":"content"}',
		},
		{ cwd: process.cwd() },
	);

	assert.equal(result.ok, true);
	assert.equal(
		(result.data as { totalMatchCount: number }).totalMatchCount,
		30,
	);
	assert.equal(
		(result.data as { returnedMatchCount: number }).returnedMatchCount,
		30,
	);
	assert.equal((result.data as { truncated: boolean }).truncated, true);
	assert.doesNotMatch(
		(result.data as { matches: string }).matches,
		/src\/file29\.ts/,
	);
	assert.match(
		(result.data as { rendered: string }).rendered,
		/Truncated: yes/,
	);
});

test("grep falls back when ripgrep is unavailable", async () => {
	const tools = new ToolRegistry([
		createGrepTool((async () => {
			const error = Object.assign(new Error("spawn rg ENOENT"), {
				code: "ENOENT",
			});
			throw error;
		}) as never),
	]);

	const result = await tools.execute(
		{
			id: "call_search_fallback_1",
			name: "grep",
			arguments: {
				pattern: "createDefaultToolRegistry",
				glob: "src/**/*.ts",
				output_mode: "content",
			},
			rawArguments:
				'{"pattern":"createDefaultToolRegistry","glob":"src/**/*.ts","output_mode":"content"}',
		},
		{ cwd: process.cwd() },
	);

	assert.equal(result.ok, true);
	assert.match(JSON.stringify(result.data), /usedFallback/);
	assert.match(
		(result.data as { rendered: string }).rendered,
		/Engine: Node\.js fallback/,
	);
});

test("grep applies head_limit and offset through ripgrep", async () => {
	const tools = new ToolRegistry([grepTool]);

	const limited = await tools.execute(
		{
			id: "call_search_hl_1",
			name: "grep",
			arguments: {
				pattern: "ToolDefinition",
				output_mode: "content",
				head_limit: 1,
			},
			rawArguments:
				'{"pattern":"ToolDefinition","output_mode":"content","head_limit":1}',
		},
		{ cwd: process.cwd() },
	);

	assert.equal(limited.ok, true);
	assert.equal(
		(limited.data as { returnedMatchCount: number }).returnedMatchCount,
		1,
	);

	const offset = await tools.execute(
		{
			id: "call_search_off_1",
			name: "grep",
			arguments: {
				pattern: "ToolDefinition",
				output_mode: "content",
				head_limit: 1,
				offset: 1,
			},
			rawArguments:
				'{"pattern":"ToolDefinition","output_mode":"content","head_limit":1,"offset":1}',
		},
		{ cwd: process.cwd() },
	);

	assert.equal(offset.ok, true);
	assert.equal(
		(offset.data as { returnedMatchCount: number }).returnedMatchCount,
		1,
	);
});

test("glob falls back when ripgrep is unavailable", async () => {
	const tools = new ToolRegistry([
		createGlobTool((async () => {
			const error = Object.assign(new Error("spawn rg ENOENT"), {
				code: "ENOENT",
			});
			throw error;
		}) as never),
	]);

	const result = await tools.execute(
		{
			id: "call_list_fallback_1",
			name: "glob",
			arguments: { pattern: "src/tools/**/*.ts" },
			rawArguments: '{"pattern":"src/tools/**/*.ts"}',
		},
		{ cwd: process.cwd() },
	);

	assert.equal(result.ok, true);
	assert.match(JSON.stringify(result.data), /ripgrep not available/);
	assert.match((result.data as { rendered: string }).rendered, /Note:/);
});

test("read reads a bounded line range with offset and limit", async () => {
	const tools = new ToolRegistry([readTool]);

	const result = await tools.execute(
		{
			id: "call_chunk_1",
			name: "read",
			arguments: {
				file_path: "src/tools/index.ts",
				offset: 0,
				limit: 20,
			},
			rawArguments: '{"file_path":"src/tools/index.ts","offset":0,"limit":20}',
		},
		{ cwd: process.cwd() },
	);

	assert.equal(result.ok, true);
	assert.equal(typeof result.data, "object");
	assert.equal(
		(result.data as { returnedLineStart: number }).returnedLineStart,
		1,
	);
	assert.equal(
		(result.data as { returnedLineEnd: number }).returnedLineEnd,
		20,
	);
	assert.match(
		(result.data as { content: string }).content,
		/createDefaultToolRegistry/,
	);
	assert.match(
		(result.data as { rendered: string }).rendered,
		/Read .*lines 1-20 of/,
	);
});

test("read returns PARTIAL notice with continuation when truncated by char limit", async () => {
	const cwd = await createTempDir("sigpi-read-text-");
	await writeWorkspaceFile(cwd, "demo.txt", "abcdefghij");
	const tools = new ToolRegistry([readTool]);

	const result = await tools.execute(
		{
			id: "call_read_text_1",
			name: "read",
			arguments: { file_path: "demo.txt" },
			rawArguments: '{"file_path":"demo.txt"}',
		},
		{ cwd },
	);

	assert.equal(result.ok, true);
	assert.match((result.data as { rendered: string }).rendered, /demo\.txt/);
	assert.equal((result.data as { totalLines: number }).totalLines, 1);
	assert.equal((result.data as { totalChars: number }).totalChars, 10);
	assert.equal((result.data as { truncated: boolean }).truncated, false);
	assert.equal((result.data as { content: string }).content, "1 │ abcdefghij");
});

test("read wraps content with non-conflict markers even when file contains conflict-like text", async () => {
	const cwd = await createTempDir("sigpi-read-text-conflict-");
	const conflictBody = [
		"<<<<<<< HEAD",
		"name: alice",
		"=======",
		"name: bob",
		">>>>>>> branch-a",
	].join("\n");
	await writeWorkspaceFile(cwd, "demo.txt", conflictBody);
	const tools = new ToolRegistry([readTool]);

	const result = await tools.execute(
		{
			id: "call_read_text_conflict",
			name: "read",
			arguments: { file_path: "demo.txt" },
			rawArguments: '{"file_path":"demo.txt"}',
		},
		{ cwd },
	);

	assert.equal(result.ok, true);
	const rendered = (result.data as { rendered: string }).rendered;
	assert.match(rendered, /=== CONTENT START ===/);
	assert.match(rendered, /=== CONTENT END ===/);
	assert.doesNotMatch(rendered, /<<<<<<< CONTENT/);
	assert.doesNotMatch(rendered, />>>>>>> END_CONTENT/);
});

test("read with explicit offset and limit reads the requested lines", async () => {
	const cwd = await createTempDir("sigpi-read-text-next-");
	await writeWorkspaceFile(cwd, "demo.txt", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj");
	const tools = new ToolRegistry([readTool]);

	const result = await tools.execute(
		{
			id: "call_read_text_2",
			name: "read",
			arguments: { file_path: "demo.txt", offset: 4, limit: 3 },
			rawArguments: '{"file_path":"demo.txt","offset":4,"limit":3}',
		},
		{ cwd },
	);

	assert.equal(result.ok, true);
	assert.equal(
		(result.data as { returnedLineStart: number }).returnedLineStart,
		5,
	);
	assert.equal((result.data as { returnedLineEnd: number }).returnedLineEnd, 7);
	assert.equal((result.data as { truncated: boolean }).truncated, false);
	const content = (result.data as { content: string }).content;
	assert.match(content, /5 │ e/);
	assert.match(content, /7 │ g/);
});

test("read returns PARTIAL with continuation when file exceeds char limit", async () => {
	const cwd = await createTempDir("sigpi-read-chunk-");
	await writeWorkspaceFile(cwd, "demo.txt", "aaaa\nbbbb\ncccc");
	const tools = new ToolRegistry([readTool]);

	// DEFAULT_READ_MAX_CHARS is 51200, so this won't truncate on a 3-line file.
	// We write a larger file to trigger truncation.
	const bigContent = Array.from(
		{ length: 6000 },
		(_, i) => `Line ${i + 1}`,
	).join("\n");
	await writeWorkspaceFile(cwd, "big.txt", bigContent);

	const result = await tools.execute(
		{
			id: "call_chunk_2",
			name: "read",
			arguments: { file_path: "big.txt" },
			rawArguments: '{"file_path":"big.txt"}',
		},
		{ cwd },
	);

	assert.equal(result.ok, true);
	assert.equal((result.data as { truncated: boolean }).truncated, true);
	assert.notEqual(
		(result.data as { continuation: unknown }).continuation,
		null,
	);
	const rendered = (result.data as { rendered: string }).rendered;
	assert.match(rendered, /PARTIAL view/);
	assert.match(rendered, /Read big.txt lines 1-/);
	assert.match(rendered, /=== CONTENT START ===/);
	assert.match(rendered, /=== CONTENT END ===/);
});

test("read throws error when explicit range exceeds char limit", async () => {
	const cwd = await createTempDir("sigpi-read-chunk-explicit-");
	// Create file with content well over DEFAULT_READ_MAX_CHARS
	const bigContent = "x".repeat(60_000);
	await writeWorkspaceFile(cwd, "big.txt", bigContent);
	const tools = new ToolRegistry([readTool]);

	const result = await tools.execute(
		{
			id: "call_chunk_explicit",
			name: "read",
			arguments: { file_path: "big.txt", offset: 0, limit: 1 },
			rawArguments: '{"file_path":"big.txt","offset":0,"limit":1}',
		},
		{ cwd },
	);

	assert.equal(result.ok, false);
	assert.match(
		result.error ?? "",
		/exceeds the maximum allowed character count/,
	);
});

test("read default reads an entire small file without truncation", async () => {
	const cwd = await createTempDir("sigpi-read-default-window-");
	// 12K + "\nend" is well under DEFAULT_READ_MAX_CHARS
	const content = `${"x".repeat(12_000)}\nend`;
	await writeWorkspaceFile(cwd, "demo.txt", content);
	const tools = new ToolRegistry([readTool]);

	const result = await tools.execute(
		{
			id: "call_read_default_window_1",
			name: "read",
			arguments: { file_path: "demo.txt" },
			rawArguments: '{"file_path":"demo.txt"}',
		},
		{ cwd },
	);

	assert.equal(result.ok, true);
	assert.equal((result.data as { truncated: boolean }).truncated, false);
	assert.match((result.data as { rendered: string }).rendered, /Read demo.txt/);
});

test("read with explicit offset/limit near end of file works", async () => {
	const cwd = await createTempDir("sigpi-read-lines-default-window-");
	const lines = Array.from(
		{ length: DEFAULT_READ_MAX_LINES + 5 },
		(_, index) => `Line ${index + 1}`,
	);
	await writeWorkspaceFile(cwd, "demo.txt", lines.join("\n"));
	const tools = new ToolRegistry([readTool]);

	const result = await tools.execute(
		{
			id: "call_read_lines_default_window_1",
			name: "read",
			arguments: {
				file_path: "demo.txt",
				offset: DEFAULT_READ_MAX_LINES,
				limit: 5,
			},
			rawArguments: '{"file_path":"demo.txt","offset":2000,"limit":5}',
		},
		{ cwd },
	);

	assert.equal(result.ok, true);
	assert.equal(
		(result.data as { returnedLineEnd: number }).returnedLineEnd,
		DEFAULT_READ_MAX_LINES + 5,
	);
	assert.equal((result.data as { truncated: boolean }).truncated, false);
	assert.match(
		(result.data as { rendered: string }).rendered,
		/Read demo.txt lines/,
	);
});

test("edit fails when old_string is not found", async () => {
	const cwd = await createTempDir("sigpi-edit-nomatch-");
	await writeWorkspaceFile(cwd, "demo.txt", "alpha\nbeta\n");
	const tracker = new ReadTracker();
	const tools = new ToolRegistry([
		createReadTool(tracker),
		createEditTool({ mode: "workspace_write" }, tracker),
	]);
	await tools.execute(
		{
			id: "r",
			name: "read",
			arguments: { file_path: "demo.txt" },
			rawArguments: "{}",
		},
		{ cwd },
	);
	const result = await tools.execute(
		{
			id: "e",
			name: "edit",
			arguments: { file_path: "demo.txt", old_string: "zzz", new_string: "y" },
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /not found/i);
	assert.equal(
		await readFile(path.join(cwd, "demo.txt"), "utf8"),
		"alpha\nbeta\n",
	);
});

test("edit fails when old_string matches multiple locations without replace_all", async () => {
	const cwd = await createTempDir("sigpi-edit-multi-");
	await writeWorkspaceFile(cwd, "demo.txt", "a\nb\na\nb\n");
	const tracker = new ReadTracker();
	const tools = new ToolRegistry([
		createReadTool(tracker),
		createEditTool({ mode: "workspace_write" }, tracker),
	]);
	await tools.execute(
		{
			id: "r",
			name: "read",
			arguments: { file_path: "demo.txt" },
			rawArguments: "{}",
		},
		{ cwd },
	);
	const result = await tools.execute(
		{
			id: "e",
			name: "edit",
			arguments: { file_path: "demo.txt", old_string: "a", new_string: "A" },
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /matched .* locations/i);
});

test("edit replace_all replaces every occurrence", async () => {
	const cwd = await createTempDir("sigpi-edit-all-");
	await writeWorkspaceFile(cwd, "demo.txt", "a\nb\na\nb\n");
	const tracker = new ReadTracker();
	const tools = new ToolRegistry([
		createReadTool(tracker),
		createEditTool({ mode: "workspace_write" }, tracker),
	]);
	await tools.execute(
		{
			id: "r",
			name: "read",
			arguments: { file_path: "demo.txt" },
			rawArguments: "{}",
		},
		{ cwd },
	);
	const result = await tools.execute(
		{
			id: "e",
			name: "edit",
			arguments: {
				file_path: "demo.txt",
				old_string: "a",
				new_string: "A",
				replace_all: true,
			},
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(result.ok, true);
	assert.equal(
		await readFile(path.join(cwd, "demo.txt"), "utf8"),
		"A\nb\nA\nb\n",
	);
});

test("edit with empty new_string deletes text", async () => {
	const cwd = await createTempDir("sigpi-edit-del-");
	await writeWorkspaceFile(cwd, "demo.txt", "keep\nremove\nkeep\n");
	const tracker = new ReadTracker();
	const tools = new ToolRegistry([
		createReadTool(tracker),
		createEditTool({ mode: "workspace_write" }, tracker),
	]);
	await tools.execute(
		{
			id: "r",
			name: "read",
			arguments: { file_path: "demo.txt" },
			rawArguments: "{}",
		},
		{ cwd },
	);
	const result = await tools.execute(
		{
			id: "e",
			name: "edit",
			arguments: {
				file_path: "demo.txt",
				old_string: "remove\n",
				new_string: "",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(result.ok, true);
	assert.equal(
		await readFile(path.join(cwd, "demo.txt"), "utf8"),
		"keep\nkeep\n",
	);
});

test("edit fails when the file changed on disk since it was read", async () => {
	const cwd = await createTempDir("sigpi-edit-changed-");
	await writeWorkspaceFile(cwd, "demo.txt", "alpha\nbeta\n");
	const tracker = new ReadTracker();
	const tools = new ToolRegistry([
		createReadTool(tracker),
		createEditTool({ mode: "workspace_write" }, tracker),
	]);
	await tools.execute(
		{
			id: "r",
			name: "read",
			arguments: { file_path: "demo.txt" },
			rawArguments: "{}",
		},
		{ cwd },
	);
	await writeWorkspaceFile(cwd, "demo.txt", "alpha\nCHANGED\n");
	const result = await tools.execute(
		{
			id: "e",
			name: "edit",
			arguments: {
				file_path: "demo.txt",
				old_string: "beta",
				new_string: "gamma",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /changed on disk since/i);
});

test("edit allows consecutive edits after refreshing the read fingerprint", async () => {
	const cwd = await createTempDir("sigpi-edit-consec-");
	await writeWorkspaceFile(cwd, "demo.txt", "one\ntwo\n");
	const tracker = new ReadTracker();
	const tools = new ToolRegistry([
		createReadTool(tracker),
		createEditTool({ mode: "workspace_write" }, tracker),
	]);
	await tools.execute(
		{
			id: "r",
			name: "read",
			arguments: { file_path: "demo.txt" },
			rawArguments: "{}",
		},
		{ cwd },
	);
	const first = await tools.execute(
		{
			id: "e1",
			name: "edit",
			arguments: {
				file_path: "demo.txt",
				old_string: "one",
				new_string: "ONE",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(first.ok, true);
	const second = await tools.execute(
		{
			id: "e2",
			name: "edit",
			arguments: {
				file_path: "demo.txt",
				old_string: "two",
				new_string: "TWO",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(second.ok, true);
	assert.equal(
		await readFile(path.join(cwd, "demo.txt"), "utf8"),
		"ONE\nTWO\n",
	);
});

test("edit does not normalize newlines and requires an exact CRLF/LF match", async () => {
	const cwd = await createTempDir("sigpi-edit-crlf-");
	await writeWorkspaceFile(cwd, "demo.txt", "alpha\r\nbeta\r\n");
	const tracker = new ReadTracker();
	const tools = new ToolRegistry([
		createReadTool(tracker),
		createEditTool({ mode: "workspace_write" }, tracker),
	]);
	await tools.execute(
		{
			id: "r",
			name: "read",
			arguments: { file_path: "demo.txt" },
			rawArguments: "{}",
		},
		{ cwd },
	);
	const lf = await tools.execute(
		{
			id: "e1",
			name: "edit",
			arguments: {
				file_path: "demo.txt",
				old_string: "alpha\nbeta",
				new_string: "x",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(lf.ok, false);
	assert.match(lf.error ?? "", /not found/i);
	const crlf = await tools.execute(
		{
			id: "e2",
			name: "edit",
			arguments: {
				file_path: "demo.txt",
				old_string: "alpha\r\nbeta",
				new_string: "x",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(crlf.ok, true);
	assert.equal(await readFile(path.join(cwd, "demo.txt"), "utf8"), "x\r\n");
});

test("edit requires a non-empty old_string", async () => {
	const cwd = await createTempDir("sigpi-edit-empty-");
	const tools = new ToolRegistry([
		createEditTool({ mode: "workspace_write" }, new ReadTracker()),
	]);
	const result = await tools.execute(
		{
			id: "e",
			name: "edit",
			arguments: { file_path: "demo.txt", old_string: "", new_string: "x" },
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /old_string/i);
});

test("write creates a new file and parent directories", async () => {
	const cwd = await createTempDir("sigpi-write-create-");
	const tools = new ToolRegistry([
		createWriteTool({ mode: "workspace_write" }, new ReadTracker()),
	]);
	const result = await tools.execute(
		{
			id: "w",
			name: "write",
			arguments: { file_path: "nested/dir/demo.txt", content: "fresh\n" },
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(result.ok, true);
	assert.equal(
		await readFile(path.join(cwd, "nested/dir/demo.txt"), "utf8"),
		"fresh\n",
	);
});

test("write overwrites an existing file without requiring a prior read", async () => {
	const cwd = await createTempDir("sigpi-write-overwrite-");
	await writeWorkspaceFile(cwd, "demo.txt", "old\n");
	const tools = new ToolRegistry([
		createWriteTool({ mode: "workspace_write" }, new ReadTracker()),
	]);
	const result = await tools.execute(
		{
			id: "w",
			name: "write",
			arguments: { file_path: "demo.txt", content: "new\n" },
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(result.ok, true);
	assert.equal(await readFile(path.join(cwd, "demo.txt"), "utf8"), "new\n");
});

test("bash cat records a read so a later edit is allowed", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const cwd = await createTempDir("sigpi-shell-read-");
	await writeWorkspaceFile(cwd, "demo.txt", "alpha\nbeta\n");
	const tracker = new ReadTracker();
	const tools = new ToolRegistry([
		createBashTool(shellRuntime, { mode: "workspace_write" }, tracker),
		createEditTool({ mode: "workspace_write" }, tracker),
	]);
	const cat = await tools.execute(
		{
			id: "s",
			name: "bash",
			arguments: { command: "cat demo.txt" },
			rawArguments: "{}",
		},
		{ cwd, shell: shellRuntime },
	);
	assert.equal(cat.ok, true);
	const edit = await tools.execute(
		{
			id: "e",
			name: "edit",
			arguments: {
				file_path: "demo.txt",
				old_string: "beta",
				new_string: "gamma",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(edit.ok, true);
	assert.equal(
		await readFile(path.join(cwd, "demo.txt"), "utf8"),
		"alpha\ngamma\n",
	);
});

test("bash piped command does not record a read", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const cwd = await createTempDir("sigpi-shell-pipe-");
	await writeWorkspaceFile(cwd, "demo.txt", "alpha\nbeta\n");
	const tracker = new ReadTracker();
	const tools = new ToolRegistry([
		createBashTool(shellRuntime, { mode: "workspace_write" }, tracker),
		createEditTool({ mode: "workspace_write" }, tracker),
	]);
	const cat = await tools.execute(
		{
			id: "s",
			name: "bash",
			arguments: { command: "cat demo.txt | cat" },
			rawArguments: "{}",
		},
		{ cwd, shell: shellRuntime },
	);
	assert.equal(cat.ok, true);
	const edit = await tools.execute(
		{
			id: "e",
			name: "edit",
			arguments: {
				file_path: "demo.txt",
				old_string: "beta",
				new_string: "gamma",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(edit.ok, false);
	assert.match(edit.error ?? "", /not been read/i);
});

test("bash sed -n 'X,Yp' records a read", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const cwd = await createTempDir("sigpi-shell-sed-");
	await writeWorkspaceFile(cwd, "demo.txt", "a\nb\nc\nd\ne\n");
	const tracker = new ReadTracker();
	const tools = new ToolRegistry([
		createBashTool(shellRuntime, { mode: "workspace_write" }, tracker),
		createEditTool({ mode: "workspace_write" }, tracker),
	]);
	const sed = await tools.execute(
		{
			id: "s",
			name: "bash",
			arguments: { command: "sed -n '1,3p' demo.txt" },
			rawArguments: "{}",
		},
		{ cwd, shell: shellRuntime },
	);
	assert.equal(sed.ok, true);
	const edit = await tools.execute(
		{
			id: "e",
			name: "edit",
			arguments: { file_path: "demo.txt", old_string: "c", new_string: "C" },
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(edit.ok, true);
});

test("bash grep records a read of the single file", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const cwd = await createTempDir("sigpi-shell-grep-");
	await writeWorkspaceFile(cwd, "demo.txt", "alpha\nbeta\n");
	const tracker = new ReadTracker();
	const tools = new ToolRegistry([
		createBashTool(shellRuntime, { mode: "workspace_write" }, tracker),
		createEditTool({ mode: "workspace_write" }, tracker),
	]);
	const grep = await tools.execute(
		{
			id: "s",
			name: "bash",
			arguments: { command: "grep alpha demo.txt" },
			rawArguments: "{}",
		},
		{ cwd, shell: shellRuntime },
	);
	assert.equal(grep.ok, true);
	const edit = await tools.execute(
		{
			id: "e",
			name: "edit",
			arguments: {
				file_path: "demo.txt",
				old_string: "beta",
				new_string: "beta!",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);
	assert.equal(edit.ok, true);
});

test("default tool registry exposes edit and write, not the legacy tools", () => {
	const toolNames = createDefaultToolRegistry()
		.getSchemas()
		.map((schema) => schema.function.name);
	assert.ok(toolNames.includes("edit"));
	assert.ok(toolNames.includes("write"));
	assert.ok(!toolNames.includes("write_text_file"));
	assert.ok(!toolNames.includes("apply_patch_text"));
	assert.ok(!toolNames.includes("apply_unified_patch"));
});

test("read input schema requires file_path and rejects path", () => {
	assert.equal(
		readTool.inputSchema.safeParse({ file_path: "demo.txt" }).success,
		true,
	);
	assert.equal(
		readTool.inputSchema.safeParse({ path: "demo.txt" }).success,
		false,
	);
	const params = readTool.parameters as unknown as {
		properties: Record<string, unknown>;
		required: string[];
	};
	assert.ok("file_path" in params.properties);
	assert.equal(params.properties.path, undefined);
	assert.deepEqual(params.required, ["file_path"]);
});

test("read result object omits the path field", async () => {
	const cwd = await createTempDir("sigpi-read-result-contract-");
	await writeWorkspaceFile(cwd, "demo.txt", "hello\n");
	const tools = new ToolRegistry([readTool]);
	const result = await tools.execute(
		{
			id: "call_result_contract_1",
			name: "read",
			arguments: { file_path: "demo.txt" },
			rawArguments: '{"file_path":"demo.txt"}',
		},
		{ cwd },
	);
	assert.equal(result.ok, true);
	assert.equal("path" in (result.data as Record<string, unknown>), false);
});

// --- Trusted roots (tools.allowed_roots) ---

test("write tool permits a path under an allowed root outside the workspace", async () => {
	const cwd = await createTempDir("sigpi-write-trusted-root-");
	const scratch = await createTempDir("sigpi-write-trusted-scratch-");
	const tools = new ToolRegistry([
		createWriteTool({ mode: "workspace_write" }, new ReadTracker(), [scratch]),
	]);

	const result = await tools.execute(
		{
			id: "call_write_trusted_1",
			name: "write",
			arguments: {
				file_path: path.join(scratch, "note.txt"),
				content: "hi",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);

	assert.equal(result.ok, true);
	assert.equal(existsSync(path.join(scratch, "note.txt")), true);
});

test("write tool still rejects a path outside both cwd and allowed roots", async () => {
	const cwd = await createTempDir("sigpi-write-blocked-");
	const scratch = await createTempDir("sigpi-write-blocked-scratch-");
	const tools = new ToolRegistry([
		createWriteTool({ mode: "workspace_write" }, new ReadTracker(), [scratch]),
	]);

	const result = await tools.execute(
		{
			id: "call_write_blocked_1",
			name: "write",
			arguments: {
				file_path: path.join(cwd, "..", "escape.txt"),
				content: "hi",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);

	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /working directory/);
});

test("edit tool permits a path under an allowed root outside the workspace", async () => {
	const cwd = await createTempDir("sigpi-edit-trusted-root-");
	const scratch = await createTempDir("sigpi-edit-trusted-scratch-");
	const notePath = path.join(scratch, "note.txt");
	await writeFile(notePath, "old\n");
	const tracker = new ReadTracker();
	const tools = new ToolRegistry([
		createReadTool(tracker),
		createEditTool({ mode: "workspace_write" }, tracker, [scratch]),
	]);

	// Read-before-edit must be satisfied even for trusted-root paths.
	await tools.execute(
		{
			id: "call_edit_trusted_read",
			name: "read",
			arguments: { file_path: notePath },
			rawArguments: "{}",
		},
		{ cwd, allowedReadRoots: [scratch] },
	);

	const result = await tools.execute(
		{
			id: "call_edit_trusted_1",
			name: "edit",
			arguments: {
				file_path: notePath,
				old_string: "old",
				new_string: "new",
			},
			rawArguments: "{}",
		},
		{ cwd },
	);

	assert.equal(result.ok, true);
	assert.equal(await readFile(notePath, "utf8"), "new\n");
});

test("bash workspace_write mode permits writes under an allowed root", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const scratch = await createTempDir("sigpi-bash-trusted-scratch-");
	const tools = new ToolRegistry([
		createBashTool(
			shellRuntime,
			{ mode: "workspace_write" },
			new ReadTracker(),
			[scratch],
		),
	]);

	const result = await tools.execute(
		{
			id: "call_bash_trusted_1",
			name: "bash",
			arguments: { command: `touch ${path.join(scratch, "out.txt")}` },
			rawArguments: "{}",
		},
		{ cwd: process.cwd(), shell: shellRuntime },
	);

	assert.equal(result.ok, true);
	assert.equal(existsSync(path.join(scratch, "out.txt")), true);
});

test("bash read_only mode still blocks writes even under an allowed root", async () => {
	const shellRuntime = createShellRuntime("sh", "linux");
	const scratch = await createTempDir("sigpi-bash-ro-scratch-");
	const tools = new ToolRegistry([
		createBashTool(shellRuntime, { mode: "read_only" }, new ReadTracker(), [
			scratch,
		]),
	]);

	const result = await tools.execute(
		{
			id: "call_bash_ro_1",
			name: "bash",
			arguments: { command: `touch ${path.join(scratch, "out.txt")}` },
			rawArguments: "{}",
		},
		{ cwd: process.cwd(), shell: shellRuntime },
	);

	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /read_only/);
});

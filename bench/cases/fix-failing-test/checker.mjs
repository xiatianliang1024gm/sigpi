import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function check({ workspacePath, exitCode }) {
	if (exitCode !== 0) {
		return {
			pass: false,
			message: `agent exited with ${exitCode}`,
		};
	}

	try {
		await execFileAsync("npm", ["test"], {
			cwd: workspacePath,
			timeout: 15000,
		});
		return {
			pass: true,
			message: "npm test passed",
		};
	} catch (error) {
		return {
			pass: false,
			message:
				error instanceof Error ? error.message : "npm test failed unexpectedly",
		};
	}
}

import { readFile } from "node:fs/promises";
import path from "node:path";

export async function check({ workspacePath, exitCode }) {
	if (exitCode !== 0) {
		return {
			pass: false,
			message: `agent exited with ${exitCode}`,
		};
	}

	const configPath = path.join(workspacePath, "config.json");
	const config = JSON.parse(await readFile(configPath, "utf8"));
	const pass =
		config.featureEnabled === true &&
		config.retryCount === 3 &&
		config.serviceName === "orders";

	return {
		pass,
		message: pass
			? "config value updated without changing other settings"
			: "config.json does not match expected values",
	};
}

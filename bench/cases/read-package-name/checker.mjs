export function check({ stdout, exitCode }) {
	if (exitCode !== 0) {
		return {
			pass: false,
			message: `agent exited with ${exitCode}`,
		};
	}

	return {
		pass: stdout.includes("bench-read-target"),
		message: stdout.includes("bench-read-target")
			? "found package name in stdout"
			: "stdout did not include package name",
	};
}

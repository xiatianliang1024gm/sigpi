export async function handleRequest({ body }) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const lastUserMessage = [...messages]
		.reverse()
		.find((message) => message.role === "user");
	const prompt = lastUserMessage?.content ?? "";

	if (prompt === "model boom") {
		return {
			status: 500,
			statusText: "Internal Server Error",
			body: { error: "backend exploded" },
		};
	}

	if (prompt === "loop steps") {
		// Always emit a tool call (varying args so the runner does not dedupe)
		// so the agent turn runs until it hits maxSteps and ends with the local
		// max-steps fallback.
		const toolCount = messages.filter((message) => message.role === "tool").length;
		return {
			body: {
				choices: [
					{
						finish_reason: "tool_calls",
						message: {
							role: "assistant",
							content: "still working",
							tool_calls: [
								{
									id: `call_${toolCount + 1}`,
									type: "function",
									function: {
										name: "glob",
										arguments: JSON.stringify({ pattern: `src/**/${toolCount}.ts` }),
									},
								},
							],
						},
						},
					],
			},
		};
	}

	if (prompt === "tool fail") {
		const lastToolMessage = [...messages]
			.reverse()
			.find((message) => message.role === "tool");
		if (!lastToolMessage) {
			return {
				body: {
					choices: [
						{
							finish_reason: "tool_calls",
							message: {
								role: "assistant",
								content: "trying a shell call",
								tool_calls: [
									{
										id: "call_1",
										type: "function",
										function: {
											name: "run_shell",
											arguments: '"bad-args"',
										},
									},
								],
							},
						},
					],
				},
			};
		}

		return {
			body: {
				choices: [
					{
						finish_reason: "stop",
						message: {
							role: "assistant",
							content: (lastToolMessage.content ?? "").includes(
								"invalid tool arguments",
							)
								? "tool error surfaced"
								: "tool error missing",
						},
					},
				],
			},
		};
	}

	if (prompt === "follow up") {
		const priorUserInputs = messages
			.filter((message) => message.role === "user")
			.map((message) => message.content);
		return {
			body: {
				choices: [
					{
						finish_reason: "stop",
						message: {
							role: "assistant",
							content: priorUserInputs.includes("save state")
								? "resume ok"
								: "resume missing",
						},
					},
				],
			},
		};
	}

	if (prompt === "chat question") {
		return {
			body: {
				choices: [
					{
						finish_reason: "stop",
						message: {
							role: "assistant",
							content: "chat ok",
						},
					},
				],
			},
		};
	}

	return {
		body: {
			choices: [
				{
					finish_reason: "stop",
					message: {
						role: "assistant",
						content: `ack:${prompt}`,
					},
				},
			],
		},
	};
}

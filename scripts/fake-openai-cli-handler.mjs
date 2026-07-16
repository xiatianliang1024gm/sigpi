export async function handleRequest({ body }) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const wantsStream = body.stream === true;
	// Build a fake OpenAI response. When the client requests streaming
	// (body.stream === true, which SigPi's default config does), reply with
	// Server-Sent Events so the SDK's streaming parser yields a real
	// completion. When streaming is off, reply with a plain JSON body.
	const respond = (payload) => streamResponse(payload, wantsStream);
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
		return respond({
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
		});
	}

	if (prompt === "tool fail") {
		const lastToolMessage = [...messages]
			.reverse()
			.find((message) => message.role === "tool");
		if (!lastToolMessage) {
			return respond({
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
			});
		}

		return respond({
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
		});
	}

	if (prompt === "follow up") {
		const priorUserInputs = messages
			.filter((message) => message.role === "user")
			.map((message) => message.content);
		return respond({
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
		});
	}

	if (prompt === "chat question") {
		return respond({
			choices: [
				{
					finish_reason: "stop",
					message: {
						role: "assistant",
						content: "chat ok",
					},
				},
			],
		});
	}

	return respond({
		choices: [
			{
				finish_reason: "stop",
				message: {
					role: "assistant",
					content: `ack:${prompt}`,
				},
			},
		],
	});
}

/**
 * Convert a chat/completions JSON payload into the response shape the fake
 * bootstrap expects. When the client asked for streaming we serialize the
 * single assistant message as an SSE stream (`data:` frames + `[DONE]`) with a
 * text/event-stream content type; otherwise we return the plain JSON body.
 */
function streamResponse(body, stream) {
	if (!stream) {
		return { body };
	}

	const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
	if (!choice || !choice.message) {
		return { body };
	}

	const message = choice.message;
	const chunks = [];

	const firstDelta = { role: message.role ?? "assistant" };
	if (typeof message.content === "string" || message.content === null) {
		firstDelta.content = message.content ?? "";
	}
	chunks.push({
		choices: [{ index: 0, delta: firstDelta, finish_reason: null }],
	});

	const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
	for (let index = 0; index < toolCalls.length; index += 1) {
		const toolCall = toolCalls[index];
		chunks.push({
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index,
								id: toolCall.id,
								type: toolCall.type ?? "function",
								function: {
									name: toolCall.function?.name ?? "",
									arguments: toolCall.function?.arguments ?? "",
								},
							},
						],
					},
					finish_reason: null,
				},
			],
		});
	}

	chunks.push({
		choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? "stop" }],
	});

	const rawBody =
		chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
		"data: [DONE]\n\n";

	return {
		rawBody,
		headers: { "content-type": "text/event-stream" },
	};
}

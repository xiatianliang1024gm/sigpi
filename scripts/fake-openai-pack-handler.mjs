export async function handleRequest({ body }) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const lastUserMessage = [...messages]
		.reverse()
		.find((message) => message.role === "user");

	// SigPi's default config requests streaming (body.stream === true), so the
	// fake must reply with SSE when that flag is set; otherwise a plain JSON
	// body is fine.
	const payload = {
		choices: [
			{
				finish_reason: "stop",
				message: {
					role: "assistant",
					content: `packed:${lastUserMessage?.content ?? ""}`,
				},
			},
		],
	};

	if (body.stream !== true) {
		return { body: payload };
	}

	const rawBody = `data: ${JSON.stringify({
		choices: [
			{
				index: 0,
				delta: { role: "assistant", content: `packed:${lastUserMessage?.content ?? ""}` },
				finish_reason: null,
			},
		],
	})}\n\ndata: ${JSON.stringify({
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	})}\n\ndata: [DONE]\n\n`;

	return {
		rawBody,
		headers: { "content-type": "text/event-stream" },
	};
}

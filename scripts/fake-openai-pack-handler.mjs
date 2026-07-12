export async function handleRequest({ body }) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const lastUserMessage = [...messages]
		.reverse()
		.find((message) => message.role === "user");

	return {
		body: {
			choices: [
				{
					finish_reason: "stop",
					message: {
						role: "assistant",
						content: `packed:${lastUserMessage?.content ?? ""}`,
					},
				},
			],
		},
	};
}

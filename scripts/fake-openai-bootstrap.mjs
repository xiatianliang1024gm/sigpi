import { pathToFileURL } from "node:url";

const handlerPath = process.env.TINYPI_FAKE_OPENAI_HANDLER;

if (!handlerPath) {
	throw new Error("Missing TINYPI_FAKE_OPENAI_HANDLER for fake OpenAI bootstrap.");
}

const handlerModule = await import(pathToFileURL(handlerPath).href);

if (typeof handlerModule.handleRequest !== "function") {
	throw new Error(
		`Fake OpenAI handler at ${handlerPath} must export handleRequest(request, index).`,
	);
}

let callIndex = 0;

globalThis.fetch = async (input, init = {}) => {
	const rawBody =
		typeof init.body === "string"
			? init.body
			: init.body
				? Buffer.from(init.body).toString("utf8")
				: "";
	const parsedBody = rawBody ? JSON.parse(rawBody) : {};
	const response = await handlerModule.handleRequest(
		{
			url: String(input),
			method: init.method ?? "GET",
			headers: init.headers ?? {},
			body: parsedBody,
		},
		callIndex,
	);
	callIndex += 1;

	return new Response(
		response.rawBody ?? JSON.stringify(response.body ?? {}),
		{
			status: response.status ?? 200,
			statusText: response.statusText,
			headers: response.headers ?? {
				"content-type": "application/json",
			},
		},
	);
};

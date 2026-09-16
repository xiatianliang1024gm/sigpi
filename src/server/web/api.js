// Thin fetch helpers over the JSON API.

import { state } from "./state.js";

export async function requestJson(path, options) {
	const response = await fetch(path, options);
	const text = await response.text();
	let body = null;
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = null;
		}
	}
	if (!response.ok) {
		const message = body?.error ?? `HTTP ${response.status}`;
		throw new Error(message);
	}
	return body;
}

export function postJson(path, body) {
	return requestJson(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
}

export const sessionBase = () =>
	`/projects/${encodeURIComponent(state.projectKey)}/sessions/${encodeURIComponent(state.sessionId)}`;

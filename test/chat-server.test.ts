import assert from "node:assert/strict";
import test from "node:test";
import {
	type ChatSessionSource,
	createChatServer,
} from "../src/server/http.js";
import type {
	InterruptAck,
	SessionTurnOutcome,
} from "../src/session/controller.js";
import type { TurnProgressEvent } from "../src/types.js";

/** Minimal headless session: emits two events per submitted turn. */
class FakeSession implements ChatSessionSource {
	readonly listeners = new Set<(event: TurnProgressEvent) => void>();
	readonly submitted: string[] = [];
	private active = false;

	onProgress(listener: (event: TurnProgressEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	isTurnActive(): boolean {
		return this.active;
	}

	async submit(input: string): Promise<SessionTurnOutcome> {
		this.submitted.push(input);
		this.active = true;
		this.emit({ type: "turn_started", turnId: "t", userInput: input });
		this.emit({ type: "turn_finished", step: 1, elapsedMs: 1, usage: null });
		this.active = false;
		return { ok: true, completionStatus: "completed", outputText: "done" };
	}

	requestInterrupt(): InterruptAck {
		return {
			accepted: false,
			alreadyRequested: false,
			stage: null,
			message: null,
		};
	}

	private emit(event: TurnProgressEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

/** Read SSE frames (split on blank lines) until `count` have arrived. */
async function readFrames(
	response: Response,
	count: number,
	timeoutMs = 5000,
): Promise<string[]> {
	const reader = response.body?.getReader();
	assert.ok(reader, "response has a body stream");
	const decoder = new TextDecoder();
	const frames: string[] = [];
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	while (frames.length < count) {
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${count} SSE frames`);
		}
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let index = buffer.indexOf("\n\n");
		while (index !== -1) {
			frames.push(buffer.slice(0, index));
			buffer = buffer.slice(index + 2);
			index = buffer.indexOf("\n\n");
		}
	}
	return frames;
}

async function withServer(
	run: (baseUrl: string, session: FakeSession) => Promise<void>,
): Promise<void> {
	const session = new FakeSession();
	const server = createChatServer({ session });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object", "server has an address");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	try {
		await run(baseUrl, session);
	} finally {
		server.closeAllConnections?.();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

test("POST /message submits a turn and streams its progress over SSE", async () => {
	await withServer(async (baseUrl, session) => {
		const ac = new AbortController();
		try {
			const eventsResponse = await fetch(`${baseUrl}/events`, {
				signal: ac.signal,
			});
			assert.equal(eventsResponse.status, 200);
			assert.match(
				eventsResponse.headers.get("content-type") ?? "",
				/text\/event-stream/,
			);
			// ready + turn_started + turn_finished
			const framesPromise = readFrames(eventsResponse, 3);

			const postResponse = await fetch(`${baseUrl}/message`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ input: "hi" }),
			});
			assert.equal(postResponse.status, 202);
			assert.deepEqual(await postResponse.json(), { accepted: true });

			const frames = await framesPromise;
			assert.match(frames[0] ?? "", /^: connected/);
			assert.match(frames[1] ?? "", /"type":"ready"/);
			assert.match(frames[2] ?? "", /"type":"turn_started"/);
			assert.deepEqual(session.submitted, ["hi"]);
		} finally {
			ac.abort();
		}
	});
});

test("POST /message rejects empty input with 400", async () => {
	await withServer(async (baseUrl) => {
		const response = await fetch(`${baseUrl}/message`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: "   " }),
		});
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: "empty_input" });
	});
});

test("POST /interrupt returns the controller acknowledgement", async () => {
	await withServer(async (baseUrl) => {
		const response = await fetch(`${baseUrl}/interrupt`, { method: "POST" });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			accepted: false,
			alreadyRequested: false,
			stage: null,
			message: null,
		});
	});
});

test("unknown routes return 404", async () => {
	await withServer(async (baseUrl) => {
		const response = await fetch(`${baseUrl}/nope`);
		assert.equal(response.status, 404);
	});
});

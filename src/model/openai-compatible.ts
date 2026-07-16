import OpenAI from "openai";
import type { ModelConfig } from "../config.js";
import type {
	ModelDelta,
	ModelProvider,
	ModelRequest,
	ModelResponse,
	RuntimeLogger,
} from "../types.js";
import { ChatCompletionsAdapter } from "./chat-completions-adapter.js";
import { ResponsesAdapter } from "./responses-adapter.js";
import { ModelTransport } from "./transport.js";
import type { WireFormatAdapter } from "./wire-format.js";

/**
 * Build the OpenAI SDK client that owns HTTP, SSE framing, per-call body
 * reading, and (when configured) the total request timeout for the
 * openai-compatible path. SigPi keeps the `Wire format adapter` for
 * schema translation and supplies its own idle/stall timer + retry/backoff on
 * top. The SDK's own retry is disabled (`maxRetries: 0`) so SigPi's retry loop
 * governs (ADR-0022). `fetch` references the live global so a proxy-aware
 * dispatcher installed at startup (undici) is picked up.
 */
function buildSdkClient(config: ModelConfig): OpenAI {
	return new OpenAI({
		apiKey: config.apiKey,
		baseURL: config.baseURL,
		maxRetries: 0,
		fetch: (input: RequestInfo | URL, init?: RequestInit) =>
			globalThis.fetch(input, init),
	});
}

/**
 * OpenAI-compatible provider — a thin composer over {@link ModelTransport}
 * (HTTP resilience + SDK substrate) and a {@link WireFormatAdapter} selected
 * by the config's API format. All format-specific logic lives in the adapter.
 */
export class OpenAICompatibleProvider implements ModelProvider {
	public readonly maxTokens: number | undefined;
	private readonly transport: ModelTransport;
	private readonly config: ModelConfig;

	constructor(config: ModelConfig, logger?: RuntimeLogger) {
		this.maxTokens = config.maxTokens;
		this.config = config;
		this.transport = new ModelTransport(config, buildSdkClient(config), logger);
	}

	generate(
		request: ModelRequest,
		onDelta?: (delta: ModelDelta) => void,
	): Promise<ModelResponse> {
		return this.transport.generate(
			request,
			() =>
				this.config.apiFormat === "responses"
					? new ResponsesAdapter(this.config)
					: new ChatCompletionsAdapter(this.config),
			onDelta,
		);
	}
}

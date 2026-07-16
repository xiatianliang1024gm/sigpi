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
import { getProxyFetch } from "./http-dispatcher.js";
import { ResponsesAdapter } from "./responses-adapter.js";
import { ModelTransport } from "./transport.js";
import type { WireFormatAdapter } from "./wire-format.js";

/**
 * Build the OpenAI SDK client that owns HTTP, SSE framing, per-call body
 * reading, and (when configured) the total request timeout for the
 * openai-compatible path. SigPi keeps the `Wire format adapter` for
 * schema translation and supplies its own idle/stall timer + retry/backoff on
 * top. The SDK's own retry is disabled (`maxRetries: 0`) so SigPi's retry loop
 * governs (ADR-0022). The SDK client is constructed with SigPi's existing
 * proxy `fetch` (the undici dispatcher installed by `configureHttpProxy`) so
 * outbound model requests route through the same proxy as the rest of SigPi
 * when one is configured (ADR-0024). No new proxy code — we reuse the one
 * proxy implementation.
 */
export function buildSdkClient(config: ModelConfig): OpenAI {
	return new OpenAI({
		apiKey: config.apiKey,
		baseURL: config.baseURL,
		// Total request deadline (ADR-0024): the SDK aborts the connect/headers
		// phase at `timeoutMs`. SigPi's own total timer (ModelTransport) extends
		// that bound across the whole stream read, so a reasoning-forever model
		// is killed even though the idle/stall timer keeps resetting on bytes.
		timeout: config.timeoutMs,
		maxRetries: 0,
		fetch: getProxyFetch(),
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

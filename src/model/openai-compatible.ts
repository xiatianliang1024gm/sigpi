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
 * OpenAI-compatible provider — a thin composer over {@link ModelTransport}
 * (HTTP resilience) and a {@link WireFormatAdapter} selected by the config's
 * API format. All format-specific logic lives in the adapter.
 */
export class OpenAICompatibleProvider implements ModelProvider {
	public readonly maxTokens: number | undefined;
	private readonly transport: ModelTransport;
	private readonly config: ModelConfig;

	constructor(config: ModelConfig, logger?: RuntimeLogger) {
		this.maxTokens = config.maxTokens;
		this.config = config;
		this.transport = new ModelTransport(config, logger);
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

import type { ModelConfig } from "../config.js";
import type {
	ModelRequest,
	ModelResponse,
	RuntimeLogger,
} from "../types.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

/**
 * The model-provider seam. The agent loop depends only on this interface;
 * swapping providers (or mocking them in tests) means swapping one object.
 * The concrete implementation lives in `openai-compatible.ts`; construction
 * goes through {@link createModelProvider} so no consumer names the class.
 */
export interface ModelProvider {
	/**
	 * Model's maximum output tokens, if known. Compaction uses this as a
	 * hard cap when sizing the summary request so we never ask for more
	 * tokens than the model can produce. Optional; consumers should
	 * default to a sensible internal cap (2048) when absent.
	 */
	readonly maxTokens?: number;
	generate(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * Construct the runtime model provider. This is the single seam through which
 * the rest of the app obtains a {@link ModelProvider}; it owns the
 * transport/adapter wiring so a second provider slots in behind the same
 * interface.
 */
export function createModelProvider(
	config: ModelConfig,
	logger?: RuntimeLogger,
): ModelProvider {
	return new OpenAICompatibleProvider(config, logger);
}

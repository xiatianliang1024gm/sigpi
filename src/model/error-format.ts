import type { JsonValue } from "../types.js";
import { ModelRequestError, type RequestFailureKind } from "./transport.js";

/**
 * Convert a model/transport error into a clear, actionable message for the
 * user. Technical error objects are kept in logs; this is the text shown in
 * the REPL/CLI when a turn fails, so it should say what happened and what to
 * do next (usually: retry, the session is preserved).
 */
export function formatModelErrorMessage(error: unknown): string {
	if (error instanceof ModelRequestError) {
		return formatRequestError(error.kind, error.details, error.message);
	}
	if (error instanceof Error) {
		return `Request failed: ${error.message}`;
	}
	return `Request failed: ${String(error)}`;
}

function formatRequestError(
	kind: RequestFailureKind,
	details: Record<string, JsonValue | undefined>,
	fallback: string,
): string {
	const status = Number(details.httpStatus ?? 0);
	switch (kind) {
		case "network_error":
			return 'Could not reach the model API (network error). Check your connection, base_url, and API key, then retry — your session is preserved, so just resend your last message or type "continue".';
		case "stream_error":
			return 'The model\'s response stream was interrupted before it finished (likely a transient network issue). Retry by resending your last message or typing "continue"; your session context is intact.';
		case "timeout": {
			const ms = Number(details.timeoutMs ?? 0);
			return `The model took too long to respond (over ${ms} ms). The provider may be overloaded — retry shortly, or increase timeout_ms in your config.`;
		}
		case "aborted":
			return "The request was cancelled.";
		case "http_error":
			return formatHttpError(status, fallback);
		case "empty_response":
			return "The model returned an empty response. Check that base_url points at a chat/completions endpoint.";
		case "invalid_json":
		case "invalid_response":
			return "The model returned a response that could not be parsed. This usually means base_url is wrong or the provider is incompatible.";
		case "body_read_failed":
			return "Could not read the model's response body. Check the network/proxy and retry.";
		case "truncated":
			return "The model's reply was cut off because it hit the max_tokens limit. Increase max_tokens (or enable context compaction/summarization) and retry; the partial answer was not saved.";
		default:
			return fallback;
	}
}

function formatHttpError(status: number, fallback: string): string {
	if (status === 401 || status === 403) {
		return "Authentication failed (HTTP 401/403). Check your api_key and base_url, then retry.";
	}
	if (status === 429) {
		return "Rate limited by the provider (HTTP 429). Wait a moment and retry.";
	}
	if (status >= 500) {
		return `The model provider returned a server error (HTTP ${status}). Retry shortly.`;
	}
	if (status > 0) {
		return `The model request failed (HTTP ${status}). ${fallback}`;
	}
	return `The model request failed. ${fallback}`;
}

import type { ToolCall } from "../types.js";

/** Narrowing guard for plain (non-array) objects. */
export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce a token count to a non-negative truncated integer, or null if invalid. */
export function readFiniteNumber(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	if (value < 0) {
		return null;
	}
	return Math.trunc(value);
}

/**
 * Make a tool-call argument string safe to forward to an OpenAI-compatible
 * provider. Models occasionally emit raw control characters (e.g. ESC `\x1B`)
 * or other invalid JSON inside a tool-call's `arguments`. The local parser
 * tolerates them long enough to record a parse error, but providers (e.g.
 * OpenRouter -> Novita/Tencent) reject the whole request with HTTP 400
 * ("Provider returned error") when a tool-call `arguments` string is not
 * valid JSON. Stripping raw control characters yields a value the provider
 * can accept. For an already-valid arguments string this is a no-op; when
 * the fragment still cannot be parsed into a JSON object (the call had
 * already failed to parse locally), a valid empty object `{}` is returned so
 * the request stays structurally valid — the paired tool result already
 * explains the failure to the model.
 */
const INVALID_IN_JSON_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function sanitizeToolArguments(rawArguments: string): string {
	const cleaned = rawArguments.replace(INVALID_IN_JSON_RE, "");
	if (cleaned.trim().length === 0) {
		return "{}";
	}
	try {
		const parsed = JSON.parse(cleaned);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return cleaned;
		}
		return "{}";
	} catch {
		return "{}";
	}
}
export function safeParseArguments(
	rawArguments: string,
): Pick<ToolCall, "arguments" | "argumentParseError"> {
	if (rawArguments.trim().length === 0) {
		// A function call that streams no/empty arguments means "no parameters".
		return { arguments: {} };
	}
	try {
		const parsed = JSON.parse(rawArguments) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return {
				arguments: parsed as Record<string, unknown>,
			};
		}

		return {
			arguments: {},
			argumentParseError:
				"Model returned invalid tool arguments: tool arguments must be a JSON object.",
		};
	} catch (error) {
		return {
			arguments: {},
			argumentParseError: `Model returned invalid tool arguments: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

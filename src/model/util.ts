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

/** Parse a tool-call argument string, recording a parse error instead of throwing. */
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

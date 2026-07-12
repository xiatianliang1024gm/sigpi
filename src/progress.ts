const MAX_MESSAGE_CHARS = 240;

export function summarizeAssistantProgressText(
	text: string | null,
): string | null {
	if (!text) {
		return null;
	}

	const normalized = text.replace(/\s+/gu, " ").trim();

	if (!normalized) {
		return null;
	}

	return truncate(normalized, MAX_MESSAGE_CHARS);
}

// Shared text helpers used by per-tool `describeProgress` adapters.
export function getString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function getNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function getBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

export function getStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string");
}

export function asInlineCode(value: string): string {
	return `\`${truncate(value, 120)}\``;
}

export function asQuoted(value: string): string {
	return `"${truncate(value, 120)}"`;
}

export function compactWhitespace(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

export function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}

	return `${value.slice(0, maxChars - 3)}...`;
}

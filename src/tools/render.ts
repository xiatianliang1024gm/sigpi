import type { JsonValue, ToolExecutionResult } from "../types.js";

const DEFAULT_BLOCK_START_MARKER = "=== CONTENT START ===";
const DEFAULT_BLOCK_END_MARKER = "=== CONTENT END ===";

export function withRendered<T extends Record<string, JsonValue>>(
	data: T,
	rendered: string,
): T & { rendered: string } {
	return {
		...data,
		rendered,
	};
}

export function formatToolExecutionResult(
	name: string,
	result: ToolExecutionResult,
): string {
	if (result.ok) {
		if (result.data !== undefined) {
			return formatToolValue(result.data);
		}
		return "";
	}

	const lines = [`TOOL: ${name}`, `STATUS: error`];
	lines.push(`ERROR: ${result.error ?? "Unknown tool error"}`);
	if (result.details !== undefined) {
		lines.push("DETAILS:");
		lines.push(formatToolValue(result.details));
	}

	return lines.join("\n");
}

export function formatToolValue(value: JsonValue): string {
	const rendered = getRenderedText(value);
	if (rendered) {
		return rendered;
	}

	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return formatObject(value);
	}

	if (Array.isArray(value)) {
		return value.length === 0
			? "(empty list)"
			: value.map((item) => `- ${formatInlineValue(item)}`).join("\n");
	}

	return formatInlineValue(value);
}

export function formatMetadataLine(label: string, value: string): string {
	return `${label}: ${value}`;
}

export function formatRawBlock(
	label: string,
	content: string,
	options: { baseEndMarker?: string; omitLabel?: boolean } = {},
): string {
	const baseEndMarker = options.baseEndMarker ?? DEFAULT_BLOCK_END_MARKER;
	const endMarker = chooseUniqueMarker(content, baseEndMarker);
	const body = content.endsWith("\n") ? content.slice(0, -1) : content;
	const lines: string[] = [];
	if (!options.omitLabel) {
		lines.push(`${label}:`);
	}
	lines.push(DEFAULT_BLOCK_START_MARKER, body, endMarker);
	return lines.join("\n");
}

export function joinRenderedSections(
	sections: Array<string | null | undefined>,
): string {
	return sections
		.filter((section): section is string => Boolean(section))
		.join("\n");
}

function getRenderedText(value: JsonValue): string | null {
	if (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof value.rendered === "string"
	) {
		return value.rendered;
	}

	return null;
}

function formatObject(value: { [key: string]: JsonValue }): string {
	const entries = Object.entries(value).filter(([key]) => key !== "rendered");

	if (entries.length === 0) {
		return "(empty object)";
	}

	return entries
		.map(([key, entryValue]) => formatObjectEntry(key, entryValue))
		.join("\n");
}

function formatObjectEntry(key: string, value: JsonValue): string {
	if (typeof value === "string" && value.includes("\n")) {
		return `${key}:\n${indentBlock(value)}`;
	}

	if (typeof value === "object" && value !== null) {
		const formatted = formatToolValue(value);
		return `${key}:\n${indentBlock(formatted)}`;
	}

	return `${key}: ${formatInlineValue(value)}`;
}

function formatInlineValue(value: JsonValue): string {
	if (typeof value === "string") {
		return value;
	}

	if (typeof value === "object" && value !== null) {
		return JSON.stringify(value, null, 2);
	}

	return String(value);
}

function indentBlock(value: string): string {
	return value
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

function chooseUniqueMarker(content: string, baseMarker: string): string {
	if (!content.includes(baseMarker)) {
		return baseMarker;
	}

	let suffix = 1;
	while (content.includes(`${baseMarker}_${suffix}`)) {
		suffix += 1;
	}

	return `${baseMarker}_${suffix}`;
}

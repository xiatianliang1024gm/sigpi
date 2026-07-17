const ANSI_ESCAPE_PATTERN =
	/\x1B(?:_[^\x07]*(?:\x07|\x1B\\)|\][^\x07]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-^`-~])/gu;

export function stripAnsi(value: string): string {
	return value.replace(ANSI_ESCAPE_PATTERN, "");
}

export function visibleWidth(value: string): number {
	let width = 0;
	const stripped = stripAnsi(value);

	for (const char of Array.from(stripped)) {
		width += getCodePointDisplayWidth(char);
	}

	return width;
}

export function truncateToWidth(value: string, maxWidth: number): string {
	if (maxWidth <= 0) {
		return "";
	}

	let result = "";
	let width = 0;
	for (let index = 0; index < value.length; ) {
		const escape = readEscapeSequence(value, index);
		if (escape) {
			result += escape;
			index += escape.length;
			continue;
		}

		const char = Array.from(value.slice(index))[0] ?? "";
		const charWidth = getCodePointDisplayWidth(char);
		if (width + charWidth > maxWidth) {
			break;
		}
		result += char;
		width += charWidth;
		index += char.length;
	}

	return result;
}

export function wrapToWidth(value: string, maxWidth: number): string[] {
	if (maxWidth <= 0) {
		return [""];
	}

	const lines: string[] = [];
	for (const logicalLine of value.split("\n")) {
		let currentLine = "";
		let currentWidth = 0;

		for (let index = 0; index < logicalLine.length; ) {
			const escape = readEscapeSequence(logicalLine, index);
			if (escape) {
				currentLine += escape;
				index += escape.length;
				continue;
			}

			const char = Array.from(logicalLine.slice(index))[0] ?? "";
			const charWidth = getCodePointDisplayWidth(char);
			if (currentWidth > 0 && currentWidth + charWidth > maxWidth) {
				lines.push(currentLine);
				currentLine = "";
				currentWidth = 0;
			}
			currentLine += char;
			currentWidth += charWidth;
			index += char.length;
		}

		lines.push(currentLine);
	}

	return lines;
}

function readEscapeSequence(value: string, index: number): string | null {
	ANSI_ESCAPE_PATTERN.lastIndex = index;
	const match = ANSI_ESCAPE_PATTERN.exec(value);
	if (!match || match.index !== index) {
		return null;
	}

	return match[0];
}

export function padToWidth(value: string, width: number): string {
	const currentWidth = visibleWidth(value);
	return currentWidth >= width
		? value
		: `${value}${" ".repeat(width - currentWidth)}`;
}

export function normalizeRenderedLine(value: string, width: number): string {
	return padToWidth(truncateToWidth(value, width), width);
}

/**
 * Truncate `value` to `width` visible columns, keeping the *right*-most
 * content and prefixing an ellipsis. Used for the status bar, where the most
 * important information (cwd, trailing event label) sits at the end.
 */
export function truncateLeftToWidth(value: string, width: number): string {
	if (width <= 0 || visibleWidth(value) <= width) {
		return width <= 0 ? "" : value;
	}
	if (width === 1) {
		return truncateToWidth("…", 1);
	}

	const suffix = Array.from(value);
	let result = "";
	let started = false;
	for (let index = suffix.length - 1; index >= 0; index -= 1) {
		const next = `${suffix[index]}${result}`;
		const candidate = started ? `…${next}` : next;
		if (visibleWidth(candidate) > width) {
			started = true;
			continue;
		}
		result = next;
		started = true;
	}
	return visibleWidth(result) === visibleWidth(value) ? result : `…${result}`;
}

function getCodePointDisplayWidth(char: string): number {
	const codePoint = char.codePointAt(0);
	if (codePoint === undefined) {
		return 0;
	}

	if (
		codePoint === 0 ||
		codePoint < 32 ||
		(codePoint >= 0x7f && codePoint < 0xa0)
	) {
		return 0;
	}

	if (isCombiningCodePoint(codePoint)) {
		return 0;
	}

	return isFullWidthCodePoint(codePoint) ? 2 : 1;
}

function isCombiningCodePoint(codePoint: number): boolean {
	return (
		(codePoint >= 0x0300 && codePoint <= 0x036f) ||
		(codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
		(codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
		(codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
		(codePoint >= 0xfe20 && codePoint <= 0xfe2f)
	);
}

function isFullWidthCodePoint(codePoint: number): boolean {
	return (
		codePoint >= 0x1100 &&
		(codePoint <= 0x115f ||
			codePoint === 0x2329 ||
			codePoint === 0x232a ||
			(codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
			(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
			(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
			(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
			(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
			(codePoint >= 0xff00 && codePoint <= 0xff60) ||
			(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
			(codePoint >= 0x20000 && codePoint <= 0x3fffd))
	);
}

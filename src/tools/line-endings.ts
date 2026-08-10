/**
 * Line-ending helpers for the read/edit/write tools.
 *
 * SigPi matches `old_string` leniently with respect to line endings: a model
 * that copies text from the read tool's display (which strips line endings)
 * must be able to edit a CRLF file on Windows without a byte-for-byte CRLF
 * match. What lands on disk, though, keeps the file's existing line-ending
 * style, so an edit never flips a whole CRLF file to LF (or vice versa) and
 * never mixes styles. Model-emitted `\r\n` inside `new_string` is converted
 * to the file's style instead of leaking into the diff.
 */

type LineEndingStyle = "\r\n" | "\n" | "\r";

/** Normalize CRLF and legacy CR line endings to LF. */
export function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n?/gu, "\n");
}

/**
 * Detect the dominant line-ending style of `value`. Files without any line
 * endings default to LF.
 */
export function detectLineEndingStyle(value: string): LineEndingStyle {
	let crlf = 0;
	let lf = 0;
	let cr = 0;
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i];
		if (ch === "\r") {
			if (value[i + 1] === "\n") {
				crlf += 1;
				i += 1;
			} else {
				cr += 1;
			}
		} else if (ch === "\n") {
			lf += 1;
		}
	}
	if (crlf >= lf && crlf >= cr) {
		return "\r\n";
	}
	if (cr >= lf) {
		return "\r";
	}
	return "\n";
}

/**
 * Convert LF-normalized text to `style`. `value` must already be normalized
 * (all line breaks are `\n`), otherwise a `\r\n` would be double-converted.
 */
export function applyLineEndingStyle(
	value: string,
	style: LineEndingStyle,
): string {
	if (style === "\n") {
		return value;
	}
	return value.replace(/\n/gu, style);
}

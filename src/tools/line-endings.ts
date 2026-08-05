/**
 * Normalize CRLF and legacy CR line endings to LF.
 *
 * SigPi-authored files always use LF line endings regardless of the platform
 * the model runs on. Without this, a model on Windows can emit `\r\n` and
 * silently flip every file it touches to CRLF, which pollutes diffs and
 * trips formatters that expect LF. Matching in the edit tool stays exact
 * (old_string must match the file byte-for-byte); only what gets written to
 * disk is normalized.
 */
export function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n?/gu, "\n");
}

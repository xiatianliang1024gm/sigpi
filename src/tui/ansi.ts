/**
 * Strip ANSI escape sequences from a string.
 *
 * Kept as a standalone SigPi helper (no Pi-tui dependency) because Pi-tui does
 * not export an equivalent. Used by tests that assert on rendered (ANSI-free)
 * output.
 */
const ANSI_RE = /\x1B\[[0-9;]*m|\x1B\][^\x07]*\x07|\x1B[()][AB0-2]/g;

export function stripAnsi(value: string): string {
	return value.replaceAll(ANSI_RE, "");
}

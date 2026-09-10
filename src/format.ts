/**
 * UI-neutral number/duration formatting shared by every frontend (TUI status
 * bar, transcript messages, web event frames). Kept free of any `pi-tui` or
 * other presentation dependency so a headless consumer (e.g. an HTTP/SSE
 * server) can format the same strings without pulling in the terminal stack.
 */

export function formatCompactNumber(value: number): string {
	if (!Number.isFinite(value)) {
		return "0";
	}
	if (Math.abs(value) < 1000) {
		return String(Math.round(value));
	}
	const formatter = new Intl.NumberFormat("en", {
		notation: "compact",
		maximumFractionDigits: 1,
	});
	return formatter.format(value);
}

/**
 * Format a duration for status surfaces: whole seconds under a minute
 * (`12s`), minutes + seconds beyond (`1m 05s`). The live clock ticks once per
 * second, so sub-second precision would read as noise; exact ms is kept in the
 * turn log instead.
 */
export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0
		? `${minutes}m ${String(seconds).padStart(2, "0")}s`
		: `${seconds}s`;
}

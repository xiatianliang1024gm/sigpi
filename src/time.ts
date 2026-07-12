export function formatLocalTimestamp(date: Date): string {
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absoluteOffsetMinutes = Math.abs(offsetMinutes);
	const offsetHours = String(Math.floor(absoluteOffsetMinutes / 60)).padStart(
		2,
		"0",
	);
	const offsetRemainderMinutes = String(absoluteOffsetMinutes % 60).padStart(
		2,
		"0",
	);

	return [
		`${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`,
		`${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}.${padMilliseconds(date.getMilliseconds())}${sign}${offsetHours}:${offsetRemainderMinutes}`,
	].join("T");
}

export function compareTimestampDescending(
	left: string,
	right: string,
): number {
	return parseTimestampMillis(right) - parseTimestampMillis(left);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_FALLBACK_DAYS = 30;

/**
 * Render a timestamp relative to `now` for compact session listings.
 *
 * Buckets: <60s "just now", <60m "N minute(s) ago", <24h "N hour(s) ago",
 * <30d "N day(s) ago". Older than 30 days falls back to a short absolute
 * date ("Jul 11", with year when it differs from `now`'s year).
 */
export function formatRelativeTime(
	value: string,
	now: Date = new Date(),
): string {
	const then = new Date(value);
	if (Number.isNaN(then.getTime())) {
		return value;
	}

	const deltaMs = now.getTime() - then.getTime();
	const past = deltaMs >= 0;
	const abs = Math.abs(deltaMs);

	if (abs < MINUTE_MS) {
		return "just now";
	}

	if (abs < HOUR_MS) {
		return plural(abs / MINUTE_MS, "minute", past);
	}

	if (abs < DAY_MS) {
		return plural(abs / HOUR_MS, "hour", past);
	}

	if (abs < MONTH_FALLBACK_DAYS * DAY_MS) {
		return plural(abs / DAY_MS, "day", past);
	}

	return formatShortDate(then, now);
}

function plural(amount: number, unit: string, past: boolean): string {
	const count = Math.round(amount);
	const label = `${count} ${unit}${count === 1 ? "" : "s"}`;
	return past ? `${label} ago` : `in ${label}`;
}

function formatShortDate(date: Date, now: Date): string {
	const month = date.toLocaleString("en", { month: "short" });
	const day = String(date.getDate());
	const base = `${month} ${day}`;
	return date.getFullYear() === now.getFullYear()
		? base
		: `${base} ${date.getFullYear()}`;
}

export function normalizeTimestampString(value: string): string {
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? value : formatLocalTimestamp(new Date(parsed));
}

function parseTimestampMillis(value: string): number {
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function padNumber(value: number): string {
	return String(value).padStart(2, "0");
}

function padMilliseconds(value: number): string {
	return String(value).padStart(3, "0");
}

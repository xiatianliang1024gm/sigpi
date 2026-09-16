// Pure string, label and relative-time formatting.

/** The last path segment, so a project shows just its folder name. */
export function baseName(p) {
	if (!p) return "";
	const parts = p.split(/[\\/]+/).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : p;
}

/**
 * A human-readable session label: the derived title, else the last user input,
 * else a placeholder for a session that has not recorded anything yet. The raw
 * session id is never shown.
 */
export function sessionLabel(session) {
	return session.title || session.lastCompletedUserInput || "新会话";
}

/** Mirror the server's title derivation (whitespace-collapsed, ≤80 chars). */
export function truncateTitle(text) {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`;
}

// --- relative time ---------------------------------------------------------

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const MONTH_MS = 30 * DAY_MS;
export const YEAR_MS = 365 * DAY_MS;

/**
 * Coerce a timestamp — an ISO string (stored sessions' `updatedAt`) or epoch
 * milliseconds (live sessions' `lastActivityAt`) — into epoch ms, or `null`
 * when it is missing/unparseable.
 */
export function toEpochMillis(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value) {
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? ms : null;
	}
	return null;
}

/**
 * A coarse "time since" label: 刚刚, then minutes, hours, days, months and years
 * as the gap widens. Deliberately compact so it fits the narrow tree column.
 */
export function formatRelativeTime(ms, now = Date.now()) {
	const diff = now - ms;
	if (diff < MINUTE_MS) return "刚刚";
	const minutes = Math.floor(diff / MINUTE_MS);
	if (minutes < 60) return `${minutes}分钟`;
	const hours = Math.floor(diff / HOUR_MS);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(diff / DAY_MS);
	if (days < 30) return `${days}天`;
	const months = Math.floor(diff / MONTH_MS);
	if (months < 12) return `${months}月`;
	const years = Math.floor(diff / YEAR_MS);
	return `${years}年`;
}

/** Stamp a row's time element from a timestamp; blank when there is none. */
export function setRelativeTime(el, value) {
	const ms = toEpochMillis(value);
	if (ms === null) {
		el.textContent = "";
		delete el.dataset.time;
		return;
	}
	el.dataset.time = String(ms);
	el.textContent = formatRelativeTime(ms);
	el.title = new Date(ms).toLocaleString();
}

/** Turn a picker failure into something a person can act on. */
export function projectErrorMessage(error) {
	if (error?.message === "picker_unavailable") {
		return "The server has no folder chooser available.";
	}
	return error?.message ?? "Failed to add the project.";
}

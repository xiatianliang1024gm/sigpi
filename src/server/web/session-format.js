// Pure formatting for the session info line. Dependency-free (only the compact
// number helper) so it loads directly in the browser *and* in Node tests,
// without dragging in the DOM-bound client modules.

import { formatCompactNumber } from "./reducer.js";

/** Coerce a stats payload into numbers, keeping `null` for the optional means. */
export function normalizeSessionStats(body) {
	if (!body || typeof body !== "object") return null;
	const num = (value) => (Number.isFinite(value) ? Number(value) : 0);
	const optional = (value) => (Number.isFinite(value) ? Number(value) : null);
	return {
		turns: num(body.turns),
		steps: num(body.steps),
		inputTokens: num(body.inputTokens),
		outputTokens: num(body.outputTokens),
		cacheReadTokens: num(body.cacheReadTokens),
		cacheWriteTokens: num(body.cacheWriteTokens),
		llmMs: num(body.llmMs),
		toolMs: num(body.toolMs),
		firstTokenAvgMs: optional(body.firstTokenAvgMs),
		tokensPerSecond: optional(body.tokensPerSecond),
	};
}

/**
 * Compose the single-line summary, omitting any group whose data is unknown so
 * a fresh session never shows a misleading `0`. Mirrors the reference layout:
 * `2 轮 · 108 步| LLM 5分54秒 · 工具调用 5分14秒| 首 token 平均 1秒 · 255 tok/s| 缓存命中 99%| 输入 11.2M tok · 输出 62.4K tok`.
 */
export function formatSessionInfo(stats) {
	if (!stats) return "";
	const groups = [];

	const turns = stats.turns ?? 0;
	const steps = stats.steps ?? 0;
	if (turns > 0 || steps > 0) {
		groups.push(`${turns} 轮 · ${steps} 步`);
	}

	const llmMs = stats.llmMs ?? 0;
	const toolMs = stats.toolMs ?? 0;
	if (llmMs > 0 || toolMs > 0) {
		groups.push(
			`LLM ${formatDuration(llmMs)} · 工具调用 ${formatDuration(toolMs)}`,
		);
	}

	const rate = [];
	if (stats.firstTokenAvgMs != null && stats.firstTokenAvgMs > 0) {
		rate.push(`首 token 平均 ${formatDuration(stats.firstTokenAvgMs)}`);
	}
	if (stats.tokensPerSecond != null && stats.tokensPerSecond > 0) {
		rate.push(`${Math.round(stats.tokensPerSecond)} tok/s`);
	}
	if (rate.length > 0) {
		groups.push(rate.join(" · "));
	}

	const input = stats.inputTokens ?? 0;
	const cacheRead = stats.cacheReadTokens ?? 0;
	if (input + cacheRead > 0) {
		const percent = Math.round((cacheRead / (input + cacheRead)) * 100);
		groups.push(`缓存命中 ${percent}%`);
	}

	const output = stats.outputTokens ?? 0;
	if (input > 0 || output > 0) {
		groups.push(
			`输入 ${formatCompactNumber(input)} tok · 输出 ${formatCompactNumber(output)} tok`,
		);
	}

	return groups.join("| ");
}

/**
 * A compact Chinese duration: `5分54秒`, `1秒`, `2时3分`. Rounds to whole
 * seconds and drops a zero seconds part so short timings stay terse.
 */
export function formatDuration(ms) {
	const totalSeconds = Math.max(0, Math.round((ms ?? 0) / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}秒`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) {
		return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分`;
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0
		? `${hours}时${remainingMinutes}分`
		: `${hours}时`;
}

import assert from "node:assert/strict";
import test from "node:test";

/**
 * The session-info formatter (`src/server/web/session-format.js`) ships to the
 * browser as a plain ES module and is dependency-free, so it can be imported
 * straight into Node and driven with synthetic stats payloads.
 */
const moduleUrl = new URL(
	"../src/server/web/session-format.js",
	import.meta.url,
);

async function loadFormat(): Promise<{
	formatSessionInfo: (stats: Record<string, unknown> | null) => string;
	formatDuration: (ms: number) => string;
	normalizeSessionStats: (body: unknown) => Record<string, unknown> | null;
}> {
	return (await import(moduleUrl.href)) as unknown as {
		formatSessionInfo: (stats: Record<string, unknown> | null) => string;
		formatDuration: (ms: number) => string;
		normalizeSessionStats: (body: unknown) => Record<string, unknown> | null;
	};
}

test("formats the full session info line", async () => {
	const { formatSessionInfo } = await loadFormat();
	const line = formatSessionInfo({
		turns: 2,
		steps: 108,
		inputTokens: 11_200_000,
		outputTokens: 62_400,
		cacheReadTokens: 990_000,
		cacheWriteTokens: 0,
		llmMs: 354_000,
		toolMs: 314_000,
		firstTokenAvgMs: 1000,
		tokensPerSecond: 255,
	});
	assert.equal(
		line,
		"2 轮 · 108 步| LLM 5分54秒 · 工具调用 5分14秒| 首 token 平均 1秒 · 255 tok/s| 缓存命中 8%| 输入 11.2M tok · 输出 62.4K tok",
	);
});

test("omits groups whose data is unknown", async () => {
	const { formatSessionInfo } = await loadFormat();
	assert.equal(formatSessionInfo(null), "");
	assert.equal(
		formatSessionInfo({
			turns: 1,
			steps: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			llmMs: 0,
			toolMs: 0,
			firstTokenAvgMs: null,
			tokensPerSecond: null,
		}),
		"1 轮 · 0 步",
	);
});

test("cache hit rate is cacheRead over input + cacheRead", async () => {
	const { formatSessionInfo } = await loadFormat();
	const line = formatSessionInfo({
		turns: 1,
		steps: 1,
		inputTokens: 100,
		outputTokens: 10,
		cacheReadTokens: 900,
		cacheWriteTokens: 0,
	});
	assert.match(line, /缓存命中 90%/);
});

test("formats durations across seconds, minutes and hours", async () => {
	const { formatDuration } = await loadFormat();
	assert.equal(formatDuration(0), "0秒");
	assert.equal(formatDuration(1000), "1秒");
	assert.equal(formatDuration(59_400), "59秒");
	assert.equal(formatDuration(60_000), "1分");
	assert.equal(formatDuration(354_000), "5分54秒");
	assert.equal(formatDuration(3_600_000), "1时");
	assert.equal(formatDuration(3_780_000), "1时3分");
});

test("normalizes missing fields to zero and means to null", async () => {
	const { normalizeSessionStats } = await loadFormat();
	assert.equal(normalizeSessionStats(null), null);
	const stats = normalizeSessionStats({ turns: 3, firstTokenAvgMs: 1200 });
	assert.ok(stats);
	assert.equal(stats.turns, 3);
	assert.equal(stats.steps, 0);
	assert.equal(stats.firstTokenAvgMs, 1200);
	assert.equal(stats.tokensPerSecond, null);
});

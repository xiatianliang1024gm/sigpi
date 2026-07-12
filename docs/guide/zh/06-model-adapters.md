# 6. 模型适配器（进阶）

agent 循环调用 `provider.generate(...)`。本章打开这个 seam：SigPi 如何用一个 OpenAI 兼容的模型
*对话 HTTP*，**并且**支持两种线格式而不 fork 代码。

## Provider seam

`ModelProvider`（`src/types.ts`）只有一个方法：

```ts
interface ModelProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}
```

循环需要的一切都在这个接口之后。换 provider（或在测试里 mock 它）就是换一个对象。
`OpenAICompatibleProvider` 是具体实现。

## 一个薄的组合器

`src/model/openai-compatible.ts`：

```ts
generate(request, makeAdapter) {
  return this.transport.generate(request, () =>
    this.config.apiFormat === "responses"
      ? new ResponsesAdapter(this.config)
      : new ChatCompletionsAdapter(this.config),
  );
}
```

两个职责，干净地分开：

- **`ModelTransport`**（`src/model/transport.ts`）持有 *HTTP 弹性*——且对任何一种 API 形状都一无所知。
- **`WireFormatAdapter`**（`src/model/wire-format.ts`）持有 *格式形状*——且对 HTTP 一无所知。

## Transport 持有什么（与格式无关）

`ModelTransport` 处理那些无聊、必要、容易写错的部分：

- **Fetch + 鉴权** — `POST`，带 API key 与 JSON body。
- **超时** — 非流式路径用总截止计时器；流式路径用**静默/停滞计时器**，在*每收到一个 chunk*时重置
  （于是慢但活着流不会被杀掉，而死掉的服务器或流中停顿会被杀掉）。
- **Abort 合并** — 把外部 abort 信号（用户中断）与超时信号合并。
- **错误分类** — `ModelRequestError` 带 `RequestFailureKind` 标签
  （timeout / network_error / http_error / invalid_json / stream_error / …）。
- **重试/退避** — 指数退避（上限 4 秒），只重试可重试的种类（超时、网络错误、429、5xx）。

这些都不提 `chat_completions` 或 `responses`。这正是重点。

## 适配器持有什么（与格式相关）

```ts
interface WireFormatAdapter {
  buildUrl(): string;                       // 端点
  toRequestBody(request): Record<...>;      // 请求体形状
  parse(data): ModelResponse;              // 非流式解析
  accumulate(frame): void;                 // 折叠一个 SSE delta
  finalize(): ModelResponse;               // 完整响应
}
```

两个实现：`ChatCompletionsAdapter` 与 `ResponsesAdapter`。每个都知道自己的端点、请求体，以及如何
把流式 delta 折叠成 `ModelResponse`。transport 只是把每个 SSE `data:` 帧喂给
`adapter.accumulate`，结束时调用 `adapter.finalize()`。

## 为什么这样分

你最初的痛点是那些「支持很多模型」却变成不可读乱麻的代码库。SigPi 的答案很小：

- **支持另一种格式** = 写*一个*适配器。你从不需要碰 transport。
- **支持另一种 transport**（例如不同的 HTTP 栈）= 写*一个* transport。你从不需要碰适配器。

`apiFormat` 配置项选择适配器；transport 被共享。这就是整个「多模型」故事，而且只用了几百行。

## 关键收获

- 模型层是两个 seam：**有弹性的 HTTP**（transport）与**线格式**（adapter）。
- transport 与格式无关；adapter 与 HTTP 无关。
- 加一种模型格式就是新增一个适配器，而非 fork。
- `ModelProvider` 接口正是让循环能用 mock 测试的原因。

下一步：[会话与持久化](./07-session.md)。

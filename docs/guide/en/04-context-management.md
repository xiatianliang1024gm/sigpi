# 4. Context Management

The agent loop produces messages. Tool results, especially, can be large. Left unchecked, the
working context grows until it exceeds the model's token limit and the request fails. **Context
management** is how SigPi stays inside that budget without losing the conversation.

## The three-part scheme

SigPi keeps the working context within the token window using three cooperating pieces:

1. **Summary** — a rolling condensation of older material.
2. **Recent messages** — the un-summarized tail the model must see verbatim.
3. **In-turn checkpoint** — a condensation of the *current* turn when it gets long (covered in
   [Chapter 2](./02-agent-loop.md#in-turn-checkpoint-compaction)).

The owner of all three is `ConversationContext` (`src/agent/context.ts`).

## Compaction: summarizing to make room

When `appendMessages` is called at the end of a turn, the context checks the estimated token
count against the budget (`hard_context_limit - reserveTokens`). If it is over, it **compacts**:

- Older recent messages are folded into the **summary** by the model (a summarization call).
- The recent-message tail is trimmed to `keepRecentTokens`.

This is why the loop can run for many steps and many turns: the past is continuously compressed
into the summary, and only the salient recent window stays verbatim.

Two triggers:

- **Token trigger** — the running estimate crosses the budget (the common case).
- **Force** — an explicit `/compact` command asks for it on demand.

If compaction itself fails (e.g. the summarizer errors), SigPi degrades gracefully: it trims
rather than throws, so a turn still completes. See `CompactionFailedError` handling in
`runTurn`.

## Why summarize and not just truncate?

Truncating the oldest messages loses information silently. Summarizing preserves *what was learned*
in compressed form, so the model still has the gist of earlier exploration. It is the difference
between "we forgot the beginning" and "we remember the beginning briefly."

## The exploration ledger

Re-exploring the same files is a classic waste. Alongside the summary, the context keeps an
**exploration ledger** (`src/agent/exploration-ledger.ts`): a structured record of what has been
searched, read, modified, and found. Key findings are injected back into the working context so the
model is less likely to re-do work it already did.

This is a small but real lesson: a production agent does not just manage *tokens*, it manages
*knowledge* — remembering what it already knows so it does not burn steps rediscovering it.

## The numbers you will see

From `runTurn` and the context options:

- `hard_context_limit` — the model's total token budget (per-model; default `200_000`).
- `reserveTokens` — headroom kept free for the next request (per-model).
- `keepRecentTokens` — how much of the recent tail stays verbatim (per-model).
- `TURN_CHECKPOINT_KEEP_LAST_MESSAGES = 4` — how many messages survive an in-turn checkpoint.
- `DEDUP_WINDOW = 6` — how far back tool-call deduplication looks (Chapter 2).

These are all knobs, not magic. Tune them and you directly trade off cost, memory, and quality.

## Key takeaways

- The loop generates messages; context management keeps them inside the token budget.
- **Summary + recent messages + in-turn checkpoint** is the whole scheme.
- Compaction summarizes (not truncates) to preserve learned information.
- The exploration ledger combats re-exploration — managing *knowledge*, not just *tokens*.

This completes the **core three**: loop, function calling, context management. Everything from
here is advanced or higher-level.

Next: [Tools & ToolRegistry](./05-tools.md).

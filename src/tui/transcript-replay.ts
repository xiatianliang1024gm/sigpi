import type { Component } from "@earendil-works/pi-tui";
import type { ToolRegistry } from "../tools/registry.js";
import type {
	CompactionEntry,
	PersistedSession,
	SessionEntry,
	ToolCall,
} from "../types.js";
import type { ReplView } from "./chat-renderer.js";
import {
	AssistantMessageComponent,
	SystemMessageComponent,
	ToolLineComponent,
	UserMessageComponent,
} from "./messages.js";
import { formatCompactNumber } from "./status-bar.js";

/**
 * Convert a persisted session's entry stream into the same TUI transcript
 * components the live REPL renders, so attaching to a session (`/resume`) or
 * starting with `--session <id>` shows the target conversation in the
 * terminal instead of hiding it behind a separate `/history` view.
 *
 * Mapping mirrors the live rendering: user messages render as user lines,
 * assistant messages render with their reasoning + content (locked via
 * `finalize()`), tool messages render as two-phase tool lines (failed tools
 * keep their error), and compaction entries render as an info notice showing
 * the context-window change (`tokensBefore → tokensAfter`) — the summary
 * body is not meaningful in a transcript, so it is not shown.
 *
 * `tools` is used to reconstruct the tool-line label (e.g. `shell git status`
 * for bash) from the persisted `ToolCall.arguments` via `describeProgress`,
 * matching what the live REPL showed during the turn. When `tools` is
 * omitted (e.g. in tests) the label falls back to the tool name.
 */
export function buildTranscriptComponents(
	entries: readonly SessionEntry[],
	tools?: ToolRegistry,
): Component[] {
	const components: Component[] = [];
	// Index tool calls by id as we walk the stream so a tool message can
	// look up its originating call's arguments even when the assistant
	// message and tool message are not adjacent in the entry list (e.g.
	// after compaction drops the assistant turn).
	const toolCallsById = new Map<string, ToolCall>();
	for (const entry of entries) {
		if (entry.kind !== "message") continue;
		if (entry.message.role === "assistant" && entry.message.toolCalls) {
			for (const call of entry.message.toolCalls) {
				toolCallsById.set(call.id, call);
			}
		}
	}

	for (const entry of entries) {
		if (entry.kind === "compaction") {
			components.push(buildCompactionComponent(entry));
			continue;
		}

		const message = entry.message;
		if (message.role === "user") {
			components.push(new UserMessageComponent(message.content));
		} else if (message.role === "assistant") {
			const component = new AssistantMessageComponent();
			if (message.reasoning) {
				component.appendReasoning(message.reasoning);
			}
			if (message.content) {
				component.appendContent(message.content);
			}
			// Lock the message so the replay reads as a completed transcript,
			// not an in-flight stream.
			component.finalize();
			components.push(component);
		} else if (message.role === "tool") {
			const call = toolCallsById.get(message.toolCallId);
			components.push(
				buildToolComponent(message.name, message.content, call, tools),
			);
		}
	}
	return components;
}

/**
 * Replay `session`'s transcript into `view`, replacing whatever the terminal
 * currently shows (editor and status bar are kept). A `null` view or session
 * is a no-op / clears the transcript respectively, so callers can use this
 * for both `/resume` (loaded session) and `/new` (fresh, empty session).
 *
 * `tools` is forwarded to {@link buildTranscriptComponents} so tool lines
 * show the same argument summary the live REPL rendered during the turn.
 */
export function replaySessionIntoView(
	view: ReplView | null,
	session: PersistedSession | null,
	tools?: ToolRegistry,
): void {
	if (!view) {
		return;
	}
	view.replaceTranscript(
		buildTranscriptComponents(session?.entries ?? [], tools),
	);
}

function buildCompactionComponent(
	entry: CompactionEntry,
): SystemMessageComponent {
	const { tokensBefore, tokensAfter } = entry;
	const header =
		typeof tokensBefore === "number" &&
		typeof tokensAfter === "number" &&
		(tokensBefore > 0 || tokensAfter > 0)
			? `Context compacted: context window ${formatCompactNumber(tokensBefore)} → ${formatCompactNumber(tokensAfter)} tokens.`
			: "Context compacted.";
	// The summary body is a model digest of the compacted messages — showing
	// it in a replayed transcript adds noise without context, so only the
	// window change is rendered.
	return new SystemMessageComponent(header, "info");
}

function buildToolComponent(
	name: string,
	content: string,
	call: ToolCall | undefined,
	tools: ToolRegistry | undefined,
): ToolLineComponent {
	// Reconstruct the same label the live REPL showed during the turn:
	// `describeProgress` turns the tool call's arguments into a short
	// human-readable summary (e.g. `shell git status`, `search files
	// mentioning "foo"`). Fall back to the bare tool name when the call
	// can't be found (compaction dropped the assistant turn) or the tool
	// is no longer registered.
	const label = formatToolLabel(name, call, tools);
	const component = new ToolLineComponent(label);
	const error = extractToolError(content);
	if (error) {
		component.fail(error);
	}
	return component;
}

function formatToolLabel(
	name: string,
	call: ToolCall | undefined,
	tools: ToolRegistry | undefined,
): string {
	if (!call || !tools) {
		return name;
	}
	try {
		return tools.describeProgress(call).summary;
	} catch {
		// Tool removed or arguments no longer match its schema — fall back
		// to the bare name so the replay still renders something useful.
		return name;
	}
}

/**
 * Pull the error line out of a persisted failed-tool result. Failed tool
 * messages are rendered by {@link formatToolExecutionResult} with a
 * `STATUS: error` / `ERROR: <message>` shape; anything else renders as a
 * plain (succeeded) tool line, matching the live transcript.
 */
function extractToolError(content: string): string | null {
	for (const line of content.split("\n")) {
		if (line.startsWith("ERROR: ")) {
			return line.slice("ERROR: ".length);
		}
	}
	return null;
}

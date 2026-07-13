import { readFile, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { RunShellConfig } from "../../config.js";
import { asInlineCode, getString } from "../../progress.js";
import type { ToolDefinition } from "../../types.js";
import { createEditSummary } from "../edit-summary.js";
import type { ReadTracker } from "../read-tracker.js";
import { ToolExecutionError } from "../registry.js";
import { joinRenderedSections, withRendered } from "../render.js";
import {
	resolveWritableWorkspacePath,
	SandboxPolicyError,
} from "../sandbox-policy.js";

const editSchema = z.object({
	file_path: z.string().min(1),
	old_string: z.string().min(1),
	new_string: z.string(),
	replace_all: z.boolean().optional(),
});

type EditArgs = z.infer<typeof editSchema>;

export function createEditTool(
	config: RunShellConfig = { mode: "workspace_write" },
	tracker: ReadTracker,
	allowedRoots: string[] = [],
): ToolDefinition<EditArgs> {
	return {
		name: "edit",
		description:
			"Perform an exact string replacement on an existing file under the working directory. " +
			"Replaces the first occurrence of `old_string` with `new_string`. " +
			"Use empty `new_string` to delete text. " +
			"The read-before-edit rule requires three checks before the replacement is applied, in this order: " +
			"(1) the file must have been read this conversation via the read tool (or a recognized read command in bash) and must not have changed on disk since; " +
			"(2) `old_string` must appear in the file exactly; " +
			"(3) `old_string` must appear exactly once, unless `replace_all` is true. " +
			"No regex or fuzzy matching is used; a single character of whitespace or indentation difference is enough to miss. " +
			"When `old_string` appears more than once, supply a longer string with more surrounding context or set `replace_all: true`. " +
			"To create a new file, use the write tool instead. " +
			"To replace every occurrence, set `replace_all: true`.",
		inputSchema: editSchema,
		parameters: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description:
						"Path to the file to edit (relative to the working directory). The file must already exist and must have been read this conversation.",
				},
				old_string: {
					type: "string",
					description:
						"Exact text to replace. Must match the file content exactly, including whitespace and indentation. Must not be empty.",
				},
				new_string: {
					type: "string",
					description: "Replacement text. May be empty to delete the old text.",
				},
				replace_all: {
					type: "boolean",
					description:
						"Replace every occurrence of old_string instead of requiring a unique match. Default is false.",
				},
			},
			required: ["file_path", "old_string", "new_string"],
			additionalProperties: false,
		},
		execute: async (
			{ file_path, old_string, new_string, replace_all = false },
			context,
		) => {
			let resolved: string;
			let relative: string;
			try {
				({ resolved, relative } = resolveWritableWorkspacePath(
					context.cwd,
					file_path,
					config.mode,
					"edit",
					allowedRoots,
				));
			} catch (error) {
				if (error instanceof SandboxPolicyError) {
					throw new ToolExecutionError(error.message);
				}
				throw error;
			}

			// Existence: the edit tool only modifies existing files.
			let fileExists = false;
			try {
				await stat(resolved);
				fileExists = true;
			} catch (error) {
				if (
					!(
						typeof error === "object" &&
						error !== null &&
						"code" in error &&
						error.code === "ENOENT"
					)
				) {
					throw error;
				}
			}
			if (!fileExists) {
				throw new ToolExecutionError(
					`File does not exist: ${relative}. Use the write tool to create it.`,
					withRendered(
						{
							reason: "file_not_found",
						},
						joinRenderedSections([
							`Path: ${relative}`,
							"Reason: file does not exist. Use the write tool to create it.",
						]),
					),
				);
			}

			// Check 1: read-before-edit. Runs before any string matching.
			if (!tracker.hasRead(resolved)) {
				throw new ToolExecutionError(
					`File has not been read yet. Read ${relative} with the read tool before editing it.`,
					withRendered(
						{
							reason: "not_read",
							guidance:
								"Use the read tool on this file, then retry the edit with an exact old_string copied from the current contents.",
						},
						joinRenderedSections([
							`Path: ${relative}`,
							"Reason: file has not been read this conversation.",
							"Guidance: read the file first, then retry the edit.",
						]),
					),
				);
			}
			if (await tracker.hasChangedSinceRead(resolved)) {
				throw new ToolExecutionError(
					`File changed on disk since it was read. Re-read ${relative} before editing.`,
					withRendered(
						{
							reason: "changed_since_read",
							guidance:
								"Re-read the file with the read tool; its contents may have changed since the last read.",
						},
						joinRenderedSections([
							`Path: ${relative}`,
							"Reason: file changed on disk since it was last read.",
							"Guidance: re-read the file, then retry the edit.",
						]),
					),
				);
			}

			// Checks 2 & 3: match + uniqueness.
			const original = await readFile(resolved, "utf8");
			const matchCount = countOccurrences(original, old_string);

			if (matchCount === 0) {
				throw new ToolExecutionError(
					`old_string not found in ${relative}.`,
					withRendered(
						{
							oldStringPreview: preview(old_string),
							reason: "not_found",
							guidance:
								"Re-read the file and copy old_string exactly from the current contents, including whitespace.",
						},
						joinRenderedSections([
							`Path: ${relative}`,
							`old_string preview: ${preview(old_string)}`,
							"Reason: old_string does not appear in the file.",
							"Guidance: re-read the file and copy old_string verbatim.",
						]),
					),
				);
			}

			if (!replace_all && matchCount > 1) {
				throw new ToolExecutionError(
					`old_string matched ${matchCount} locations in ${relative}.`,
					withRendered(
						{
							matchCount,
							reason: "not_unique",
							guidance:
								"Supply a longer old_string with more surrounding context to pin down one occurrence, or set replace_all: true to replace all.",
						},
						joinRenderedSections([
							`Path: ${relative}`,
							`Match count: ${matchCount}`,
							"Reason: old_string is not unique.",
							"Guidance: narrow old_string with more context, or set replace_all: true.",
						]),
					),
				);
			}

			const replacements = replace_all ? matchCount : 1;
			const updated = replace_all
				? original.split(old_string).join(new_string)
				: replaceFirst(original, old_string, new_string);

			await writeFile(resolved, updated, "utf8");
			await tracker.recordResolved(resolved);

			return withRendered(
				{
					replacements,
					replaceAll: replace_all,
					editSummary: createEditSummary(
						relative,
						original,
						old_string,
						new_string,
						replace_all,
					),
				},
				joinRenderedSections([
					`Path: ${relative}`,
					`Replacements: ${replacements}`,
					`Replace all: ${replace_all}`,
				]),
			);
		},
		describeProgress(args) {
			return {
				summary: `edit ${asInlineCode(getString(args.file_path) ?? "(unknown file)")}`,
			};
		},
		recordLedger(recorder, toolCall, result) {
			const path = getString(toolCall.arguments.file_path);
			if (path) {
				recorder.modified(path);
			}
			const data = (result.data ?? null) as Record<string, unknown> | null;
			const dataPath = getString(data?.path);
			if (dataPath) {
				recorder.modified(dataPath);
			}
		},
	};
}

function countOccurrences(content: string, search: string): number {
	let count = 0;
	let fromIndex = 0;
	while (true) {
		const index = content.indexOf(search, fromIndex);
		if (index === -1) {
			return count;
		}
		count += 1;
		fromIndex = index + search.length;
	}
}

function replaceFirst(
	content: string,
	search: string,
	replace: string,
): string {
	const index = content.indexOf(search);
	return (
		content.slice(0, index) + replace + content.slice(index + search.length)
	);
}

function preview(value: string): string {
	const truncated = value.length > 120 ? `${value.slice(0, 117)}...` : value;
	return JSON.stringify(truncated);
}

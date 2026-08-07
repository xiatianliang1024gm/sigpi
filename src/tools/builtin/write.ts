import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { asInlineCode, getString } from "../../progress.js";
import type { ToolDefinition } from "../../types.js";
import { createWriteSummary } from "../edit-summary.js";
import {
	applyLineEndingStyle,
	detectLineEndingStyle,
	normalizeLineEndings,
} from "../line-endings.js";
import { resolveWorkspacePath } from "../path-utils.js";
import type { ReadTracker } from "../read-tracker.js";
import { ToolExecutionError } from "../registry.js";
import { withRendered } from "../render.js";

const writeSchema = z.object({
	file_path: z.string().min(1),
	content: z.string(),
});

type WriteArgs = z.infer<typeof writeSchema>;

export function createWriteTool(
	tracker: ReadTracker,
): ToolDefinition<WriteArgs> {
	return {
		name: "write",
		description:
			"Write UTF-8 text to a file under the working directory. " +
			"Creates the file if it does not exist and overwrites it if it does. " +
			"Parent directories are created automatically. " +
			"New files use LF line endings. When overwriting an existing file, the file's current line-ending style (CRLF or LF) and a leading UTF-8 BOM are preserved. " +
			"Unlike the edit tool, this does not require a prior read and replaces the entire file contents. " +
			"Use edit for targeted changes to an existing file.",
		inputSchema: writeSchema,
		parameters: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description:
						"Path to the file to write (relative to the working directory).",
				},
				content: {
					type: "string",
					description: "Full UTF-8 text content to write.",
				},
			},
			required: ["file_path", "content"],
			additionalProperties: false,
		},
		execute: async ({ file_path, content }, context) => {
			let resolved: string;
			let relative: string;
			try {
				({ resolved, relative } = resolveWorkspacePath(context.cwd, file_path));
			} catch (error) {
				if (error instanceof Error) {
					throw new ToolExecutionError(error.message);
				}
				throw error;
			}

			await mkdir(path.dirname(resolved), { recursive: true });
			const previousContent = await readExistingFile(resolved);
			const normalized = normalizeLineEndings(content);

			// New files always land as LF (model-emitted `\r\n` must not flip a
			// fresh file to CRLF). Overwrites keep the existing file's encoding
			// shape — BOM + dominant line-ending style — so writing over a
			// Windows CRLF file doesn't rewrite every line in the diff.
			let output: string;
			if (previousContent === null) {
				output = normalized;
			} else {
				const bomPrefix = previousContent.startsWith("\uFEFF") ? "\uFEFF" : "";
				output =
					bomPrefix +
					applyLineEndingStyle(
						normalized,
						detectLineEndingStyle(previousContent),
					);
			}
			await writeFile(resolved, output, "utf8");

			// Refresh the read fingerprint: the model authored this content, so
			// a later edit in the same turn is permitted without a re-read, and
			// any external change afterward is still detected.
			await tracker.recordResolved(resolved);

			return withRendered(
				{
					bytesWritten: Buffer.byteLength(output, "utf8"),
					created: previousContent === null,
					editSummary: createWriteSummary(relative, previousContent, output),
				},
				"ok",
			);
		},
		describeProgress(args) {
			return {
				summary: `write ${asInlineCode(getString(args.file_path) ?? "(unknown file)")}`,
			};
		},
	};
}

async function readExistingFile(filePath: string): Promise<string | null> {
	try {
		return await readFile(filePath, "utf8");
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return null;
		}
		throw error;
	}
}

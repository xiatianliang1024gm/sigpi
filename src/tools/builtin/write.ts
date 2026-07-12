import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RunShellConfig } from "../../config.js";
import { asInlineCode, getString } from "../../progress.js";
import type { ToolDefinition } from "../../types.js";
import { createWriteSummary } from "../edit-summary.js";
import type { ReadTracker } from "../read-tracker.js";
import { ToolExecutionError } from "../registry.js";
import { joinRenderedSections, withRendered } from "../render.js";
import {
	resolveWritableWorkspacePath,
	SandboxPolicyError,
} from "../sandbox-policy.js";

const writeSchema = z.object({
	file_path: z.string().min(1),
	content: z.string(),
});

type WriteArgs = z.infer<typeof writeSchema>;

export function createWriteTool(
	config: RunShellConfig = { mode: "workspace_write" },
	tracker: ReadTracker,
): ToolDefinition<WriteArgs> {
	return {
		name: "write",
		description:
			"Write UTF-8 text to a file under the working directory. " +
			"Creates the file if it does not exist and overwrites it if it does. " +
			"Parent directories are created automatically. " +
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
				({ resolved, relative } = resolveWritableWorkspacePath(
					context.cwd,
					file_path,
					config.mode,
					"write",
				));
			} catch (error) {
				if (error instanceof SandboxPolicyError) {
					throw new ToolExecutionError(error.message);
				}
				throw error;
			}

			await mkdir(path.dirname(resolved), { recursive: true });
			const previousContent = await readExistingFile(resolved);
			await writeFile(resolved, content, "utf8");

			// Refresh the read fingerprint: the model authored this content, so
			// a later edit in the same turn is permitted without a re-read, and
			// any external change afterward is still detected.
			await tracker.recordResolved(resolved);

			return withRendered(
				{
					bytesWritten: Buffer.byteLength(content, "utf8"),
					created: previousContent === null,
					editSummary: createWriteSummary(relative, previousContent, content),
				},
				joinRenderedSections([
					`Path: ${relative}`,
					`Bytes written: ${Buffer.byteLength(content, "utf8")}`,
					`Created: ${previousContent === null ? "yes" : "no"}`,
				]),
			);
		},
		describeProgress(args) {
			return {
				summary: `write ${asInlineCode(getString(args.file_path) ?? "(unknown file)")}`,
			};
		},
		recordLedger(recorder, toolCall) {
			const path = getString(toolCall.arguments.file_path);
			if (path) {
				recorder.modified(path);
			}
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

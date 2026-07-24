import {
	CombinedAutocompleteProvider,
	Editor,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ChatCommandMetadata } from "./chat-commands.js";
import { defaultEditorTheme } from "./tui/themes.js";

export function buildEditor(
	tui: TUI,
	opts: {
		commands: readonly ChatCommandMetadata[];
	},
): Editor {
	const editor = new Editor(tui, defaultEditorTheme);
	const provider = new CombinedAutocompleteProvider(
		opts.commands.map((command) => ({
			// rm prefix /. eg: /model => model
			name: command.name.slice(1),
			description: command.description,
		})),
		process.cwd(),
	);
	editor.setAutocompleteProvider(provider);
	return editor;
}

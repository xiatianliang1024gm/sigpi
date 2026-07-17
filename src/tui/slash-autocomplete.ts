import {
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "@earendil-works/pi-tui";

/**
 * SigPi slash-command autocomplete.
 *
 * Pi-tui's `CombinedAutocompleteProvider` already knows how to complete slash
 * commands (it inspects a `/`-prefixed token), but it does not advertise a
 * trigger character, so Pi-tui's `Editor` never opens the suggestion menu on
 * `/`. This subclass advertises `/` as a trigger so the menu opens as the user
 * types a slash command — matching the previous SigPi behavior.
 *
 * Pi-tui's completion logic re-adds the leading `/` itself (it assumes
 * `SlashCommand.name` is the bare command, e.g. `summary`, not `/summary`),
 * so we strip the leading slash from SigPi's command names on the way in.
 */
export class SlashAutocompleteProvider extends CombinedAutocompleteProvider {
	constructor(commands: SlashCommand[], basePath: string) {
		super(
			commands.map((command) => ({
				...command,
				name: command.name.replace(/^\//, ""),
			})),
			basePath,
		);
	}

	get triggerCharacters(): string[] {
		return ["/"];
	}
}

import type {
	AutocompleteItem,
	AutocompleteSuggestions,
	CombinedAutocompleteProvider,
} from "@earendil-works/pi-tui";

/**
 * pi-tui@0.80.3's `@`-file completion silently stops working when the `fd`
 * binary is not installed: `getFuzzyFileSuggestions()` returns `[]` for a
 * `null` fdPath, and `getSuggestions()` then returns `null` — no completion
 * at all. This is the common case on Windows (no `fd`) and on any machine
 * where `fd` is absent.
 *
 * We used to fix this with a patch-package postinstall patch, but a
 * postinstall patch cannot ship to consumers who install SigPi via
 * `pnpm add` (the patch file and pnpm patchedDependencies config are not
 * published, and postinstall scripts are exactly what breaks such installs).
 * Instead we replicate the same fallback at runtime: when the provider
 * itself yields nothing for an `@`-prefix, ask its native synchronous file
 * listing (`getFileSuggestions`, which is a real method on the instance at
 * runtime even though the .d.ts marks it private) to fill in.
 */
export function withAtFileFallback(
	provider: CombinedAutocompleteProvider,
): CombinedAutocompleteProvider {
	// The .d.ts declares these private, but at runtime they are plain methods
	// on the instance (pi-tui is plain JS; `private` is compile-time only).
	// Guard with typeof checks so a future pi-tui that removes them degrades
	// to the original behaviour instead of throwing.
	const shim = provider as unknown as {
		extractAtPrefix?: (text: string) => string | null;
		getFileSuggestions?: (prefix: string) => AutocompleteItem[];
	};
	const extractAtPrefix = shim.extractAtPrefix?.bind(provider);
	const getFileSuggestions = shim.getFileSuggestions?.bind(provider);
	if (
		typeof extractAtPrefix !== "function" ||
		typeof getFileSuggestions !== "function"
	) {
		return provider;
	}

	const originalGetSuggestions = provider.getSuggestions.bind(provider);
	provider.getSuggestions = async (
		lines,
		cursorLine,
		cursorCol,
		options,
	): Promise<AutocompleteSuggestions | null> => {
		const result = await originalGetSuggestions(
			lines,
			cursorLine,
			cursorCol,
			options,
		);
		if (result !== null) {
			return result;
		}
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const atPrefix = extractAtPrefix(textBeforeCursor);
		if (!atPrefix) {
			return result;
		}
		const items = getFileSuggestions(atPrefix);
		if (items.length === 0) {
			return result;
		}
		return { items, prefix: atPrefix };
	};
	return provider;
}

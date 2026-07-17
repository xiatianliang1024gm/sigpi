/**
 * Wrap-around index advance for a vertical selection list.
 *
 * Kept as a standalone SigPi helper (no Pi-tui dependency) because Pi-tui
 * does not export an equivalent. Used by the session selector and the chat
 * input suggestion navigation.
 */
export function moveSelectedIndex(
	selectedIndex: number,
	itemCount: number,
	delta: number,
): number {
	if (itemCount <= 0) {
		return selectedIndex;
	}

	return (selectedIndex + delta + itemCount) % itemCount;
}

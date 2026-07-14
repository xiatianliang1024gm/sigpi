/**
 * In-memory, process-scoped recall buffer for previously submitted chat inputs.
 *
 * Mirrors shell `↑`/`↓` history: the live draft is a distinct slot at the bottom
 * of the list, `↓` past the newest entry returns to the draft, and `↑` past the
 * oldest entry stops (no wrap). Entries are stored whole (multiline preserved)
 * with consecutive-duplicate suppression. The buffer holds no TUI state and is
 * decoupled from the {@link Editor}, so the input components stay pure
 * text-editing primitives.
 *
 * A single buffer is created once at CLI startup and shared by the idle input
 * component, the running-turn input component, and the REPL loop's write path.
 */
export class InputHistory {
	private entries: string[] = [];
	/** Position in the list; equals `entries.length` when sitting on the draft slot. */
	private index = 0;

	/**
	 * Record a submitted line. Empty lines and consecutive duplicates are ignored
	 * so repeated sends don't fill the buffer. Recording returns the position to
	 * the draft slot.
	 */
	push(line: string): void {
		if (line === "") {
			return;
		}
		const last = this.entries[this.entries.length - 1];
		if (last === line) {
			return;
		}
		this.entries.push(line);
		this.index = this.entries.length;
	}

	/**
	 * Move toward older entries. Returns the entry, or `null` when already at the
	 * oldest entry (no wrap).
	 */
	prev(): string | null {
		if (this.entries.length === 0 || this.index === 0) {
			return null;
		}
		this.index -= 1;
		return this.entries[this.index];
	}

	/**
	 * Move toward newer entries / the draft slot. Returns the entry, or `null`
	 * when sitting on the draft slot (past the newest entry).
	 */
	next(): string | null {
		if (this.index < this.entries.length) {
			this.index += 1;
		}
		if (this.index === this.entries.length) {
			return null;
		}
		return this.entries[this.index];
	}

	/** The current entry, or `null` when sitting on the draft slot. */
	current(): string | null {
		if (this.index === this.entries.length) {
			return null;
		}
		return this.entries[this.index];
	}

	/** Return to the draft slot (e.g. after a recalled line is edited). */
	resetToDraft(): void {
		this.index = this.entries.length;
	}

	get size(): number {
		return this.entries.length;
	}

	/** Whether the position is the draft slot (not a recorded entry). */
	get isAtDraft(): boolean {
		return this.index === this.entries.length;
	}
}

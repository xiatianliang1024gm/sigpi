export type KeyId =
	| "escape"
	| "enter"
	| "tab"
	| "backspace"
	| "delete"
	| "home"
	| "end"
	| "up"
	| "down"
	| "left"
	| "right"
	| "ctrl+c"
	| "ctrl+d";

const KEY_SEQUENCES: Record<string, KeyId> = {
	"\x1B": "escape",
	"\r": "enter",
	"\n": "enter",
	"\t": "tab",
	"\u007F": "backspace",
	"\b": "backspace",
	"\x1B[3~": "delete",
	"\x1B[H": "home",
	"\x1B[1~": "home",
	"\x1BOH": "home",
	"\x1B[F": "end",
	"\x1B[4~": "end",
	"\x1BOF": "end",
	"\x1B[A": "up",
	"\x1B[B": "down",
	"\x1B[D": "left",
	"\x1B[C": "right",
	"\u0003": "ctrl+c",
	"\u0004": "ctrl+d",
};

export function parseKey(data: string): KeyId | null {
	return KEY_SEQUENCES[data] ?? null;
}

export function matchesKey(data: string, key: KeyId): boolean {
	return parseKey(data) === key;
}

export function isPrintableInput(data: string): boolean {
	if (data.length === 0 || data.includes("\x1B")) {
		return false;
	}

	return Array.from(data).every((char) => {
		const codePoint = char.codePointAt(0);
		return codePoint !== undefined && codePoint >= 32 && codePoint !== 127;
	});
}

import { parseKey } from "./keys.js";
import type { Component } from "./tui.js";
import { truncateToWidth } from "./utils.js";

export interface SelectListItem<TValue = string> {
	label: string;
	description?: string;
	value: TValue;
}

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

export class SelectList<TValue = string> implements Component {
	public onSelect?: (item: SelectListItem<TValue>) => void;
	public onCancel?: () => void;
	private selectedIndex = 0;

	constructor(
		private readonly items: readonly SelectListItem<TValue>[],
		args?: { selectedIndex?: number },
	) {
		this.selectedIndex = moveSelectedIndex(
			args?.selectedIndex ?? 0,
			items.length,
			0,
		);
	}

	getSelectedIndex(): number {
		return this.selectedIndex;
	}

	getSelectedItem(): SelectListItem<TValue> | null {
		return this.items[this.selectedIndex] ?? null;
	}

	handleInput(data: string): void {
		const key = parseKey(data);
		if (key === "up") {
			this.move(-1);
			return;
		}
		if (key === "down") {
			this.move(1);
			return;
		}
		if (key === "enter") {
			const selected = this.getSelectedItem();
			if (selected) {
				this.onSelect?.(selected);
			}
			return;
		}
		if (key === "escape" || key === "ctrl+c") {
			this.onCancel?.();
		}
	}

	render(width: number, _maxHeight?: number): string[] {
		if (this.items.length === 0) {
			return ["(no items)"];
		}

		return this.items.map((item, index) => {
			const prefix = index === this.selectedIndex ? "> " : "  ";
			const description = item.description ? `  ${item.description}` : "";
			return truncateToWidth(`${prefix}${item.label}${description}`, width);
		});
	}

	private move(delta: number): void {
		this.selectedIndex = moveSelectedIndex(
			this.selectedIndex,
			this.items.length,
			delta,
		);
	}
}

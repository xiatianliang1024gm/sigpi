import type { Terminal } from "./terminal.js";
import {
	normalizeRenderedLine,
	truncateToWidth,
	visibleWidth,
} from "./utils.js";

export interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate?(): void;
	shouldRenderAfterInput?(): boolean;
}

export interface Focusable {
	focused: boolean;
}

export const CURSOR_MARKER = "\x1B_sigpi:c\x07";

export type OverlayAnchor =
	| "center"
	| "top"
	| "bottom"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right";

export interface OverlayOptions {
	width?: number | `${number}%`;
	maxHeight?: number | `${number}%`;
	anchor?: OverlayAnchor;
	nonCapturing?: boolean;
}

export interface OverlayHandle {
	hide(): void;
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
	focus(): void;
	unfocus(target?: Component | null): void;
	isFocused(): boolean;
}

interface OverlayEntry {
	component: Component;
	options: OverlayOptions;
	hidden: boolean;
	previousFocus: Component | null;
}

interface RenderedFrame {
	lines: string[];
	cursor: { row: number; column: number } | null;
}

export interface TuiOptions {
	clearOnStart?: boolean;
	fillHeight?: boolean;
}

export class Tui {
	private readonly terminal: Terminal;
	private readonly children: Component[] = [];
	private readonly overlays: OverlayEntry[] = [];
	private focus: Component | null = null;
	private running = false;
	private previousFrame: string[] = [];
	private renderQueued = false;
	private statusBar: string | null = null;

	constructor(
		terminal: Terminal,
		private readonly options: TuiOptions = {},
	) {
		this.terminal = terminal;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.requestRender();
	}

	removeChild(component: Component): void {
		removeFirst(this.children, component);
		if (this.focus === component) {
			this.focus = null;
		}
		this.requestRender();
	}

	setFocus(component: Component | null): void {
		setFocused(this.focus, false);
		this.focus = component;
		setFocused(this.focus, true);
		this.requestRender();
	}

	showOverlay(
		component: Component,
		options: OverlayOptions = {},
	): OverlayHandle {
		const entry: OverlayEntry = {
			component,
			options,
			hidden: false,
			previousFocus: this.focus,
		};
		this.overlays.push(entry);
		if (!options.nonCapturing) {
			this.setFocus(component);
		}
		this.requestRender();

		return {
			hide: () => {
				removeFirst(this.overlays, entry);
				if (this.focus === component) {
					this.setFocus(entry.previousFocus);
				}
				this.requestRender();
			},
			setHidden: (hidden) => {
				entry.hidden = hidden;
				if (hidden && this.focus === component) {
					this.setFocus(entry.previousFocus);
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				entry.hidden = false;
				this.setFocus(component);
			},
			unfocus: (target) => {
				if (this.focus === component) {
					this.setFocus(target === undefined ? entry.previousFocus : target);
				}
			},
			isFocused: () => this.focus === component,
		};
	}

	hasOverlay(): boolean {
		return this.overlays.some((entry) => !entry.hidden);
	}

	setStatusBar(value: string | null): void {
		this.statusBar = value;
		this.requestRender();
	}

	start(): void {
		if (this.running) {
			return;
		}

		this.running = true;
		this.terminal.start(
			(data) => this.handleInput(data),
			() => {
				this.invalidate();
				this.renderNow();
			},
		);
		if (this.options.clearOnStart !== false) {
			this.terminal.clearScreen();
		}
		this.renderNow();
	}

	stop(): void {
		if (!this.running) {
			return;
		}

		this.running = false;
		this.terminal.stop();
	}

	requestRender(): void {
		if (!this.running || this.renderQueued) {
			return;
		}

		this.renderQueued = true;
		queueMicrotask(() => {
			this.renderQueued = false;
			if (this.running) {
				this.renderNow();
			}
		});
	}

	renderToFrame(): string[] {
		return this.renderFrame().lines;
	}

	forceRender(): void {
		if (!this.running) {
			return;
		}

		this.invalidate();
		this.renderNow();
	}

	resetFrame(): void {
		this.previousFrame = [];
	}

	private renderFrame(): RenderedFrame {
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const footerEnabled = this.statusBar !== null;
		const contentHeight = footerEnabled ? Math.max(0, height - 1) : height;
		const frame = this.children.flatMap((child) => child.render(width));
		const cursor = findCursorPosition(frame.slice(0, contentHeight), width);
		const baseFrame = frame
			.slice(0, contentHeight)
			.map((line) => normalizeLine(line, width));

		if (this.options.fillHeight !== false) {
			while (baseFrame.length < contentHeight) {
				baseFrame.push(" ".repeat(width));
			}
		}

		for (const overlay of this.overlays) {
			if (overlay.hidden) {
				continue;
			}
			composeOverlay(baseFrame, overlay, width, contentHeight);
		}

		if (footerEnabled) {
			baseFrame.push(normalizeStatusBarLine(this.statusBar ?? "", width));
		}

		if (this.options.fillHeight !== false) {
			while (baseFrame.length < height) {
				baseFrame.push(" ".repeat(width));
			}
		}

		return {
			lines: baseFrame.slice(0, height),
			cursor,
		};
	}

	private renderNow(): void {
		const next = this.renderFrame();
		const nextFrame = next.lines;
		writeDiff(this.terminal, this.previousFrame, nextFrame);
		this.previousFrame = nextFrame;
		if (next.cursor) {
			this.terminal.moveTo(next.cursor.row, next.cursor.column);
		}
	}

	private handleInput(data: string): void {
		this.focus?.handleInput?.(data);
		if (this.running && (this.focus?.shouldRenderAfterInput?.() ?? true)) {
			this.renderNow();
		}
	}

	private invalidate(): void {
		for (const component of [
			...this.children,
			...this.overlays.map((entry) => entry.component),
		]) {
			component.invalidate?.();
		}
		this.previousFrame = [];
	}
}

function composeOverlay(
	frame: string[],
	entry: OverlayEntry,
	terminalWidth: number,
	terminalHeight: number,
): void {
	const width =
		resolveSize(entry.options.width, terminalWidth) ??
		Math.min(terminalWidth, 80);
	const maxHeight =
		resolveSize(entry.options.maxHeight, terminalHeight) ?? terminalHeight;
	const overlayLines = entry.component
		.render(width)
		.slice(0, maxHeight)
		.map((line) => normalizeLine(line, width));
	const row = getOverlayRow(
		entry.options.anchor ?? "center",
		terminalHeight,
		overlayLines.length,
	);
	const column = getOverlayColumn(
		entry.options.anchor ?? "center",
		terminalWidth,
		width,
	);

	for (const [index, line] of overlayLines.entries()) {
		const targetRow = row + index;
		if (targetRow < 0 || targetRow >= frame.length) {
			continue;
		}

		const before = frame[targetRow]?.slice(0, column) ?? "";
		const after = frame[targetRow]?.slice(column + width) ?? "";
		frame[targetRow] = normalizeLine(`${before}${line}${after}`, terminalWidth);
	}
}

function writeDiff(
	terminal: Terminal,
	previous: string[],
	next: string[],
): void {
	for (let index = 0; index < next.length; index += 1) {
		if (previous[index] === next[index]) {
			continue;
		}
		terminal.moveTo(index + 1, 1);
		terminal.write(next[index] ?? "");
	}

	if (previous.length > next.length) {
		terminal.moveTo(next.length + 1, 1);
		terminal.clearFromCursor();
	}
}

function normalizeLine(line: string, width: number): string {
	const withoutCursorMarker = line.replaceAll(CURSOR_MARKER, "");
	if (visibleWidth(withoutCursorMarker) > width) {
		return normalizeRenderedLine(withoutCursorMarker, width);
	}
	return normalizeRenderedLine(withoutCursorMarker, width);
}

function normalizeStatusBarLine(line: string, width: number): string {
	return normalizeRenderedLine(truncateLeftToWidth(line, width), width);
}

function truncateLeftToWidth(value: string, width: number): string {
	if (width <= 0 || visibleWidth(value) <= width) {
		return width <= 0 ? "" : value;
	}
	if (width === 1) {
		return truncateToWidth("…", 1);
	}

	const suffix = Array.from(value);
	let result = "";
	let started = false;
	for (let index = suffix.length - 1; index >= 0; index -= 1) {
		const next = `${suffix[index]}${result}`;
		const candidate = started ? `…${next}` : next;
		if (visibleWidth(candidate) > width) {
			started = true;
			continue;
		}
		result = next;
		started = true;
	}
	return visibleWidth(result) === visibleWidth(value) ? result : `…${result}`;
}

function findCursorPosition(
	lines: readonly string[],
	width: number,
): { row: number; column: number } | null {
	for (const [index, line] of lines.entries()) {
		const markerIndex = line.indexOf(CURSOR_MARKER);
		if (markerIndex === -1) {
			continue;
		}

		const column = Math.min(
			Math.max(1, visibleWidth(line.slice(0, markerIndex)) + 1),
			width,
		);
		return {
			row: index + 1,
			column,
		};
	}

	return null;
}

function resolveSize(
	value: OverlayOptions["width"],
	total: number,
): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === "number") {
		return Math.max(1, Math.min(total, value));
	}
	const match = /^(\d+(?:\.\d+)?)%$/.exec(value);
	if (!match) {
		return undefined;
	}
	return Math.max(
		1,
		Math.min(total, Math.floor((total * Number(match[1])) / 100)),
	);
}

function getOverlayRow(
	anchor: OverlayAnchor,
	terminalHeight: number,
	overlayHeight: number,
): number {
	if (anchor.startsWith("top")) {
		return 0;
	}
	if (anchor.startsWith("bottom")) {
		return Math.max(0, terminalHeight - overlayHeight);
	}
	return Math.max(0, Math.floor((terminalHeight - overlayHeight) / 2));
}

function getOverlayColumn(
	anchor: OverlayAnchor,
	terminalWidth: number,
	overlayWidth: number,
): number {
	if (anchor.endsWith("left")) {
		return 0;
	}
	if (anchor.endsWith("right")) {
		return Math.max(0, terminalWidth - overlayWidth);
	}
	return Math.max(0, Math.floor((terminalWidth - overlayWidth) / 2));
}

function setFocused(component: Component | null, focused: boolean): void {
	if (component && "focused" in component) {
		(component as Component & Focusable).focused = focused;
	}
}

function removeFirst<T>(items: T[], item: T): void {
	const index = items.indexOf(item);
	if (index >= 0) {
		items.splice(index, 1);
	}
}

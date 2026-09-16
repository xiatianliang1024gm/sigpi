// The resizable sidebar divider.

import { els } from "./dom.js";

/** Bounds (px) the workspace column may be dragged between. */
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 640;
/** Minimum width (px) always left for the conversation column. */
export const CHAT_MIN_WIDTH = 240;
export const SIDEBAR_WIDTH_KEY = "sigpi.sidebarWidth";
export const DEFAULT_SIDEBAR_WIDTH = 280;

/** The workspace column width, mirrored to the `--sidebar-width` CSS variable. */
export let sidebarWidth = DEFAULT_SIDEBAR_WIDTH;

/** Clamp a candidate width to the allowed range (and the layout's width). */
export function clampSidebarWidth(width) {
	const layoutWidth = els.layout?.clientWidth ?? 0;
	const max =
		layoutWidth > 0
			? Math.max(
					SIDEBAR_MIN_WIDTH,
					Math.min(SIDEBAR_MAX_WIDTH, layoutWidth - CHAT_MIN_WIDTH),
				)
			: SIDEBAR_MAX_WIDTH;
	return Math.round(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), max));
}

/** Set the workspace column width and reflect it in the layout. */
export function setSidebarWidth(width) {
	sidebarWidth = clampSidebarWidth(width);
	document.documentElement.style.setProperty(
		"--sidebar-width",
		`${sidebarWidth}px`,
	);
	return sidebarWidth;
}

/** Remember the width so it survives a reload (best-effort). */
export function persistSidebarWidth(width) {
	try {
		localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
	} catch {
		// Storage can be unavailable (private mode); the width just won't stick.
	}
}

export function restoreSidebarWidth() {
	let stored = Number.NaN;
	try {
		stored = Number.parseFloat(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? "");
	} catch {
		stored = Number.NaN;
	}
	setSidebarWidth(Number.isFinite(stored) ? stored : DEFAULT_SIDEBAR_WIDTH);
}

/** Pointer/keyboard handling for the workspace ⇄ conversation divider. */
export function initSidebarResizer() {
	let dragStartX = 0;
	let dragStartWidth = sidebarWidth;
	const isDragging = () => els.resizer.classList.contains("dragging");

	els.resizer.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		dragStartX = event.clientX;
		dragStartWidth = sidebarWidth;
		els.resizer.classList.add("dragging");
		document.body.classList.add("resizing");
		els.resizer.setPointerCapture?.(event.pointerId);
	});

	els.resizer.addEventListener("pointermove", (event) => {
		if (!isDragging()) return;
		setSidebarWidth(dragStartWidth + (event.clientX - dragStartX));
	});

	const endDrag = (event) => {
		if (!isDragging()) return;
		els.resizer.classList.remove("dragging");
		document.body.classList.remove("resizing");
		els.resizer.releasePointerCapture?.(event.pointerId);
		persistSidebarWidth(sidebarWidth);
	};
	els.resizer.addEventListener("pointerup", endDrag);
	els.resizer.addEventListener("pointercancel", endDrag);

	// Keyboard nudge for accessibility: arrows resize, Shift+arrow is coarser.
	els.resizer.addEventListener("keydown", (event) => {
		const step = event.shiftKey ? 24 : 8;
		let delta = 0;
		if (event.key === "ArrowLeft") delta = -step;
		else if (event.key === "ArrowRight") delta = step;
		else return;
		event.preventDefault();
		persistSidebarWidth(setSidebarWidth(sidebarWidth + delta));
	});
}

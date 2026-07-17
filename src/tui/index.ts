// ── Pi-tui public API (expand phase of the expand-contract migration) ──
// The fork's symbols below stay exactly as they are. Pi-tui's public API is
// re-exported here so consumers can opt into it one piece at a time:
//   - `TUI` is Pi-tui's root class. The fork keeps its own `Tui`, so the two
//     names do not collide and `import { TUI }` resolves to Pi-tui.
//   - every other Pi-tui symbol lives under the `PiTui` namespace, e.g.
//     `PiTui.Container`, `PiTui.Editor`, `PiTui.Markdown`, `PiTui.SelectList`,
//     `PiTui.ProcessTerminal`, `PiTui.Component`, `PiTui.Focusable`,
//     `PiTui.CURSOR_MARKER`. `showOverlay` is the `TUI` / `PiTui.TUI` method,
//     and the text utilities live under the `PiUtils` namespace.

export * as PiTui from "@earendil-works/pi-tui";
export { TUI } from "@earendil-works/pi-tui";
export * as PiUtils from "@earendil-works/pi-tui/dist/utils.js";

// ── Fork TUI API (preserved during the expand-contract migration) ──
export {
	Editor,
	type EditorOptions,
	getCursorColumn,
	renderWrappedEditorLines,
} from "./editor.js";
export {
	FileEditComponent,
	type FileEditRenderOptions,
	formatFileEditResultData,
	formatFileEditSummaries,
	formatFileEditSummary,
} from "./file-edit-renderer.js";
export { isPrintableInput, type KeyId, matchesKey, parseKey } from "./keys.js";
export {
	moveSelectedIndex,
	SelectList,
	type SelectListItem,
} from "./select-list.js";
export {
	composeStatusBar,
	StatusBarComponent,
	type StatusBarModel,
} from "./status-bar.js";
export { ProcessTerminal, SigPiTerminal, type Terminal } from "./terminal.js";
export {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	type OverlayAnchor,
	type OverlayHandle,
	type OverlayOptions,
	ReasoningStreamComponent,
	Tui,
} from "./tui.js";
export {
	normalizeRenderedLine,
	padToWidth,
	stripAnsi,
	truncateToWidth,
	visibleWidth,
	wrapToWidth,
} from "./utils.js";

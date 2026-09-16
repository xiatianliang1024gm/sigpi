// Clipboard and file-download helpers for assistant output.
//
// The browser client ships as plain ES modules with no build step, so these wrap
// the platform APIs directly: the async Clipboard API (with a
// `document.execCommand("copy")` fallback for non-secure contexts) for copying,
// and a Blob plus a synthetic anchor click for saving Markdown to a file.

/** The clipboard-capable `navigator`, resolved lazily so tests can stub it. */
function clipboardApi() {
	const clipboard = globalThis.navigator?.clipboard;
	return clipboard && typeof clipboard.writeText === "function"
		? clipboard
		: null;
}

/**
 * Copy `text` to the system clipboard, resolving `true` on success. Falls back
 * to a hidden textarea + `document.execCommand("copy")` when the async Clipboard
 * API is unavailable (older browsers, or a page served over plain HTTP).
 */
export async function copyText(text) {
	const value = String(text ?? "");
	const clipboard = clipboardApi();
	if (clipboard) {
		try {
			await clipboard.writeText(value);
			return true;
		} catch {
			// Fall through to the legacy path below.
		}
	}
	try {
		const area = document.createElement("textarea");
		area.value = value;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.append(area);
		area.select?.();
		const ok = document.execCommand?.("copy") === true;
		area.remove();
		return ok;
	} catch {
		return false;
	}
}

/**
 * Save `text` to a file the browser downloads as `filename`. Prefers an object
 * URL (revoked afterwards); a `data:` URL is the fallback where object URLs are
 * unavailable.
 */
export function downloadText(text, filename) {
	const value = String(text ?? "");
	const blob = new Blob([value], { type: "text/markdown;charset=utf-8" });
	const canObjectUrl = typeof URL?.createObjectURL === "function";
	const url = canObjectUrl
		? URL.createObjectURL(blob)
		: `data:text/markdown;charset=utf-8,${encodeURIComponent(value)}`;
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.style.display = "none";
	document.body.append(link);
	link.click();
	link.remove();
	if (canObjectUrl) URL.revokeObjectURL(url);
}

/**
 * A button that copies lazily-produced text. `getText` is called on each click,
 * so a streamed message's latest Markdown is always what gets copied. The label
 * briefly flips to confirm (or report failure) without a toast.
 */
export function buildCopyButton({
	className,
	label = "复制",
	title,
	copiedLabel = "已复制",
	getText,
}) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = className;
	button.textContent = label;
	if (title) button.title = title;
	let reset = null;
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void copyText(getText()).then((ok) => {
			button.textContent = ok ? copiedLabel : "复制失败";
			button.classList.toggle("copied", ok);
			clearTimeout(reset);
			reset = setTimeout(() => {
				button.textContent = label;
				button.classList.remove("copied");
			}, 1500);
			// Keep the timer from pinning the process open under the jsdom harness.
			if (reset && typeof reset.unref === "function") reset.unref();
		});
	});
	return button;
}

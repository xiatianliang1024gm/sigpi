import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Options for {@link DirectoryPicker}; the picker supplies defaults. */
export interface DirectoryPickerOptions {
	/** Dialog title / prompt shown to the user. */
	title?: string;
	/** Directory the chooser opens in. */
	defaultPath?: string;
}

/**
 * Opens the host OS's native directory chooser and resolves the absolute path
 * the user picked, or `null` when they dismissed the dialog.
 *
 * The multi-session web server runs on the same host as the browser (it binds
 * loopback by default), so opening the chooser *server-side* is what lets the
 * web client add a project by browsing: the browser's own file pickers never
 * expose a real absolute filesystem path, so the chooser cannot live in the
 * page itself.
 */
export type DirectoryPicker = (
	options?: DirectoryPickerOptions,
) => Promise<string | null>;

/** Raised when the host has no usable native directory chooser. */
export class DirectoryPickerUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DirectoryPickerUnavailableError";
	}
}

const DEFAULT_TITLE = "Select a project folder";

/** The subset of the error `child_process.execFile` rejects with that we read. */
interface ExecFailure {
	code?: number | string;
	stderr?: string;
}

/**
 * Open a native "choose a folder" dialog on the host and resolve the chosen
 * absolute path (or `null` on cancel). Dispatches per platform and throws
 * {@link DirectoryPickerUnavailableError} when no chooser exists.
 */
export function pickDirectory(
	options: DirectoryPickerOptions = {},
): Promise<string | null> {
	switch (process.platform) {
		case "win32":
			return pickOnWindows(options);
		case "darwin":
			return pickOnMac(options);
		default:
			return pickOnLinux(options);
	}
}

/**
 * C# shim that opens the modern (Vista+) folder picker through the `IFileDialog`
 * COM interface with `FOS_PICKFOLDERS`. The legacy `FolderBrowserDialog` — the
 * default on Windows PowerShell 5.1 (.NET Framework) — renders the small
 * tree-based dialog; this drives the same large Explorer-style dialog the OS
 * shows for "Select Folder". `Add-Type` compiles it on the fly.
 */
const WINDOWS_PICKER_SOURCE = `
using System;
using System.Runtime.InteropServices;

public static class SigpiFolderPicker
{
	[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
	private class FileOpenDialog { }

	[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	private interface IFileDialog
	{
		[PreserveSig] int Show(IntPtr parent);
		void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
		void SetFileTypeIndex(uint iFileType);
		void GetFileTypeIndex(out uint piFileType);
		void Advise(IntPtr pfde, out uint pdwCookie);
		void Unadvise(uint dwCookie);
		void SetOptions(uint fos);
		void GetOptions(out uint pfos);
		void SetDefaultFolder(IShellItem psi);
		void SetFolder(IShellItem psi);
		void GetFolder(out IShellItem ppsi);
		void GetCurrentSelection(out IShellItem ppsi);
		void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
		void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
		void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
		void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
		void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
		void GetResult(out IShellItem ppsi);
		void AddPlace(IShellItem psi, int fdap);
		void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
		void Close(int hr);
		void SetClientGuid(ref Guid guid);
		void ClearClientData();
		void SetFilter(IntPtr pFilter);
	}

	[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	private interface IShellItem
	{
		void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
		void GetParent(out IShellItem ppsi);
		void GetDisplayName(uint sigdnName, out IntPtr ppszName);
		void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
		void Compare(IShellItem psi, uint hint, out int piOrder);
	}

	[DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
	private static extern void SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem ppv);

	private const uint FosPickFolders = 0x00000020;
	private const uint FosForceFileSystem = 0x00000040;
	private const uint SigdnFileSystemPath = 0x80058000;
	private const int ErrorCancelled = unchecked((int)0x800704C7);

	public static string Show(string title, string initialPath)
	{
		var dialog = (IFileDialog)new FileOpenDialog();
		uint options;
		dialog.GetOptions(out options);
		dialog.SetOptions(options | FosPickFolders | FosForceFileSystem);
		if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);
		if (!string.IsNullOrEmpty(initialPath))
		{
			try
			{
				IShellItem folder;
				Guid riid = typeof(IShellItem).GUID;
				SHCreateItemFromParsingName(initialPath, IntPtr.Zero, riid, out folder);
				if (folder != null) dialog.SetFolder(folder);
			}
			catch { }
		}
		int hr = dialog.Show(IntPtr.Zero);
		if (hr == ErrorCancelled) return null;
		if (hr != 0) Marshal.ThrowExceptionForHR(hr);
		IShellItem result;
		dialog.GetResult(out result);
		IntPtr namePtr;
		result.GetDisplayName(SigdnFileSystemPath, out namePtr);
		try { return Marshal.PtrToStringUni(namePtr); }
		finally { Marshal.FreeCoTaskMem(namePtr); }
	}
}
`;

async function pickOnWindows(
	options: DirectoryPickerOptions,
): Promise<string | null> {
	const script = [
		// Folder names can contain non-ASCII characters; force UTF-8 on the
		// pipe so PowerShell doesn't transcode the path through the OEM code
		// page and hand Node mojibake.
		"$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
		"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
		"$source = @'",
		WINDOWS_PICKER_SOURCE,
		"'@",
		"Add-Type -TypeDefinition $source -Language CSharp | Out-Null",
		`$picked = [SigpiFolderPicker]::Show(${quotePowerShell(options.title ?? DEFAULT_TITLE)}, ${quotePowerShell(options.defaultPath ?? "")})`,
		"if ($picked) { [Console]::Out.Write($picked) }",
	].join("\n");

	const { stdout } = await execFileAsync(
		"powershell.exe",
		[
			"-NoLogo",
			"-NoProfile",
			// The common file dialog must run on an STA thread. powershell.exe is
			// STA by default, but pin it so host policy can't flip it.
			"-STA",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
		],
		// Hide the spawned console window; the dialog is its own window.
		{ windowsHide: true },
	);
	return toPath(stdout);
}

async function pickOnMac(
	options: DirectoryPickerOptions,
): Promise<string | null> {
	const prompt = quoteAppleScript(options.title ?? DEFAULT_TITLE);
	const location = options.defaultPath
		? ` default location (POSIX file ${quoteAppleScript(options.defaultPath)})`
		: "";
	const script = `POSIX path of (choose folder with prompt ${prompt}${location})`;
	try {
		const { stdout } = await execFileAsync("osascript", ["-e", script]);
		return toPath(stdout);
	} catch (error) {
		// `choose folder` rejects with AppleScript error -128 on cancel.
		if (isUserCancel(error)) {
			return null;
		}
		throw error;
	}
}

async function pickOnLinux(
	options: DirectoryPickerOptions,
): Promise<string | null> {
	const title = options.title ?? DEFAULT_TITLE;
	// Prefer zenity (GNOME/GTK), fall back to kdialog (KDE).
	const viaZenity = await runChooser("zenity", [
		"--file-selection",
		"--directory",
		"--title",
		title,
		...(options.defaultPath ? ["--filename", options.defaultPath] : []),
	]);
	if (viaZenity !== undefined) {
		return viaZenity;
	}

	const viaKdialog = await runChooser("kdialog", [
		"--getexistingdirectory",
		options.defaultPath ?? "",
		"--title",
		title,
	]);
	if (viaKdialog !== undefined) {
		return viaKdialog;
	}

	throw new DirectoryPickerUnavailableError(
		"No directory chooser found on PATH (install zenity or kdialog).",
	);
}

/**
 * Run a Linux chooser and normalize its result: a string when the user picked a
 * directory, `null` when they cancelled (exit code 1), or `undefined` when the
 * tool is missing (`ENOENT`) so the caller can fall back to another chooser.
 */
async function runChooser(
	executable: string,
	args: string[],
): Promise<string | null | undefined> {
	try {
		const { stdout } = await execFileAsync(executable, args);
		return toPath(stdout);
	} catch (error) {
		const failure = error as ExecFailure;
		if (failure.code === "ENOENT") {
			return undefined;
		}
		if (failure.code === 1) {
			return null;
		}
		throw error;
	}
}

/** Trim a chooser's stdout and map the empty string to `null` (cancelled). */
function toPath(raw: string): string | null {
	const trimmed = raw.trim();
	return trimmed.length > 0 ? stripTrailingSeparator(trimmed) : null;
}

/** `choose folder` yields paths with a trailing slash (except the root). */
function stripTrailingSeparator(value: string): string {
	if (value.length > 1 && value.endsWith("/")) {
		return value.replace(/\/+$/u, "") || "/";
	}
	return value;
}

/** Quote a string as a PowerShell single-quoted literal. */
function quotePowerShell(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/** Quote a string as an AppleScript double-quoted literal. */
function quoteAppleScript(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** AppleScript's `choose folder` reports cancel as error -128. */
function isUserCancel(error: unknown): boolean {
	const failure = error as ExecFailure;
	return /user cancel(?:ed|led)|\(-128\)/iu.test(failure.stderr ?? "");
}

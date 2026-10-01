import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cleanEnvironment } from "./lifecycle-environment.mjs";

const execute = promisify(execFile);
const sourceRoot = dirname(fileURLToPath(import.meta.url));
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const bytes = (value) => Buffer.from("\uFEFF" + value.replace(/^\uFEFF/u, ""), "utf8");
const PREFIX = "SHORTCUT_NATIVE_DIAGNOSTIC ";
const STAGES = Object.freeze([
  "DIRECTORY",
  "COM_CREATE",
  "COM_LOAD",
  "VALIDATE",
  "TARGET",
  "ARGUMENTS",
  "WORKING_DIRECTORY",
  "DESCRIPTION",
  "SAVE",
  "COM_RELEASE",
]);
const KINDS = Object.freeze([
  "COM",
  "ACCESS",
  "ARGUMENT",
  "OTHER",
  "IO",
  "IO_PATH_TOO_LONG",
  "IO_DIRECTORY_NOT_FOUND",
  "IO_FILE_NOT_FOUND",
  "IO_ACCESS",
  "IO_SHARING",
  "IO_LOCK",
  "IO_EXISTS",
  "IO_INVALID_ARGUMENT",
  "IO_DISK_FULL",
  "IO_INVALID_NAME",
  "IO_NOT_DIRECTORY",
  "IO_OTHER",
]);
const TYPES = Object.freeze([
  "System.Exception",
  "System.Runtime.InteropServices.COMException",
  "System.UnauthorizedAccessException",
  "System.IO.IOException",
  "System.IO.PathTooLongException",
  "System.IO.DirectoryNotFoundException",
  "System.IO.FileNotFoundException",
  "System.ArgumentException",
  "System.ArgumentNullException",
  "System.ArgumentOutOfRangeException",
  "System.InvalidOperationException",
  "System.Security.SecurityException",
  "System.ComponentModel.Win32Exception",
  "System.Management.Automation.RuntimeException",
]);
const codesFor = (stage) =>
  KINDS.map((kind) => "WINDOWS_RUNTIME_ENTRY_SHORTCUT_" + stage + "_" + kind + "_FAILED");
const SAVE_CODES = new Set(codesFor("SAVE"));
const CODES = new Set([
  ...STAGES.flatMap(codesFor),
  "WINDOWS_RUNTIME_ENTRY_SHORTCUT_CONFLICT",
  "WINDOWS_RUNTIME_ENTRY_INTEGRITY_FAILED",
  "WINDOWS_RUNTIME_ENTRY_DIAGNOSTIC_FAILED",
]);
const UNAVAILABLE = Object.freeze({
  diagnostic_result: "unavailable",
  code: "WINDOWS_RUNTIME_ENTRY_DIAGNOSTIC_FAILED",
});

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function readRecord(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 4096) throw new Error();
  const text = output.replace(/^\uFEFF/u, "").trim();
  const value = JSON.parse(text);
  // Native output is compact ASCII JSON; reject duplicate keys and alternate encodings.
  if (JSON.stringify(value) !== text) throw new Error();
  return value;
}

function safeReport(value) {
  const diagnosticResult = value?.diagnostic_result;
  if (exactKeys(value, ["diagnostic_result"]) && diagnosticResult === "succeeded")
    return Object.freeze({ diagnostic_result: "succeeded" });
  const code = value?.code;
  if (
    exactKeys(value, ["diagnostic_result", "code"]) &&
    diagnosticResult === "unavailable" &&
    code === UNAVAILABLE.code
  )
    return UNAVAILABLE;
  const hasNative = Object.hasOwn(value ?? {}, "native");
  if (
    !exactKeys(value, ["diagnostic_result", "code", ...(hasNative ? ["native"] : [])]) ||
    diagnosticResult !== "failed" ||
    !CODES.has(code)
  )
    throw new Error();
  if (!hasNative) return Object.freeze({ diagnostic_result: "failed", code });
  const native = value.native;
  const exceptionType = native?.exception_type;
  const hresult = native?.hresult;
  const stage = native?.stage;
  if (
    !exactKeys(native, ["exception_type", "hresult", "stage"]) ||
    !TYPES.includes(exceptionType) ||
    !STAGES.includes(stage) ||
    !Number.isInteger(hresult) ||
    hresult < -2147483648 ||
    hresult > 2147483647 ||
    (code.startsWith("WINDOWS_RUNTIME_ENTRY_SHORTCUT_") &&
      code !== "WINDOWS_RUNTIME_ENTRY_SHORTCUT_CONFLICT" &&
      !codesFor(stage).includes(code))
  )
    throw new Error();
  return Object.freeze({
    diagnostic_result: "failed",
    code,
    native: Object.freeze({
      exception_type: exceptionType,
      hresult,
      stage,
    }),
  });
}

export function parseShortcutSaveDiagnosticOutput(stdout, stderr) {
  try {
    const report = readRecord(stdout);
    if (
      !exactKeys(
        report,
        report?.diagnostic_result === "succeeded"
          ? ["diagnostic_result"]
          : ["diagnostic_result", "code"],
      )
    )
      throw new Error();
    const safe = safeReport(report);
    if (typeof stderr !== "string" || Buffer.byteLength(stderr, "utf8") > 4096) throw new Error();
    const diagnostic = stderr.trim();
    if (!diagnostic) return safe;
    if (safe.diagnostic_result !== "failed" || !diagnostic.startsWith(PREFIX)) throw new Error();
    return safeReport({ ...safe, native: readRecord(diagnostic.slice(PREFIX.length)) });
  } catch {
    return UNAVAILABLE;
  }
}

export async function captureShortcutSaveDiagnostic(run) {
  try {
    const { stdout, stderr } = await run();
    return parseShortcutSaveDiagnosticOutput(stdout, stderr);
  } catch {
    return UNAVAILABLE;
  }
}

export function shortcutSaveFailureCode(stderr) {
  if (typeof stderr !== "string") return null;
  const code = stderr.trim();
  return SAVE_CODES.has(code) ? code : null;
}

export async function shortcutInstallationFailure(code, diagnose) {
  if (!SAVE_CODES.has(code)) return new Error(UNAVAILABLE.code);
  let report = UNAVAILABLE;
  try {
    report = safeReport(await diagnose());
  } catch {
    /* Keep the original product failure. */
  }
  return new Error(code + " SHORTCUT_INSTALL_DIAGNOSTIC " + JSON.stringify(report));
}

export async function shortcutSaveDiagnostic(fixture, environment, options = {}) {
  return captureShortcutSaveDiagnostic(async () => {
    const { directory: requestedDirectory } = options;
    const root = join(fixture.root, "shortcut-save-diagnostic");
    await mkdir(root);
    const helper = join(root, "installer.ps1"),
      runner = join(root, "diagnostic.ps1");
    const marker = "$exception = $_.Exception.GetBaseException()";
    const source = await readFile(join(sourceRoot, "runtime-entry-install.ps1"), "utf8");
    if (source.split(marker).length !== 2) throw new Error("SHORTCUT_DIAGNOSTIC_SOURCE_INVALID");
    // Test-only instrumentation retains every check and records no exception message or path.
    await writeFile(
      helper,
      bytes(
        source.replace(
          marker,
          marker +
            `
    [Console]::Error.WriteLine('SHORTCUT_NATIVE_DIAGNOSTIC ' + (@{
      exception_type = $exception.GetType().FullName; hresult = [int]$exception.HResult; stage = $stage
    } | ConvertTo-Json -Compress))`,
        ),
      ),
      { flag: "wx" },
    );
    const directory = requestedDirectory ?? join(root, "Menu");
    if (directory === join(root, "Menu")) await mkdir(directory);
    const release = join(
      environment.LOCALAPPDATA,
      "Programs/Laundry Desk Runtime V2",
      fixture.manifestSha,
    );
    const heldPaths = [
      fixture.output,
      join(fixture.output, "payload"),
      ...new Set(
        fixture.manifest.files.map(({ path }) => dirname(join(fixture.output, "payload", path))),
      ),
    ];
    await writeFile(
      runner,
      bytes(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
Set-StrictMode -Version Latest
try {
  . ${quote(join(sourceRoot, "runtime-entry-trust.ps1"))}
  . ${quote(join(sourceRoot, "runtime-entry-shortcut.ps1"))}
  . ${quote(helper)}
  $BoundManifest = ${quote(fixture.manifestSha)}
  foreach ($path in @(${heldPaths.map(quote).join(",")})) {
    [void][LaundryRuntimeEntryTrust]::HoldDirectoryPath($path)
  }
  Set-RuntimeEntryShortcut ${quote(directory)} ${quote(release)}
  [Console]::Out.WriteLine('{"diagnostic_result":"succeeded"}')
} catch {
  $code = [string]($_.Exception.GetBaseException().Message)
  if ($code -cnotmatch '^WINDOWS_RUNTIME_ENTRY_[A-Z_]+$') { $code='WINDOWS_RUNTIME_ENTRY_DIAGNOSTIC_FAILED' }
  [Console]::Out.WriteLine((@{ diagnostic_result='failed'; code=$code } | ConvertTo-Json -Compress))
} finally {
  if ('LaundryRuntimeEntryTrust' -as [type]) { [LaundryRuntimeEntryTrust]::ReleaseDirectories() }
}
`),
      { flag: "wx" },
    );
    return execute(
      join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner],
      {
        env: { ...cleanEnvironment(), ...environment },
        windowsHide: true,
        maxBuffer: 65536,
        timeout: 40000,
      },
    );
  });
}

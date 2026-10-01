import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cleanEnvironment } from "./lifecycle-environment.mjs";
import {
  parseShortcutSaveDiagnosticOutput,
  shortcutInstallationFailure,
} from "./runtime-entry-save-diagnostic-fixture.mjs";

const execute = promisify(execFile);
const sourceRoot = dirname(fileURLToPath(import.meta.url));
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const bytes = (value) => Buffer.from("\uFEFF" + value.replace(/^\uFEFF/u, ""), "utf8");
const CASES = Object.freeze([
  "unicode_clean",
  "ascii_clean",
  "unicode_os_context",
  "ascii_os_context",
]);
const FACTS = Object.freeze([
  "full_name_equal",
  "full_name_ignore_case_equal",
  "parent_exists",
  "requested_parent_exists",
  "target_exists",
  "working_directory_exists",
  "saved_file_exists",
]);
const UNAVAILABLE = Object.freeze({ matrix_result: "unavailable" });
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

export function parseShortcutNameMatrixOutput(output) {
  try {
    if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 16384) throw new Error();
    const text = output.trim(),
      value = JSON.parse(text);
    if (
      JSON.stringify(value) !== text ||
      !exactKeys(value, ["cases", "os_context_complete"]) ||
      typeof value.os_context_complete !== "boolean" ||
      !Array.isArray(value.cases) ||
      value.cases.length !== CASES.length
    )
      throw new Error();
    const cases = value.cases.map((entry, index) => {
      if (
        !exactKeys(entry, ["case_id", "facts", "result", "native"]) ||
        entry.case_id !== CASES[index] ||
        !exactKeys(entry.facts, FACTS) ||
        FACTS.some((key) => typeof entry.facts[key] !== "boolean")
      )
        throw new Error();
      const report = parseShortcutSaveDiagnosticOutput(
        JSON.stringify(entry.result),
        entry.native === null ? "" : "SHORTCUT_NATIVE_DIAGNOSTIC " + JSON.stringify(entry.native),
      );
      if (report.diagnostic_result === "unavailable") throw new Error();
      return Object.freeze({
        case_id: CASES[index],
        facts: Object.freeze(Object.fromEntries(FACTS.map((key) => [key, entry.facts[key]]))),
        report,
      });
    });
    return Object.freeze({
      matrix_result: "complete",
      os_context_complete: value.os_context_complete,
      cases: Object.freeze(cases),
    });
  } catch {
    return UNAVAILABLE;
  }
}

export async function shortcutNameMatrix(fixture, environment) {
  try {
    const root = join(fixture.root, "shortcut-name-matrix");
    await mkdir(root);
    await Promise.all(["C", "S"].map((name) => mkdir(join(root, name))));
    const nameMarker = "Laundry Runtime V2 安装与维护 (",
      exceptionMarker = "$exception = $_.Exception.GetBaseException()",
      saveMarker = "$shortcut.Save()";
    let source = await readFile(join(sourceRoot, "runtime-entry-install.ps1"), "utf8");
    for (const marker of [nameMarker, exceptionMarker, saveMarker])
      if (source.split(marker).length !== 2) throw new Error();
    source = source
      .replace(
        exceptionMarker,
        exceptionMarker +
          `
    $script:MatrixNative = [ordered]@{ exception_type=$exception.GetType().FullName; hresult=[int]$exception.HResult; stage=$stage }
    if($null -ne $script:MatrixFacts){$script:MatrixFacts.saved_file_exists=[IO.File]::Exists($path)}`,
      )
      .replace(
        saveMarker,
        `$script:MatrixFacts = [ordered]@{
      full_name_equal=($shortcut.FullName -ceq $path)
      full_name_ignore_case_equal=([string]::Equals($shortcut.FullName,$path,[StringComparison]::OrdinalIgnoreCase))
      parent_exists=[IO.Directory]::Exists([IO.Path]::GetDirectoryName($shortcut.FullName))
      requested_parent_exists=[IO.Directory]::Exists($Directory)
      target_exists=[IO.File]::Exists($shortcut.TargetPath)
      working_directory_exists=[IO.Directory]::Exists($shortcut.WorkingDirectory)
      saved_file_exists=$false
    }
    ${saveMarker}
    $script:MatrixFacts.saved_file_exists=[IO.File]::Exists($path)`,
      );
    const unicode = join(root, "unicode.ps1"),
      ascii = join(root, "ascii.ps1"),
      runner = join(root, "matrix.ps1");
    await writeFile(unicode, bytes(source), { flag: "wx" });
    // "Setup" has the same UTF-16 length as the five Chinese characters.
    await writeFile(ascii, bytes(source.replace(nameMarker, "Laundry Runtime V2 Setup (")), {
      flag: "wx",
    });
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
    const keys = ["SystemDrive", "ProgramData", "ALLUSERSPROFILE", "ComSpec"];
    const osValues = keys.map((key) => {
      const value = process.env[key];
      return typeof value === "string" &&
        (key === "SystemDrive" ? /^[A-Za-z]:$/u : /^[A-Za-z]:\\[^\r\n\0]*$/u).test(value)
        ? value
        : null;
    });
    const restores = keys
      .map((key, index) =>
        osValues[index] === null
          ? ""
          : `[Environment]::SetEnvironmentVariable(${quote(key)},${quote(osValues[index])},'Process')`,
      )
      .join("\n");
    await writeFile(
      runner,
      bytes(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
Set-StrictMode -Version Latest
. ${quote(join(sourceRoot, "runtime-entry-trust.ps1"))}
. ${quote(join(sourceRoot, "runtime-entry-shortcut.ps1"))}
$BoundManifest=${quote(fixture.manifestSha)}
$cases=New-Object 'Collections.Generic.List[object]'
try {
  foreach ($path in @(${heldPaths.map(quote).join(",")})) { [void][LaundryRuntimeEntryTrust]::HoldDirectoryPath($path) }
  foreach ($context in @('clean','os_context')) {
    if ($context -ceq 'os_context') { ${restores} }
    foreach ($name in @('unicode','ascii')) {
      if ($name -ceq 'unicode') { . ${quote(unicode)} } else { . ${quote(ascii)} }
      $script:MatrixNative=$null; $script:MatrixFacts=$null
      try {
        $menu=if($context -ceq 'clean'){${quote(join(root, "C"))}}else{${quote(join(root, "S"))}}
        Set-RuntimeEntryShortcut $menu ${quote(release)}
        $result=[ordered]@{diagnostic_result='succeeded'}
      } catch {
        $code=[string]($_.Exception.GetBaseException().Message)
        if($code -cnotmatch '^WINDOWS_RUNTIME_ENTRY_[A-Z_]+$'){$code='WINDOWS_RUNTIME_ENTRY_DIAGNOSTIC_FAILED'}
        $result=[ordered]@{diagnostic_result='failed';code=$code}
      }
      $cases.Add([ordered]@{case_id=($name+'_'+$context);facts=$script:MatrixFacts;result=$result;native=$script:MatrixNative})
    }
  }
  [Console]::Out.WriteLine(([ordered]@{cases=$cases.ToArray();os_context_complete=$${osValues.every((value) => value !== null)}}|ConvertTo-Json -Compress -Depth 8))
} finally { [LaundryRuntimeEntryTrust]::ReleaseDirectories() }
`),
      { flag: "wx" },
    );
    const { stdout, stderr } = await execute(
      join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner],
      {
        env: { ...cleanEnvironment(), ...environment },
        windowsHide: true,
        maxBuffer: 65536,
        timeout: 40000,
      },
    );
    return stderr.trim() ? UNAVAILABLE : parseShortcutNameMatrixOutput(stdout);
  } catch {
    return UNAVAILABLE;
  }
}

export async function shortcutInstallationWithNameMatrix(code, diagnose, fixture, environment) {
  const failure = await shortcutInstallationFailure(code, diagnose);
  const matrix = await shortcutNameMatrix(fixture, environment);
  return new Error(failure.message + " SHORTCUT_NAME_MATRIX " + JSON.stringify(matrix));
}

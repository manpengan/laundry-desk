import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join } from "node:path";
const execFileAsync = promisify(execFile);
const SIGNATURE_STAGES = ["PROCESS_STARTED", "MODULE_READY", "QUERY_STARTED", "QUERY_COMPLETED"];

export async function defaultSignatureStatus(
  path,
  {
    run = execFileAsync,
    systemRoot = process.env.SystemRoot ?? process.env.WINDIR,
    artifactKind = "artifact",
    reportProgress = () => {},
  } = {},
) {
  if (typeof systemRoot !== "string" || !isAbsolute(systemRoot)) {
    throw new Error("Windows system root is unavailable");
  }
  if (!["app", "installer", "artifact"].includes(artifactKind)) throw new Error("Invalid artifact");
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const started = performance.now();
  const report = (stage) =>
    reportProgress({
      artifact_kind: artifactKind,
      stage,
      elapsed_ms: Math.round(performance.now() - started),
    });
  const reportLastStage = (stdout = "") => {
    const lines = stdout.split(/\r?\n/u);
    report(SIGNATURE_STAGES.findLast((stage) => lines.includes(stage)) ?? "PROCESS_START");
  };
  report("PROCESS_START");
  let result;
  try {
    const request = run(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$ErrorActionPreference = 'Stop'",
          "$ProgressPreference = 'SilentlyContinue'",
          "[Console]::Out.WriteLine('PROCESS_STARTED')",
          "$PSModuleAutoLoadingPreference = 'None'",
          "Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop",
          "[Console]::Out.WriteLine('MODULE_READY')",
          "[Console]::Out.WriteLine('QUERY_STARTED')",
          "$status = (Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $env:LAUNDRY_INSPECT_PATH -ErrorAction Stop).Status.ToString()",
          "[Console]::Out.WriteLine('QUERY_COMPLETED')",
          "[Console]::Out.WriteLine($status)",
          "exit 0",
        ].join("; "),
      ],
      {
        encoding: "utf8",
        env: {
          LAUNDRY_INSPECT_PATH: path,
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
        },
        maxBuffer: 8_192,
        timeout: 60_000,
        windowsHide: true,
      },
    );
    request.child?.stdin?.end();
    result = await request;
  } catch (error) {
    reportLastStage(typeof error?.stdout === "string" ? error.stdout : "");
    const timedOut = error?.killed === true && error.code === null && error.signal === "SIGTERM";
    throw new Error(
      timedOut ? "WINDOWS_PACKAGE_SIGNATURE_TIMEOUT" : "WINDOWS_PACKAGE_SIGNATURE_QUERY_FAILED",
    );
  }
  reportLastStage(result.stdout);
  const lines = result.stdout.trimEnd().split(/\r?\n/u);
  if (
    result.stderr !== "" ||
    lines.length !== 5 ||
    !SIGNATURE_STAGES.every((stage, index) => lines[index] === stage) ||
    !/^[A-Za-z]+$/u.test(lines[4])
  ) {
    throw new Error("WINDOWS_PACKAGE_SIGNATURE_OUTPUT_INVALID");
  }
  report("PROCESS_EXIT");
  return lines[4];
}

/**
 * Redirected PowerShell writes progress records to stderr as CLIXML, and any stderr fails the
 * maintenance call. The trust script's first Add-Type loads a module and reports progress while
 * doing so (on a Windows 10 counter, on every call), so progress is off before it runs.
 */
const PRELUDE = "$ProgressPreference = 'SilentlyContinue'\n";

/**
 * The binding pins the installed entry. All handoff data is bounded stdin JSON, never shell source.
 * The Runtime installer roots its install at %LOCALAPPDATA% (ADR-69), so the lookup reads the same
 * variable with the same check; the known-folder API ignores a redirected LOCALAPPDATA.
 */
export const MAINTENANCE_BOOTSTRAP = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$held = $null
# Node puts the Counter's children in a kill-on-close job, so a window shown by this process would close when the
# operator quits the Counter, which maintenance asks them to do. Grandchildren leave that job, so the window runs in
# its own process: fixed code on its command line, entry path and handoff over stdin (base64 UTF-8). This process
# keeps the verified entry held until the window reports it has opened, by which time the entry holds itself.
$launcher = '$ProgressPreference = ''SilentlyContinue''; $r = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())) | ConvertFrom-Json; & $r.entry -Action gui -CounterHandoffJson ($r.handoff | ConvertTo-Json -Compress)'
try {
  $q = [LaundryCounterMaintenanceTrust]::ReadProtocolInput() | ConvertFrom-Json
  $local = $env:LOCALAPPDATA
  if ([string]::IsNullOrWhiteSpace($local) -or $local -cnotmatch '^[A-Za-z]:\\' -or -not [IO.Path]::IsPathRooted($local)) { throw 'path' }
  $root = [IO.Path]::Combine($local,'Programs','Laundry Desk Runtime V2',$q.manifest_sha256)
  [void][LaundryCounterMaintenanceTrust]::HoldDirectoryPath($root)
  [LaundryCounterMaintenanceTrust]::AssertPrivateDirectory($root)
  $entry = [IO.Path]::Combine($root,'runtime-entry.ps1')
  $held = [LaundryCounterMaintenanceTrust]::OpenVerified($entry,$q.entry_size,$q.entry_sha256)
  if ($q.input.operation -ceq 'health') { & $entry -Action backup-health }
  else {
    $psi = New-Object Diagnostics.ProcessStartInfo ([IO.Path]::Combine($env:SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'))
    $psi.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launcher))
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.WorkingDirectory = [IO.Path]::Combine($env:SystemRoot,'System32')
    $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $window = [Diagnostics.Process]::Start($psi)
    $handoff = @{ entry = $entry; handoff = $q.input } | ConvertTo-Json -Compress -Depth 3
    $window.StandardInput.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($handoff)))
    $window.StandardInput.Close()
    $opened = $window.StandardOutput.ReadLineAsync()
    if (-not $opened.Wait(25000) -or $opened.Result -cne '{"status":"maintenance_opened"}') {
      if (-not $window.HasExited) { $window.Kill() }
      throw 'window'
    }
    [Console]::Out.WriteLine($opened.Result); [Console]::Out.Flush()
  }
} catch { [Console]::Error.WriteLine('WINDOWS_RUNTIME_ENTRY_FAILED'); exit 1 }
finally {
  if ($null -ne $held) { $held.Dispose() }
  [LaundryCounterMaintenanceTrust]::ReleaseDirectories()
}
`;

/** The whole -EncodedCommand source: prelude, the pinned trust script, then the bootstrap. */
export function maintenanceCommand(trustScript: string): string {
  return PRELUDE + trustScript + "\n" + MAINTENANCE_BOOTSTRAP;
}

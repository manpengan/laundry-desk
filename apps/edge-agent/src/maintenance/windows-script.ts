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
 *
 * Node puts the Counter's children in a kill-on-close job, so a window shown by the bootstrap process would
 * close when the operator quits the Counter, which maintenance asks them to do. Grandchildren leave that job,
 * so the window runs in a process the bootstrap starts: fixed code on its command line, entry path and handoff
 * over stdin as base64 UTF-8 (the handoff may carry an approval request id). The bootstrap keeps the verified
 * entry held until the window reports it has opened, by which time the entry holds itself. Comments stay out of
 * the script: the whole encoded command must fit the Windows command-line limit.
 */
export const MAINTENANCE_BOOTSTRAP = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$held = $null
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
  $w=New-Object Diagnostics.ProcessStartInfo ($PSHOME+'\powershell.exe')
  $w.Arguments='-NoProfile -NonInteractive -ep Bypass -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('$r=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))|ConvertFrom-Json;& $r.e -Action gui -CounterHandoffJson ($r.h|ConvertTo-Json -Compress)'))
  $w.UseShellExecute=$false;$w.CreateNoWindow=$w.RedirectStandardInput=$w.RedirectStandardOutput=$w.RedirectStandardError=$true
  $p=[Diagnostics.Process]::Start($w)
  $p.StandardInput.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{e=$entry;h=$q.input}|ConvertTo-Json -Compress))))
  $o=$p.StandardOutput.ReadLineAsync()
  if(-not $o.Wait(25000) -or $o.Result -cne '{"status":"maintenance_opened"}'){$p.Kill();throw 'window'}
  [Console]::Out.WriteLine($o.Result)
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

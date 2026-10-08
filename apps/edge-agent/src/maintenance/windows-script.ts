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
  else { & $entry -Action gui -CounterHandoffJson ($q.input | ConvertTo-Json -Compress) }
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

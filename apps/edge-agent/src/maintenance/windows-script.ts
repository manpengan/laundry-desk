/** The binding pins the installed entry. All handoff data is bounded stdin JSON, never shell source. */
export const MAINTENANCE_BOOTSTRAP = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
$held = $null
try {
  $q = [LaundryCounterMaintenanceTrust]::ReadProtocolInput() | ConvertFrom-Json
  $local = [Environment]::GetFolderPath('LocalApplicationData')
  if ([string]::IsNullOrWhiteSpace($local) -or -not [IO.Path]::IsPathRooted($local)) { throw 'path' }
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

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('install','repair','start','stop','upgrade','rollback','uninstall','status','backup','backup-list','backup-verify','restore','maintenance-recover')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Payload,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestDigest,
  [ValidatePattern('^b_[a-f0-9]{32}$')][string]$BackupId,
  [ValidatePattern('^[a-f0-9]{64}$')][string]$ConfirmationDigest
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# This runs before Node can interpret NODE_OPTIONS/NODE_PATH or preload code.
$ProcessExecutionPolicy = [Environment]::GetEnvironmentVariable('PSExecutionPolicyPreference', 'Process')
$Allowed = @('SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','USERNAME','USERDOMAIN')
foreach ($key in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
  if ($Allowed -notcontains $key) { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }
}
# Preserve the policy already selected by this PowerShell host without changing registry scopes.
if (@('AllSigned','Bypass','Default','RemoteSigned','Restricted','Undefined','Unrestricted') -contains $ProcessExecutionPolicy) {
  [Environment]::SetEnvironmentVariable('PSExecutionPolicyPreference', $ProcessExecutionPolicy, 'Process')
}
$env:PATH = [IO.Path]::Combine($env:SystemRoot, 'System32')
$env:PSModulePath = [IO.Path]::Combine($env:SystemRoot, 'System32\WindowsPowerShell\v1.0\Modules')

function Get-BoundHash {
  param([string]$Path, [long]$Maximum)
  $item = New-Object IO.FileInfo($Path)
  if (-not $item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt $Maximum) {
    throw 'WINDOWS_COMPANION_LAUNCH_FILE_INVALID'
  }
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}

try {
  if (($Action -eq 'restore' -and ([string]::IsNullOrEmpty($BackupId) -or [string]::IsNullOrEmpty($ConfirmationDigest))) -or
      ($Action -eq 'backup-verify' -and ([string]::IsNullOrEmpty($BackupId) -or -not [string]::IsNullOrEmpty($ConfirmationDigest))) -or
      ($Action -ne 'restore' -and $Action -ne 'backup-verify' -and
       (-not [string]::IsNullOrEmpty($BackupId) -or -not [string]::IsNullOrEmpty($ConfirmationDigest)))) {
    throw 'WINDOWS_COMPANION_ARGS_INVALID'
  }
  $Payload = [IO.Path]::GetFullPath($Payload)
  $Manifest = Join-Path $Payload 'runtime-payload.json'
  if ((Get-BoundHash $Manifest 8388608) -cne $ManifestDigest) { throw 'WINDOWS_COMPANION_MANIFEST_DIGEST_INVALID' }
  $value = [IO.File]::ReadAllText($Manifest) | ConvertFrom-Json
  $bootstrap = @($value.files | Where-Object { $_.path -eq 'node/node.exe' -or $_.path.StartsWith('scripts/') })
  if (@($bootstrap | Where-Object { $_.path -eq 'node/node.exe' }).Count -ne 1 -or
      @($bootstrap | Where-Object { $_.path -eq 'scripts/lifecycle-cli.mjs' }).Count -ne 1 -or
      @($bootstrap | Where-Object { $_.path -eq 'scripts/lifecycle-native.ps1' }).Count -ne 1) {
    throw 'WINDOWS_COMPANION_LAUNCH_FILE_INVALID'
  }
  foreach ($entry in $bootstrap) {
    if ($entry.path -notmatch '^(node/node\.exe|scripts/[a-z-]+\.(mjs|ps1))$' -or
        $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or
        (Get-BoundHash (Join-Path $Payload $entry.path) 536870912) -cne $entry.sha256) {
      throw 'WINDOWS_COMPANION_LAUNCH_INTEGRITY_FAILED'
    }
  }
  $Node = Join-Path $Payload 'node\node.exe'
  $Entry = Join-Path $Payload 'scripts\lifecycle-cli.mjs'
  . (Join-Path $PSScriptRoot 'lifecycle-native.ps1')
  $ChildArguments = @($Entry, $Action, $Payload, $ManifestDigest)
  if ($Action -eq 'restore' -or $Action -eq 'backup-verify') { $ChildArguments += $BackupId }
  if ($Action -eq 'restore') { $ChildArguments += $ConfirmationDigest }
  $rendered = @($ChildArguments | ForEach-Object {
    if ($_ -match '["\r\n\x00]') { throw 'WINDOWS_COMPANION_LAUNCH_ARGUMENT_INVALID' }
    '"' + [regex]::Replace($_, '(\\+)$', '$1$1') + '"'
  })
  exit ([LaundryRuntimeNativeLauncher]::Run($Node, ($rendered -join ' '), $Payload))
} catch {
  $code = [string]($_.Exception.GetBaseException().Message)
  if ($code -notmatch '^WINDOWS_COMPANION_[A-Z_]+$') { $code = 'WINDOWS_COMPANION_LAUNCH_FAILED' }
  [Console]::Error.WriteLine($code)
  exit 1
}

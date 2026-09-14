[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('install','repair','start','stop','upgrade','rollback','uninstall','status')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Payload,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestDigest
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# This runs before Node can interpret NODE_OPTIONS/NODE_PATH or preload code.
$Allowed = @('SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','USERNAME','USERDOMAIN')
foreach ($key in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
  if ($Allowed -notcontains $key) { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }
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
  $Payload = [IO.Path]::GetFullPath($Payload)
  $Manifest = Join-Path $Payload 'runtime-payload.json'
  if ((Get-BoundHash $Manifest 8388608) -cne $ManifestDigest) { throw 'WINDOWS_COMPANION_MANIFEST_DIGEST_INVALID' }
  $value = [IO.File]::ReadAllText($Manifest) | ConvertFrom-Json
  $bootstrap = @($value.files | Where-Object { $_.path -eq 'node/node.exe' -or $_.path.StartsWith('scripts/') })
  if (@($bootstrap | Where-Object { $_.path -eq 'node/node.exe' }).Count -ne 1 -or
      @($bootstrap | Where-Object { $_.path -eq 'scripts/lifecycle-cli.mjs' }).Count -ne 1) {
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
  & $Node $Entry $Action $Payload $ManifestDigest
  exit $LASTEXITCODE
} catch {
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^WINDOWS_COMPANION_[A-Z_]+$') { $code = 'WINDOWS_COMPANION_LAUNCH_FAILED' }
  [Console]::Error.WriteLine($code)
  exit 1
}

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Archive,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string] $Sha256,
  [Parameter(Mandatory = $true)][string] $Destination,
  [Parameter(Mandatory = $true)][ValidateSet('node', 'postgres')][string] $Kind
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem
$item = Get-Item -LiteralPath $Archive
if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) {
  throw 'WINDOWS_COMPANION_ARCHIVE_DIGEST_INVALID'
}
if (Test-Path -LiteralPath $Destination) { throw 'WINDOWS_COMPANION_DESTINATION_EXISTS' }
$Destination = [IO.Path]::GetFullPath($Destination)
$zip = [IO.Compression.ZipFile]::OpenRead($item.FullName)
try {
  if ($zip.Entries.Count -gt 40000) { throw 'WINDOWS_COMPANION_ARCHIVE_TOO_LARGE' }
  $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $selected = @()
  [long] $total = 0
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName
    if ($name.Contains('\') -or $name.StartsWith('/')) { throw 'WINDOWS_COMPANION_ARCHIVE_PATH_INVALID' }
    $trimmed = $name.TrimEnd('/')
    if ($trimmed.Length -gt 240 -or -not $names.Add($trimmed)) { throw 'WINDOWS_COMPANION_ARCHIVE_PATH_INVALID' }
    foreach ($part in $trimmed.Split('/')) {
      if ($part -notmatch '^[A-Za-z0-9@_.+ ()-]+$' -or $part -in @('.', '..') -or
          $part -match '[. ]$' -or $part -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)') {
        throw 'WINDOWS_COMPANION_ARCHIVE_PATH_INVALID'
      }
    }
    $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
    if ($unixType -notin @(0, 0x8000, 0x4000)) { throw 'WINDOWS_COMPANION_ARCHIVE_LINK_INVALID' }
    $total += $entry.Length
    if ($total -gt 2147483648 -or $entry.Length -gt 536870912) { throw 'WINDOWS_COMPANION_ARCHIVE_TOO_LARGE' }
    $relative = $null
    if ($Kind -eq 'node' -and $name -match '^node-v22\.23\.2-win-x64/(node\.exe|LICENSE)$') {
      $relative = $Matches[1]
    }
    if ($Kind -eq 'postgres' -and $name -match '^pgsql/((bin|lib|share)/.+|server_license\.txt|commandlinetools_3rd_party_licenses\.txt)$') {
      $relative = $Matches[1]
    }
    if ($null -ne $relative -and -not $name.EndsWith('/')) {
      $selected += [pscustomobject]@{ Entry = $entry; Relative = $relative }
    }
  }
  if ($selected.Count -eq 0) { throw 'WINDOWS_COMPANION_ARCHIVE_LAYOUT_INVALID' }
  [void][IO.Directory]::CreateDirectory($Destination)
  foreach ($selection in $selected) {
    $target = [IO.Path]::GetFullPath((Join-Path $Destination $selection.Relative))
    if (-not $target.StartsWith($Destination + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw 'WINDOWS_COMPANION_ARCHIVE_PATH_INVALID'
    }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
    $inputStream = $selection.Entry.Open()
    try {
      $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
      try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
    } finally { $inputStream.Dispose() }
  }
} finally { $zip.Dispose() }
if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) {
  throw 'WINDOWS_COMPANION_ARCHIVE_CHANGED'
}

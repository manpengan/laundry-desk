/** Fixed script: all paths arrive as bounded JSON over stdin, never as executable source. */
export const WINDOWS_UPDATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $trusted = @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $system = @('C:\Windows','C:\Windows\System32','C:\Windows\System32\WindowsPowerShell','C:\Windows\System32\WindowsPowerShell\v1.0','C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')
  foreach ($p in $system) {
    $item = if ([IO.Directory]::Exists($p)) { [IO.DirectoryInfo]::new($p) } else { [IO.FileInfo]::new($p) }
    if (($item.Attributes -band 1024) -ne 0) { throw 'system link' }
    $acl = $item.GetAccessControl()
    if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'owner' }
    foreach ($r in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if ($r.AccessControlType -eq 'Allow' -and ($r.PropagationFlags -band 2) -eq 0 -and ($r.FileSystemRights -band 0xD0116) -ne 0 -and $trusted -notcontains $r.IdentityReference.Value) { throw 'system acl' }
    }
  }
  $stream = [Console]::OpenStandardInput(); $bytes = [byte[]]::new(8193); $length = 0
  while ($length -lt $bytes.Length) {
    $n = $stream.Read($bytes,$length,$bytes.Length-$length); if ($n -eq 0) { break }; $length += $n
  }
  if ($length -gt 8192) { throw 'input' }
  $q = [Text.UTF8Encoding]::new($false,$true).GetString($bytes,0,$length) | ConvertFrom-Json
  $current = Get-AuthenticodeSignature -LiteralPath $q.currentExe
  if ($current.Status -ne 'Valid' -or $null -eq $current.SignerCertificate) { throw 'current signature' }
  $target = $q.targetExe
  if ($q.zipPath) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($q.zipPath)
    try {
      if ($zip.Entries.Count -lt 5 -or $zip.Entries.Count -gt 20000) { throw 'entries' }
      $root = [IO.Path]::GetFullPath($q.destination).TrimEnd('\') + '\'
      $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
      [long]$total = 0
      foreach ($entry in $zip.Entries) {
        $name = $entry.FullName
        if ($name.Length -gt 220 -or $name.Contains('\') -or $name.StartsWith('/') -or $name.Contains(':')) { throw 'path' }
        $directory = $name.EndsWith('/'); $parts = $name.TrimEnd('/').Split('/')
        foreach ($part in $parts) {
          if ($part -notmatch '^[^\x00-\x1f<>:"|?*]+$' -or $part -match '[. ]$' -or $part -eq '.' -or $part -eq '..' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)') { throw 'path component' }
        }
        if (-not $seen.Add($name.TrimEnd('/'))) { throw 'duplicate' }
        $unix = ($entry.ExternalAttributes -shr 16) -band 61440
        if (($entry.ExternalAttributes -band 1024) -ne 0 -or ($unix -ne 0 -and $unix -ne 32768 -and $unix -ne 16384)) { throw 'special' }
        $total += $entry.Length
        if ($entry.Length -lt 0 -or $entry.Length -gt 1073741824 -or $total -gt 2147483648) { throw 'size' }
        $dest = [IO.Path]::GetFullPath([IO.Path]::Combine($root,$name))
        if (-not $dest.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { throw 'escape' }
        $parent = if ($directory) { $dest } else { [IO.Path]::GetDirectoryName($dest) }
        if (-not $q.verifyOnly) { [void][IO.Directory]::CreateDirectory($parent) }
        $cursor = $parent
        while ($cursor.Length -ge $root.TrimEnd('\').Length) {
          if (([IO.File]::GetAttributes($cursor) -band 1024) -ne 0) { throw 'link' }
          $cursor = [IO.Path]::GetDirectoryName($cursor)
        }
        if ($directory) { continue }
        if ($q.verifyOnly) {
          $file = [IO.FileInfo]::new($dest)
          if (($file.Attributes -band 1024) -ne 0 -or $file.Length -ne $entry.Length) { throw 'changed' }
          $inputFile = [IO.File]::OpenRead($dest); $entryStream = $entry.Open()
          $hash = [Security.Cryptography.SHA256]::Create()
          try {
            $left = [Convert]::ToBase64String($hash.ComputeHash($inputFile))
            $right = [Convert]::ToBase64String($hash.ComputeHash($entryStream))
            if ($left -cne $right) { throw 'changed' }
          } finally { $hash.Dispose(); $inputFile.Dispose(); $entryStream.Dispose() }
        } else {
          $source = $entry.Open(); $output = [IO.File]::Open($dest,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
          try {
            $buffer = [byte[]]::new(65536); [long]$written = 0
            while (($count = $source.Read($buffer,0,$buffer.Length)) -gt 0) {
              $written += $count; if ($written -gt $entry.Length) { throw 'inflate' }; $output.Write($buffer,0,$count)
            }
            if ($written -ne $entry.Length) { throw 'truncated' }; $output.Flush($true)
          } finally { $source.Dispose(); $output.Dispose() }
        }
      }
      if ($q.verifyOnly) {
        foreach ($file in [IO.Directory]::EnumerateFiles($root,'*',[IO.SearchOption]::AllDirectories)) {
          $relative = $file.Substring($root.Length).Replace('\','/')
          if (-not $seen.Contains($relative)) { throw 'extra file' }
        }
      }
    } finally { $zip.Dispose() }
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $target
  if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -cne $current.SignerCertificate.Thumbprint) { throw 'target signature' }
  if ($q.expectedVersion -and [Diagnostics.FileVersionInfo]::GetVersionInfo($target).ProductVersion -cne $q.expectedVersion) { throw 'version' }
  if (-not [IO.File]::Exists([IO.Path]::Combine([IO.Path]::GetDirectoryName($target),'resources','app.asar'))) { throw 'asar' }
  [Console]::Out.Write('{"ok":true}')
} catch { exit 1 }
`;

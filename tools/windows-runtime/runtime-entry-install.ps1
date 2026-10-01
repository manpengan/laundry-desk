function Assert-RuntimeEntryTree {
  param([string]$Root, [object[]]$Expected)
  [void][LaundryRuntimeEntryTrust]::DirectoryPath($Root)
  $names = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $Expected) { [void]$names.Add($entry.path.Replace('/', '\')) }
  $pending = New-Object 'Collections.Generic.Stack[string]'
  $pending.Push($Root)
  $count = 0
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    [void][LaundryRuntimeEntryTrust]::DirectoryPath($directory)
    foreach ($child in [IO.Directory]::EnumerateDirectories($directory)) {
      $relative = $child.Substring($Root.Length + 1) + '\'
      if (@($Expected | Where-Object { $_.path.Replace('/', '\').StartsWith($relative, [StringComparison]::OrdinalIgnoreCase) }).Count -eq 0) {
        throw 'WINDOWS_RUNTIME_ENTRY_INSTALL_CONFLICT'
      }
      $pending.Push($child)
    }
    foreach ($file in [IO.Directory]::EnumerateFiles($directory)) {
      $relative = $file.Substring($Root.Length + 1)
      if (-not $names.Contains($relative)) { throw 'WINDOWS_RUNTIME_ENTRY_INSTALL_CONFLICT' }
      $count++
    }
  }
  if ($count -ne $Expected.Count) { throw 'WINDOWS_RUNTIME_ENTRY_INSTALL_CONFLICT' }
  foreach ($entry in $Expected) {
    [LaundryRuntimeEntryTrust]::CheckVerified((Join-Path $Root $entry.path), $entry.size, $entry.sha256)
  }
}

function Set-RuntimeEntryShortcut {
  param([string]$Directory, [string]$ReleaseRoot)
  [void][LaundryRuntimeEntryTrust]::DirectoryPath($Directory)
  $name = 'Laundry Runtime V2 安装与维护 (' + $BoundManifest.Substring(0, 12) + ').lnk'
  $path = Join-Path $Directory $name
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = '-NoProfile -STA -ExecutionPolicy Bypass -File "' + (Join-Path $ReleaseRoot 'runtime-entry.ps1') + '"'
  $shell = New-Object -ComObject WScript.Shell
  try {
    $shortcut = $shell.CreateShortcut($path)
    if ([IO.File]::Exists($path)) {
      if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -or
          $shortcut.TargetPath -cne $powershell -or $shortcut.Arguments -cne $arguments -or
          $shortcut.WorkingDirectory -cne $ReleaseRoot) { throw 'WINDOWS_RUNTIME_ENTRY_SHORTCUT_CONFLICT' }
      return
    }
    $shortcut.TargetPath = $powershell
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $ReleaseRoot
    $shortcut.Description = '独立本地服务的安装、状态与备份恢复（开发合成数据）'
    $shortcut.Save()
  } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}

function Install-RuntimeEntry {
  $stage = 'ROOT'
  try {
  if ($env:LOCALAPPDATA -cnotmatch '^[A-Za-z]:\\' -or $env:APPDATA -cnotmatch '^[A-Za-z]:\\' -or
      $env:USERPROFILE -cnotmatch '^[A-Za-z]:\\') { throw 'WINDOWS_RUNTIME_ENTRY_INSTALL_ROOT_INVALID' }
  $local = [LaundryRuntimeEntryTrust]::DirectoryPath($env:LOCALAPPDATA)
  $programs = Join-Path $local 'Programs'
  if (-not [IO.Directory]::Exists($programs)) { [void][IO.Directory]::CreateDirectory($programs) }
  [void][LaundryRuntimeEntryTrust]::DirectoryPath($programs)
  $parent = Join-Path $programs 'Laundry Desk Runtime V2'
  if ([IO.Directory]::Exists($parent)) { [LaundryRuntimeEntryTrust]::AssertPrivateDirectory($parent) }
  else {
    [void][IO.Directory]::CreateDirectory($parent)
    [LaundryRuntimeEntryTrust]::PrivateDirectory($parent)
  }
  $release = Join-Path $parent $BoundManifest
  $stage = 'INVENTORY'
  $selfInfo = New-Object IO.FileInfo((Join-Path $EntryRoot 'runtime-entry.ps1'))
  $expected = @(@{ path = 'runtime-entry.ps1'; size = $selfInfo.Length; sha256 = $SelfDigest }) + @($BoundOperator)
  $expected += @{ path = 'payload/runtime-payload.json'; size = $manifestSize; sha256 = $BoundManifest }
  foreach ($entry in $Manifest.files) {
    $expected += @{ path = ('payload/' + $entry.path); size = $entry.size; sha256 = $entry.sha256 }
  }
  if ([IO.Directory]::Exists($release)) {
    $stage = 'EXISTING'
    [LaundryRuntimeEntryTrust]::AssertPrivateDirectory($release)
    Assert-RuntimeEntryTree $release $expected
  } else {
    $stage = 'COPY'
    $staging = Join-Path $parent ('.stage-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($staging)
    [LaundryRuntimeEntryTrust]::PrivateDirectory($staging)
    try {
      foreach ($entry in $expected) {
        $source = Join-Path $EntryRoot $entry.path
        $target = Join-Path $staging $entry.path
        $directory = [IO.Path]::GetDirectoryName($target)
        [void][IO.Directory]::CreateDirectory($directory)
        [void][LaundryRuntimeEntryTrust]::DirectoryPath($directory)
        $input = [LaundryRuntimeEntryTrust]::OpenVerified($source, $entry.size, $entry.sha256)
        try {
          $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
          try { $input.CopyTo($output); $output.Flush($true) } finally { $output.Dispose() }
        } finally { $input.Dispose() }
      }
      $stage = 'VERIFY'
      Assert-RuntimeEntryTree $staging $expected
      $stage = 'PUBLISH'
      [IO.Directory]::Move($staging, $release)
    } finally {
      # Only this newly-created staging directory is eligible for cleanup.
      if ([IO.Directory]::Exists($staging)) {
        [void][LaundryRuntimeEntryTrust]::DirectoryPath($staging)
        [IO.Directory]::Delete($staging, $true)
      }
    }
  }
  $stage = 'MENU'
  $menuParent = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  [void][LaundryRuntimeEntryTrust]::DirectoryPath($menuParent)
  $menu = Join-Path $menuParent 'Laundry Desk Runtime V2'
  if (-not [IO.Directory]::Exists($menu)) { [void][IO.Directory]::CreateDirectory($menu) }
  Set-RuntimeEntryShortcut $menu $release
  # Some managed Windows accounts have no Desktop folder; Start Menu remains available.
  $stage = 'DESKTOP'
  $desktop = Join-Path $env:USERPROFILE 'Desktop'
  if ([IO.Directory]::Exists($desktop)) { Set-RuntimeEntryShortcut $desktop $release }
  return $release
  } catch {
    $code = [string]($_.Exception.GetBaseException().Message)
    if ($code -cmatch '^WINDOWS_(RUNTIME_ENTRY|COMPANION)_[A-Z_]+$') { throw $code }
    throw ('WINDOWS_RUNTIME_ENTRY_INSTALL_' + $stage + '_FAILED')
  }
}

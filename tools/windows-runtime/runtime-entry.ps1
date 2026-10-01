[CmdletBinding()]
param(
  [ValidateSet('gui','install','status','start','stop','repair','upgrade','rollback','backup','backup-list','backup-verify','restore','maintenance-recover')][string]$Action = 'gui',
  [string]$BackupId,
  [string]$ConfirmationDigest
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$policy = [Environment]::GetEnvironmentVariable('PSExecutionPolicyPreference', 'Process')
$allowed = @('SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','USERNAME','USERDOMAIN')
foreach ($key in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
  if ($allowed -notcontains $key) { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }
}
if ($policy -ceq 'Bypass') { [Environment]::SetEnvironmentVariable('PSExecutionPolicyPreference', 'Bypass', 'Process') }
$env:PATH = [IO.Path]::Combine($env:SystemRoot, 'System32')
$env:PSModulePath = [IO.Path]::Combine($env:SystemRoot, 'System32\WindowsPowerShell\v1.0\Modules')
$BoundSource = '@@SOURCE_SHA@@'
$BoundManifest = '@@MANIFEST_SHA@@'
$BoundBootstrap = @@BOOTSTRAP@@
$BoundOperator = @@OPERATOR_HELPERS@@
$script:EntryInteractive = $Action -ceq 'gui'
$held = New-Object 'Collections.Generic.List[IO.FileStream]'

function Assert-EntryArguments {
  param([string]$Verb, [string]$Id, [string]$Confirmation)
  $hasId = -not [string]::IsNullOrEmpty($Id)
  $hasConfirmation = -not [string]::IsNullOrEmpty($Confirmation)
  if (($hasId -and $Id -cnotmatch '^b_[a-f0-9]{32}$') -or ($hasConfirmation -and $Confirmation -cnotmatch '^[a-f0-9]{64}$') -or
      ($Verb -ceq 'restore' -and (-not $hasId -or -not $hasConfirmation)) -or
      ($Verb -ceq 'backup-verify' -and (-not $hasId -or $hasConfirmation)) -or
      ($Verb -cne 'restore' -and $Verb -cne 'backup-verify' -and ($hasId -or $hasConfirmation))) {
    throw 'WINDOWS_RUNTIME_ENTRY_ARGS_INVALID'
  }
}

function Invoke-RuntimeEntryAction {
  param([string]$Verb, [string]$Id, [string]$Confirmation)
  Assert-EntryArguments $Verb $Id $Confirmation
  if (@('install','status','start','stop','repair','upgrade','rollback','backup','backup-list','backup-verify','restore','maintenance-recover') -cnotcontains $Verb) {
    throw 'WINDOWS_RUNTIME_ENTRY_ARGS_INVALID'
  }
  if ($Verb -ceq 'install' -or $Verb -ceq 'upgrade') { [void](Install-RuntimeEntry) }
  $arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    (Join-Path $PayloadRoot 'scripts\lifecycle-launch.ps1'),'-Action',$Verb,'-Payload',$PayloadRoot,'-ManifestDigest',$BoundManifest)
  if ($Verb -ceq 'restore' -or $Verb -ceq 'backup-verify') { $arguments += @('-BackupId', $Id) }
  if ($Verb -ceq 'restore') { $arguments += @('-ConfirmationDigest', $Confirmation) }
  $rendered = @($arguments | ForEach-Object {
    if ($_ -match '["\r\n\x00]') { throw 'WINDOWS_RUNTIME_ENTRY_ARGS_INVALID' }
    '"' + [regex]::Replace($_, '(\\+)$', '$1$1') + '"'
  })
  $process = New-Object Diagnostics.Process
  $process.StartInfo.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $process.StartInfo.Arguments = $rendered -join ' '
  $process.StartInfo.WorkingDirectory = $EntryRoot
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  try {
    if (-not $process.Start()) { throw 'WINDOWS_RUNTIME_ENTRY_PROCESS_FAILED' }
    $output = [LaundryRuntimeEntryTrust]::ReadBounded($process.StandardOutput)
    $errors = [LaundryRuntimeEntryTrust]::ReadBounded($process.StandardError)
    $deadline = [DateTime]::UtcNow.AddMinutes(15)
    while (-not $process.HasExited -or -not $output.IsCompleted -or -not $errors.IsCompleted) {
      if (-not $process.HasExited) { [void]$process.WaitForExit(100) }
      else { [Threading.Thread]::Sleep(100) }
      if ($script:EntryInteractive) { [Windows.Forms.Application]::DoEvents() }
      if ($output.IsFaulted -or $errors.IsFaulted -or [DateTime]::UtcNow -gt $deadline) {
        if (-not $process.HasExited) { $process.Kill(); [void]$process.WaitForExit(5000) }
        throw 'WINDOWS_RUNTIME_ENTRY_PROCESS_FAILED'
      }
    }
    $text = $output.Result.Trim()
    if ($process.ExitCode -ne 0) {
      $codes = [regex]::Matches($errors.Result, '\bWINDOWS_COMPANION_[A-Z_]+\b')
      if ($codes.Count -gt 0) { throw $codes[$codes.Count - 1].Value }
      throw 'WINDOWS_RUNTIME_ENTRY_ACTION_FAILED'
    }
    $result = $text | ConvertFrom-Json
    if ($null -eq $result -or $result.assurance -cne 'development_only') { throw 'WINDOWS_RUNTIME_ENTRY_RESULT_INVALID' }
    return $text
  } finally { $process.Dispose() }
}

try {
  if (($PSBoundParameters.ContainsKey('BackupId') -and [string]::IsNullOrEmpty($BackupId)) -or
      ($PSBoundParameters.ContainsKey('ConfirmationDigest') -and [string]::IsNullOrEmpty($ConfirmationDigest))) {
    throw 'WINDOWS_RUNTIME_ENTRY_ARGS_INVALID'
  }
  Assert-EntryArguments $Action $BackupId $ConfirmationDigest
  @@TRUST@@
  $EntryRoot = [LaundryRuntimeEntryTrust]::HoldDirectoryPath($PSScriptRoot)
  $PayloadRoot = [LaundryRuntimeEntryTrust]::HoldDirectoryPath((Join-Path $EntryRoot 'payload'))
  $self = Join-Path $EntryRoot 'runtime-entry.ps1'
  $SelfDigest = [LaundryRuntimeEntryTrust]::FileDigest($self, 262144)
  $held.Add([LaundryRuntimeEntryTrust]::OpenVerified($self, (New-Object IO.FileInfo($self)).Length, $SelfDigest))
  $manifestPath = Join-Path $PayloadRoot 'runtime-payload.json'
  $manifestSize = (New-Object IO.FileInfo($manifestPath)).Length
  if ($manifestSize -gt 8388608) { throw 'WINDOWS_RUNTIME_ENTRY_INTEGRITY_FAILED' }
  $manifestHandle = [LaundryRuntimeEntryTrust]::OpenVerified($manifestPath, $manifestSize, $BoundManifest)
  $held.Add($manifestHandle)
  $reader = New-Object IO.StreamReader($manifestHandle, (New-Object Text.UTF8Encoding($false, $true)), $false, 4096, $true)
  try { $Manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose(); $manifestHandle.Position = 0 }
  if ($Manifest.source_git_sha -cne $BoundSource -or $Manifest.assurance -cne 'development_only' -or $Manifest.platform -cne 'win32-x64') {
    throw 'WINDOWS_RUNTIME_ENTRY_BINDING_INVALID'
  }
  foreach ($entry in $BoundBootstrap) {
    $held.Add([LaundryRuntimeEntryTrust]::OpenVerified((Join-Path $PayloadRoot $entry.path), $entry.size, $entry.sha256))
  }
  foreach ($entry in $BoundOperator) {
    $held.Add([LaundryRuntimeEntryTrust]::OpenVerified((Join-Path $EntryRoot $entry.path), $entry.size, $entry.sha256))
  }
  # All operator helpers are independently bound by the trusted generated entry.
  . (Join-Path $EntryRoot 'runtime-entry-shortcut.ps1')
  . (Join-Path $EntryRoot 'runtime-entry-install.ps1')
  if ($script:EntryInteractive) {
    . (Join-Path $EntryRoot 'runtime-entry-ui.ps1')
    Show-RuntimeEntry
  } else { [Console]::Out.WriteLine((Invoke-RuntimeEntryAction $Action $BackupId $ConfirmationDigest)) }
} catch {
  $code = [string]($_.Exception.GetBaseException().Message)
  if ($code -cnotmatch '^WINDOWS_(RUNTIME_ENTRY|COMPANION)_[A-Z_]+$') { $code = 'WINDOWS_RUNTIME_ENTRY_FAILED' }
  if ($script:EntryInteractive) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show("无法完成操作。错误代码：$code", '本地服务安装与维护')
  } else { [Console]::Error.WriteLine($code) }
  exit 1
} finally {
  foreach ($file in $held) { $file.Dispose() }
  if ('LaundryRuntimeEntryTrust' -as [type]) { [LaundryRuntimeEntryTrust]::ReleaseDirectories() }
}

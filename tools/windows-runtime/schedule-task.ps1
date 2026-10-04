[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('register','inspect','remove')][string]$Verb,
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$Payload,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestDigest,
  [ValidateRange(0,23)][int]$Hour = 3,
  [ValidateRange(0,59)][int]$Minute = 0
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$name = 'LaundryDeskV2AutomaticBackup'
try {
  foreach ($path in @($Root, $Payload)) {
    if ($path -match '["\r\n\x00]' -or [IO.Path]::GetFullPath($path) -cne $path) { throw 'WINDOWS_COMPANION_BACKUP_TASK_INVALID' }
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User.Value
  $executable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $launcher = Join-Path $Payload 'scripts\lifecycle-launch.ps1'
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $launcher + '" -Action scheduled-backup -Payload "' + $Payload + '" -ManifestDigest ' + $ManifestDigest
  $sddl = 'O:' + $sid + 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;' + $sid + ')'
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  $folder = $service.GetFolder('\')
  $existing = $null
  try { $existing = $folder.GetTask($name) }
  catch { if ($_.Exception.GetBaseException().HResult -ne -2147024894) { throw } }
  function Assert-BackupTask($checkedTask, [bool]$checkTime) {
    $definition = $checkedTask.Definition
    $principal = $definition.Principal
    $owner = if ($principal.UserId -match '^S-1-') { $principal.UserId } else { (New-Object Security.Principal.NTAccount($principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($owner -ne $sid -or $principal.LogonType -ne 3 -or $principal.RunLevel -ne 0 -or
        $definition.Actions.Count -ne 1 -or $definition.Actions.Item(1).Type -ne 0 -or
        $definition.Actions.Item(1).Path -cne $executable -or $definition.Actions.Item(1).Arguments -cne $arguments -or
        $definition.Actions.Item(1).WorkingDirectory -cne $Root -or $definition.Triggers.Count -ne 1 -or
        $definition.Triggers.Item(1).Type -ne 2 -or $definition.Triggers.Item(1).DaysInterval -ne 1 -or
        $definition.Settings.MultipleInstances -ne 2 -or $definition.Settings.AllowHardTerminate -or
        -not $definition.Settings.StartWhenAvailable -or $definition.Settings.ExecutionTimeLimit -ne 'PT0S') {
      throw 'WINDOWS_COMPANION_BACKUP_TASK_CONFLICT'
    }
    $security = New-Object Security.AccessControl.RawSecurityDescriptor($checkedTask.GetSecurityDescriptor(5))
    if ($security.Owner.Value -ne $sid -or $security.DiscretionaryAcl.Count -ne 3 -or
        ($security.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0) {
      throw 'WINDOWS_COMPANION_BACKUP_TASK_SECURITY_INVALID'
    }
    $remaining = New-Object 'Collections.Generic.HashSet[string]'
    foreach ($trustee in @($sid, 'S-1-5-18', 'S-1-5-32-544')) { [void]$remaining.Add($trustee) }
    foreach ($ace in $security.DiscretionaryAcl) {
      if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or $ace.AceFlags -ne [Security.AccessControl.AceFlags]::None -or
          $ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or $ace.AccessMask -ne 0x1f01ff -or
          -not $remaining.Remove($ace.SecurityIdentifier.Value)) { throw 'WINDOWS_COMPANION_BACKUP_TASK_SECURITY_INVALID' }
    }
    if ($remaining.Count -ne 0) { throw 'WINDOWS_COMPANION_BACKUP_TASK_SECURITY_INVALID' }
    if ($checkTime) {
      $time = [DateTime]::ParseExact($definition.Triggers.Item(1).StartBoundary, 'yyyy-MM-ddTHH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
      if ($time.Hour -ne $Hour -or $time.Minute -ne $Minute -or $time.Second -ne 0) { throw 'WINDOWS_COMPANION_BACKUP_TASK_TIME_INVALID' }
    }
  }
  if ($null -ne $existing) { Assert-BackupTask $existing ($Verb -ceq 'inspect') }
  if ($Verb -ceq 'remove' -and $null -ne $existing) { $folder.DeleteTask($name, 0); $existing = $null }
  if ($Verb -ceq 'register') {
    $definition = $service.NewTask(0)
    $definition.RegistrationInfo.Description = 'Laundry Desk V2 private scheduled backup and recovery drill'
    $definition.Principal.UserId = $sid; $definition.Principal.LogonType = 3; $definition.Principal.RunLevel = 0
    $definition.Settings.Enabled = $true; $definition.Settings.StartWhenAvailable = $true
    $definition.Settings.MultipleInstances = 2; $definition.Settings.AllowHardTerminate = $false
    $definition.Settings.ExecutionTimeLimit = 'PT0S'
    $definition.Settings.DisallowStartIfOnBatteries = $false; $definition.Settings.StopIfGoingOnBatteries = $false
    $trigger = $definition.Triggers.Create(2)
    $trigger.StartBoundary = [DateTime]::Today.AddHours($Hour).AddMinutes($Minute).ToString('yyyy-MM-ddTHH:mm:ss')
    $trigger.DaysInterval = 1; $trigger.Enabled = $true
    $entry = $definition.Actions.Create(0)
    $entry.Path = $executable; $entry.Arguments = $arguments; $entry.WorkingDirectory = $Root
    $existing = $folder.RegisterTaskDefinition($name, $definition, 6, $sid, $null, 3, $sddl)
    $existing.SetSecurityDescriptor($sddl, 16)
    $existing = $folder.GetTask($name)
    Assert-BackupTask $existing $true
    if (-not $existing.Enabled -or -not $existing.Definition.Triggers.Item(1).Enabled) { throw 'WINDOWS_COMPANION_BACKUP_TASK_INVALID' }
  }
  @{ exists = ($null -ne $existing -and $existing.Enabled -and $existing.Definition.Triggers.Item(1).Enabled) } | ConvertTo-Json -Compress
} catch {
  $code = [string]$_.Exception.GetBaseException().Message
  if ($code -cnotmatch '^WINDOWS_COMPANION_[A-Z_]+$') { $code = 'WINDOWS_COMPANION_BACKUP_TASK_FAILED' }
  [Console]::Error.WriteLine($code)
  exit 1
}

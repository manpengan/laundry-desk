[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('ports','stop-server','task-inspect','task-register','task-disable','task-enable','task-remove')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$Payload,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestDigest
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$TaskName = 'LaundryDeskV2RuntimeCompanion'
$Node = Join-Path $Payload 'node\node.exe'
$Entry = Join-Path $Payload 'server\dist\runtime\kit-entrypoint.js'
$Launcher = Join-Path $Payload 'scripts\lifecycle-launch.ps1'
$TaskExecutable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $Launcher + '" -Action start -Payload "' + $Payload + '" -ManifestDigest ' + $ManifestDigest
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
. (Join-Path $PSScriptRoot 'lifecycle-identity.ps1')

function Resolve-UserSid {
  param([string]$Value)
  if ($Value -match '^S-1-[0-9-]+$') { return (New-Object Security.Principal.SecurityIdentifier($Value)).Value }
  return (New-Object Security.Principal.NTAccount($Value)).Translate([Security.Principal.SecurityIdentifier]).Value
}

function Assert-TaskSecurityDescriptor {
  param([string]$Sddl, [string]$UserSid, [switch]$AllowLegacy)
  try {
    if ([string]::IsNullOrWhiteSpace($Sddl) -or $Sddl.Length -gt 8192) { throw 'invalid' }
    $security = New-Object Security.AccessControl.RawSecurityDescriptor($Sddl)
    $owner = $security.Owner.Value
  } catch { throw 'WINDOWS_COMPANION_TASK_SECURITY_INVALID' }
  $administrators = 'S-1-5-32-544'
  $system = 'S-1-5-18'
  $allowed = @($UserSid, $system, $administrators)
  if ($owner -ne $UserSid -and $owner -ne $administrators) { throw 'WINDOWS_COMPANION_TASK_SECURITY_INVALID' }
  $acl = $security.DiscretionaryAcl
  if ($null -eq $acl -or $acl.Count -lt 3 -or $acl.Count -gt 8) { throw 'WINDOWS_COMPANION_TASK_SECURITY_INVALID' }
  $protected = ($security.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0
  $strict = $owner -eq $UserSid -and $protected -and $acl.Count -eq 3
  $seen = @()
  foreach ($ace in $acl) {
    if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or
        $ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or
        ($ace.AceFlags -ne [Security.AccessControl.AceFlags]::None -and $ace.AceFlags -ne [Security.AccessControl.AceFlags]::Inherited)) {
      throw 'WINDOWS_COMPANION_TASK_SECURITY_INVALID'
    }
    $sid = $ace.SecurityIdentifier.Value
    if ($allowed -notcontains $sid) { throw 'WINDOWS_COMPANION_TASK_SECURITY_INVALID' }
    # Only the observed scheduler defaults may be repaired; no unknown authority is adopted.
    $masks = if ($sid -eq $UserSid) { @(0x1f01ff, 0x120089) } else { @(0x1f01ff, 0x1f019f) }
    if ($masks -notcontains $ace.AccessMask) { throw 'WINDOWS_COMPANION_TASK_SECURITY_INVALID' }
    if ($seen -contains $sid -or $ace.AccessMask -ne 0x1f01ff -or $ace.AceFlags -ne [Security.AccessControl.AceFlags]::None) { $strict = $false }
    $seen += $sid
  }
  if (@($allowed | Where-Object { $seen -notcontains $_ }).Count -ne 0 -or (-not $strict -and -not $AllowLegacy)) {
    throw 'WINDOWS_COMPANION_TASK_SECURITY_INVALID'
  }
  return $strict
}

function Get-RegisteredRuntimeTask {
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  return $service.GetFolder('\').GetTask($TaskName)
}

function Assert-Task {
  param([switch]$AllowLegacyTaskSecurity)
  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
  if ($null -eq $task) { return $null }
  $sid = Resolve-UserSid $task.Principal.UserId
  if ($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -cne $TaskExecutable -or
      $task.Actions[0].Arguments -cne $Arguments -or $task.Actions[0].WorkingDirectory -cne $Root -or
      $sid -ne $Identity.User.Value -or $task.Principal.LogonType -ne 'Interactive' -or
      $task.Principal.RunLevel -ne 'Limited' -or $task.Settings.AllowHardTerminate -or
      $task.Settings.MultipleInstances -ne 'IgnoreNew' -or $task.Triggers.Count -ne 1 -or
      $task.Triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or
      (Resolve-UserSid $task.Triggers[0].UserId) -ne $Identity.User.Value) {
    throw 'WINDOWS_COMPANION_TASK_CONFLICT'
  }
  $registered = Get-RegisteredRuntimeTask
  [void](Assert-TaskSecurityDescriptor ($registered.GetSecurityDescriptor(5)) $Identity.User.Value -AllowLegacy:$AllowLegacyTaskSecurity)
  return $task
}

function Repair-TaskSecurity {
  $registered = Get-RegisteredRuntimeTask
  if (-not (Assert-TaskSecurityDescriptor ($registered.GetSecurityDescriptor(5)) $Identity.User.Value -AllowLegacy)) {
    $sddl = 'O:' + $Identity.User.Value + 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;' + $Identity.User.Value + ')'
    # TASK_DONT_ADD_PRINCIPAL_ACE: all three authorized trustees are already explicit.
    $registered.SetSecurityDescriptor($sddl, 16)
  }
  [void](Assert-TaskSecurityDescriptor ($registered.GetSecurityDescriptor(5)) $Identity.User.Value)
}

# Store counters are often laptops: the runtime must start, and keep running, on battery.
# Tasks registered before this rule are repaired the next time they are registered or enabled.
function Repair-TaskPowerPolicy {
  param($Task)
  if (-not $Task.Settings.DisallowStartIfOnBatteries -and -not $Task.Settings.StopIfGoingOnBatteries) {
    return $Task
  }
  $Task.Settings.DisallowStartIfOnBatteries = $false
  $Task.Settings.StopIfGoingOnBatteries = $false
  Set-ScheduledTask -InputObject $Task | Out-Null
  Repair-TaskSecurity
  return (Assert-Task)
}

function Inspect-Port {
  param([int]$Port, [string]$Executable)
  # Avoid the slow CIM no-match path. A missing listener has no process to own;
  # startup still rechecks both actual listeners before reporting ready.
  $listening = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $Port })
  if ($listening.Count -eq 0) { return $null }
  $connections = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($connections.Count -eq 0) { return $null }
  if ($connections.Count -ne 1 -or $connections[0].LocalAddress -ne '127.0.0.1') {
    throw 'WINDOWS_COMPANION_PORT_CONFLICT'
  }
  $item = Get-CimInstance Win32_Process -Filter "ProcessId = $($connections[0].OwningProcess)"
  if ($null -eq $item -or -not (Test-RuntimePath $item.ExecutablePath $Executable)) {
    throw 'WINDOWS_COMPANION_PROCESS_CONFLICT'
  }
  if (-not (Test-RuntimeCommand $item.CommandLine $Port $Executable $Entry (Join-Path $Root 'postgres-data'))) {
    if ($Port -eq 8543) { throw 'WINDOWS_COMPANION_POSTGRES_PROCESS_CONFLICT' }
    throw 'WINDOWS_COMPANION_SERVER_PROCESS_CONFLICT'
  }
  $owner = Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid
  if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $Identity.User.Value) {
    throw 'WINDOWS_COMPANION_PROCESS_OWNER_INVALID'
  }
  return $item
}

try {
  if ($Action -eq 'ports' -or $Action -eq 'stop-server') {
    $api = Inspect-Port 8787 $Node
    $pg = Inspect-Port 8543 (Join-Path $Payload 'postgres\bin\postgres.exe')
    if ($Action -eq 'stop-server' -and $null -ne $api) {
      # Hold the process handle and recheck creation identity before termination.
      $process = [Diagnostics.Process]::GetProcessById($api.ProcessId)
      try {
        [void]$process.Handle
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($api.ProcessId)"
        if ($null -eq $current -or $current.CreationDate -ne $api.CreationDate) {
          throw 'WINDOWS_COMPANION_PROCESS_CHANGED'
        }
        $process.Kill()
        if (-not $process.WaitForExit(30000)) { throw 'WINDOWS_COMPANION_STOP_TIMEOUT' }
      } finally { $process.Dispose() }
    }
    @{api = ($null -ne $api); postgres = ($null -ne $pg)} | ConvertTo-Json -Compress
    exit 0
  }
  $task = Assert-Task -AllowLegacyTaskSecurity:($Action -eq 'task-register')
  switch ($Action) {
    'task-register' {
      if ($null -eq $task) {
        $entry = New-ScheduledTaskAction -Execute $TaskExecutable -Argument $Arguments -WorkingDirectory $Root
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Identity.Name
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -DisallowHardTerminate -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $principal = New-ScheduledTaskPrincipal -UserId $Identity.Name -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $entry -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
        $task = Assert-Task -AllowLegacyTaskSecurity
      }
      Repair-TaskSecurity
      $task = Repair-TaskPowerPolicy (Assert-Task)
      Disable-ScheduledTask -InputObject $task | Out-Null
    }
    'task-disable' { if ($null -ne $task) { Disable-ScheduledTask -InputObject $task | Out-Null } }
    'task-enable' {
      if ($null -eq $task) { throw 'WINDOWS_COMPANION_TASK_MISSING' }
      $task = Repair-TaskPowerPolicy $task
      Enable-ScheduledTask -InputObject $task | Out-Null
    }
    'task-remove' { if ($null -ne $task) { Unregister-ScheduledTask -InputObject $task -Confirm:$false } }
  }
  @{exists = ($null -ne $task)} | ConvertTo-Json -Compress
} catch {
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^WINDOWS_COMPANION_[A-Z_]+$') { $code = 'WINDOWS_COMPANION_HOST_FAILED' }
  $identifier = [string]$_.FullyQualifiedErrorId
  if ($identifier -notmatch '^[A-Za-z0-9_.,-]{1,120}$') { $identifier = 'HOST_EXCEPTION' }
  $diagnostic = @{ code = $identifier; frames = @("lifecycle-host.ps1:$($_.InvocationInfo.ScriptLineNumber)") } | ConvertTo-Json -Compress
  [Console]::Error.WriteLine('WINDOWS_COMPANION_DIAGNOSTIC ' + $diagnostic)
  [Console]::Error.WriteLine($code)
  exit 1
}

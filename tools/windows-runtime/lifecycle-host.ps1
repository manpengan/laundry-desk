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

function Resolve-UserSid {
  param([string]$Value)
  if ($Value -match '^S-1-[0-9-]+$') { return (New-Object Security.Principal.SecurityIdentifier($Value)).Value }
  return (New-Object Security.Principal.NTAccount($Value)).Translate([Security.Principal.SecurityIdentifier]).Value
}

function Assert-Task {
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
  return $task
}

function Inspect-Port {
  param([int]$Port, [string]$Executable, [string]$ExpectedArgument)
  $connections = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($connections.Count -eq 0) { return $null }
  if ($connections.Count -ne 1 -or $connections[0].LocalAddress -ne '127.0.0.1') {
    throw 'WINDOWS_COMPANION_PORT_CONFLICT'
  }
  $item = Get-CimInstance Win32_Process -Filter "ProcessId = $($connections[0].OwningProcess)"
  if ($null -eq $item -or $item.ExecutablePath -ine $Executable -or
      [string]::IsNullOrEmpty($item.CommandLine) -or $item.CommandLine -notmatch $ExpectedArgument) {
    throw 'WINDOWS_COMPANION_PROCESS_CONFLICT'
  }
  $owner = Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid
  if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $Identity.User.Value) {
    throw 'WINDOWS_COMPANION_PROCESS_OWNER_INVALID'
  }
  return $item
}

try {
  if ($Action -eq 'ports' -or $Action -eq 'stop-server') {
    $apiPattern = '^"?' + [regex]::Escape($Node) + '"?\s+"?' + [regex]::Escape($Entry) + '"?\s+server\s*$'
    $pgPattern = '(?:^|\s)-D\s+"?' + [regex]::Escape((Join-Path $Root 'postgres-data')) + '"?(?:\s|$)'
    $api = Inspect-Port 8787 $Node $apiPattern
    $pg = Inspect-Port 8543 (Join-Path $Payload 'postgres\bin\postgres.exe') $pgPattern
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
  $task = Assert-Task
  switch ($Action) {
    'task-register' {
      if ($null -eq $task) {
        $entry = New-ScheduledTaskAction -Execute $TaskExecutable -Argument $Arguments -WorkingDirectory $Root
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Identity.Name
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -DisallowHardTerminate -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
        $principal = New-ScheduledTaskPrincipal -UserId $Identity.Name -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $entry -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
        $task = Assert-Task
      }
      Disable-ScheduledTask -InputObject $task | Out-Null
    }
    'task-disable' { if ($null -ne $task) { Disable-ScheduledTask -InputObject $task | Out-Null } }
    'task-enable' {
      if ($null -eq $task) { throw 'WINDOWS_COMPANION_TASK_MISSING' }
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

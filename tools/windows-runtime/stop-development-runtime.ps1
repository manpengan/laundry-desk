[CmdletBinding()]
param(
  [string] $RepositoryRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName = 'LaundryDeskV2DevelopmentRuntime'
$ApiPort = 8787
$PostgresPort = 8543
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = Join-Path $PSScriptRoot '..\..'
}
$RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
$ExpectedNode = [IO.Path]::GetFullPath((Get-Command node.exe -ErrorAction Stop).Source)
$ExpectedEntrypoint = [IO.Path]::GetFullPath(
  (Join-Path $RepositoryRoot 'apps\server\dist\runtime\kit-entrypoint.js')
)
$RuntimeRoot = [IO.Path]::GetFullPath(
  (Join-Path $env:LOCALAPPDATA 'laundry-desk-v2\development-runtime')
)
$PgCtl = Join-Path $RuntimeRoot 'postgresql-16.15\pgsql\bin\pg_ctl.exe'
$DataRoot = Join-Path $RuntimeRoot 'postgres-data'
if (-not (Test-Path -LiteralPath (Join-Path $RepositoryRoot 'pnpm-workspace.yaml'))) {
  throw 'WINDOWS_RUNTIME_REPOSITORY_INVALID'
}
if (-not (Test-Path -LiteralPath $ExpectedEntrypoint)) {
  throw 'WINDOWS_RUNTIME_ENTRYPOINT_MISSING'
}

function Get-LoopbackListener {
  param([int] $Port)
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 1) { throw "WINDOWS_RUNTIME_PORT_$($Port)_LISTENER_AMBIGUOUS" }
  if ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -ne '127.0.0.1') {
    throw "WINDOWS_RUNTIME_PORT_$($Port)_NOT_LOOPBACK"
  }
  return $listeners
}

function Invoke-QuietNative {
  param([string] $File, [string[]] $Arguments)
  $renderedArguments = @($Arguments | ForEach-Object {
    if ($_.Contains('"') -or $_.Contains("`0") -or $_.Contains("`r") -or $_.Contains("`n")) {
      throw 'WINDOWS_RUNTIME_NATIVE_ARGUMENT_INVALID'
    }
    if ($_ -match '\s') { return '"' + $_ + '"' }
    return $_
  })
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $File
  $startInfo.Arguments = $renderedArguments -join ' '
  $startInfo.UseShellExecute = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) {
    throw 'WINDOWS_RUNTIME_NATIVE_PROCESS_INVALID'
  }
  try {
    $process.WaitForExit()
    return [int] $process.ExitCode
  } finally {
    $process.Dispose()
  }
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$taskDisabled = $false
$taskWasDisabled =
  $task.State -eq [Microsoft.PowerShell.Cmdletization.GeneratedTypes.ScheduledTask.StateEnum]::Disabled
$stopped = $false
try {
  if (-not $taskWasDisabled) {
    Disable-ScheduledTask -InputObject $task | Out-Null
    $taskDisabled = $true
  }

  $apiListeners = @(Get-LoopbackListener $ApiPort)
  if ($apiListeners.Count -eq 1) {
    $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($apiListeners[0].OwningProcess)"
    if (
      $null -eq $serverProcess -or
      [string]::IsNullOrWhiteSpace($serverProcess.ExecutablePath) -or
      -not [StringComparer]::OrdinalIgnoreCase.Equals(
        [IO.Path]::GetFullPath($serverProcess.ExecutablePath),
        $ExpectedNode
      ) -or
      [string]::IsNullOrWhiteSpace($serverProcess.CommandLine) -or
      -not $serverProcess.CommandLine.Contains($ExpectedEntrypoint) -or
      $serverProcess.CommandLine -notmatch '\sserver(?:\s|$)'
    ) {
      throw 'WINDOWS_RUNTIME_SERVER_PROCESS_IDENTITY_INVALID'
    }
    Stop-Process -Id $serverProcess.ProcessId -Force
  }

  $postgresStatus = Invoke-QuietNative $PgCtl @('status', "--pgdata=$DataRoot")
  if ($postgresStatus -eq 0) {
    $postgresStop = Invoke-QuietNative $PgCtl @(
      'stop'
      "--pgdata=$DataRoot"
      '--mode=fast'
      '--wait'
      '--timeout=60'
    )
    if ($postgresStop -ne 0 -and @(Get-LoopbackListener $PostgresPort).Count -ne 0) {
      throw 'WINDOWS_RUNTIME_POSTGRES_STOP_FAILED'
    }
  }

  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    $apiListeners = @(Get-LoopbackListener $ApiPort)
    $postgresListeners = @(Get-LoopbackListener $PostgresPort)
    $taskState = (Get-ScheduledTask -TaskName $TaskName).State
    if (
      $apiListeners.Count -eq 0 -and
      $postgresListeners.Count -eq 0 -and
      $taskState -ne [Microsoft.PowerShell.Cmdletization.GeneratedTypes.ScheduledTask.StateEnum]::Running
    ) {
      $stopped = $true
      break
    }
    Start-Sleep -Seconds 1
  }
  if (-not $stopped) { throw 'WINDOWS_RUNTIME_STOP_TIMEOUT' }
} finally {
  if ($taskDisabled) { Enable-ScheduledTask -TaskName $TaskName | Out-Null }
}

[pscustomobject]@{
  Status = 'stopped'
  ScheduledTask = $TaskName
  ApiPort = $ApiPort
  PostgresPort = $PostgresPort
}

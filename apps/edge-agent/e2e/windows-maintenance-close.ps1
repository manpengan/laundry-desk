[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$WindowId,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9]+$')][string]$Started,
  [Parameter(Mandatory=$true)][ValidateLength(1,200)][string]$Title
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$session = (Get-Process -Id $PID).SessionId
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$expectedExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Get-OwnedWindow {
  $process = Get-Process -Id $WindowId -ErrorAction Stop
  $cim = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $WindowId)
  if ($null -eq $cim -or $process.StartTime.ToUniversalTime().Ticks.ToString() -cne $Started -or
      $process.SessionId -ne $session -or $cim.ExecutablePath -ine $expectedExe -or
      $process.MainWindowTitle -cne $Title -or $process.MainWindowHandle -eq [IntPtr]::Zero) {
    throw 'COUNTER_MAINTENANCE_WINDOW_IDENTITY_CHANGED'
  }
  $owner = Invoke-CimMethod -InputObject $cim -MethodName GetOwnerSid
  if ($owner.ReturnValue -ne 0 -or $owner.Sid -cne $sid) { throw 'COUNTER_MAINTENANCE_WINDOW_OWNER_CHANGED' }
  return $process
}
[void](Get-OwnedWindow)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class MaintenanceWindowRead {
  public delegate bool Callback(IntPtr hwnd, IntPtr state);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, Callback callback, IntPtr state);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr count, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  public static long[] Children(IntPtr parent) {
    var rows = new List<long>();
    Callback callback = (h,s) => { rows.Add(h.ToInt64()); return true; };
    EnumChildWindows(parent, callback, IntPtr.Zero);
    return rows.ToArray();
  }
  public static string Class(IntPtr hwnd) {
    var text = new StringBuilder(256);
    if (GetClassName(hwnd, text, text.Capacity) == 0) throw new InvalidOperationException("COUNTER_MAINTENANCE_CLASS_UNAVAILABLE");
    return text.ToString();
  }
  public static string Text(IntPtr hwnd) {
    var text = new StringBuilder(4096); UIntPtr copied;
    if (SendMessageTimeout(hwnd, 0x000D, (UIntPtr)(uint)text.Capacity, text, 2, 1000, out copied) == IntPtr.Zero)
      throw new InvalidOperationException("COUNTER_MAINTENANCE_TEXT_UNAVAILABLE");
    return text.ToString();
  }
  public static bool Enabled(IntPtr hwnd) {
    for (int depth=0; depth<20 && hwnd!=IntPtr.Zero; depth++, hwnd=GetParent(hwnd))
      if (!IsWindowEnabled(hwnd)) return false;
    return hwnd == IntPtr.Zero;
  }
}
'@

function Read-OwnedState($Process) {
  $buttonCount = 0; $enabled = $true; $texts = @()
  foreach ($raw in [MaintenanceWindowRead]::Children($Process.MainWindowHandle)) {
    $handle = [IntPtr]::new($raw); $ownerId = [uint32]0
    [void][MaintenanceWindowRead]::GetWindowThreadProcessId($handle, [ref]$ownerId)
    if ($ownerId -ne $WindowId) { throw 'COUNTER_MAINTENANCE_CHILD_OWNER_CHANGED' }
    $class = [MaintenanceWindowRead]::Class($handle)
    if ($class -clike 'WindowsForms10.BUTTON.*') {
      $buttonCount++; $enabled = $enabled -and [MaintenanceWindowRead]::Enabled($handle)
    }
    if ($class -clike 'WindowsForms10.EDIT.*') { $texts += [MaintenanceWindowRead]::Text($handle) }
  }
  $done = @($texts | Where-Object { $_.StartsWith('操作完成，请查看状态确认') -and $_.Contains('自动备份：') -and $_.Contains('每日时间：') }).Count -eq 1
  $failed = @($texts | Where-Object { $_.StartsWith('操作未完成。错误代码：') }).Count -eq 1
  return @{ready=($buttonCount -eq 23 -and $enabled -and ($done -or $failed)); failed=$failed; busy=(-not $enabled)}
}

# Shown starts backup-health. Its guarded FormClosing consumes a close request while busy;
# waiting for process exit alone cannot make that cancelled request happen again.
$deadline = [DateTime]::UtcNow.AddSeconds(90)
$observedBusy = $false
do {
  $process = Get-OwnedWindow
  $state = Read-OwnedState $process
  if ($state.busy -and -not $observedBusy) { [Console]::Error.WriteLine('COUNTER_MAINTENANCE_BUSY_OBSERVED') }
  $observedBusy = $observedBusy -or $state.busy
  if ($state.ready) { break }
  if ([DateTime]::UtcNow -ge $deadline) { throw 'COUNTER_MAINTENANCE_NOT_READY_TO_CLOSE' }
  Start-Sleep -Milliseconds 100
} while ($true)
$process = Get-OwnedWindow
# Re-read immediately before the normal close; never terminate a maintenance process.
$state = Read-OwnedState $process
if (-not $state.ready) { throw 'COUNTER_MAINTENANCE_BECAME_BUSY' }
if (-not $process.CloseMainWindow() -or -not $process.WaitForExit(10000)) { throw 'COUNTER_MAINTENANCE_CLOSE_FAILED' }
if ($state.failed) { throw 'COUNTER_MAINTENANCE_NATIVE_HEALTH_FAILED' }
@{closed=$true; observed_busy=[bool]$observedBusy} | ConvertTo-Json -Compress

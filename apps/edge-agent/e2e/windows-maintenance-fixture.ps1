[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$EvidenceRoot, [Parameter(Mandatory=$true)][string]$Title)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace MaintenanceFixture -Name Window -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);'
$form = New-Object Windows.Forms.Form
$form.Text = $Title; $form.ClientSize = New-Object Drawing.Size(600,350)
$panel = New-Object Windows.Forms.FlowLayoutPanel
$panel.SetBounds(10,10,580,200); $panel.Enabled = $false
$form.Controls.Add($panel)
foreach ($index in 1..23) {
  $button = New-Object Windows.Forms.Button; $button.Text = 'Action ' + $index
  $panel.Controls.Add($button)
}
$output = New-Object Windows.Forms.TextBox
$output.Multiline = $true; $output.SetBounds(10,220,580,110)
$output.Text = '正在执行，请等待操作结果。'
$form.Controls.Add($output)
$script:busy = $true; $script:rejectedClose = 0; $script:acceptedClose = 0; $script:expired = $false
$script:startedAt = [DateTime]::UtcNow
$timer = New-Object Windows.Forms.Timer; $timer.Interval = 100
$timer.add_Tick({
  $elapsed = ([DateTime]::UtcNow - $script:startedAt).TotalSeconds
  if ($script:busy -and (Test-Path -LiteralPath (Join-Path $EvidenceRoot 'release-busy'))) {
    $output.Text = "操作完成，请查看状态确认`r`n自动备份：已启用`r`n每日时间：03:00"
    $panel.Enabled = $true; $script:busy = $false
  }
  if ($elapsed -ge 45) { $script:expired = $true; $form.Close() }
})
$form.add_Shown({
  [void][MaintenanceFixture.Window]::ShowWindow($form.Handle, 5); $form.Activate()
  $script:startedAt = [DateTime]::UtcNow; $timer.Start()
  $process = Get-Process -Id $PID
  @{id=$PID; started=$process.StartTime.ToUniversalTime().Ticks.ToString()} |
    ConvertTo-Json -Compress | Set-Content -Encoding UTF8 (Join-Path $EvidenceRoot 'ready.json')
})
$form.add_FormClosing({
  if ($script:busy -and -not $script:expired) { $script:rejectedClose++; $_.Cancel = $true }
  else { $script:acceptedClose++ }
})
try { [void]$form.ShowDialog() } finally {
  $timer.Stop(); $timer.Dispose(); $form.Dispose()
  @{rejected_close=$script:rejectedClose; accepted_close=$script:acceptedClose; expired=$script:expired} |
    ConvertTo-Json -Compress | Set-Content -Encoding UTF8 (Join-Path $EvidenceRoot 'result.json')
}

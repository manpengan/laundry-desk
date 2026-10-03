function Show-RuntimeScheduleDialog {
  param([Windows.Forms.Form]$Owner)
  $settings = ((Invoke-RuntimeEntryAction 'backup-health' $null $null $null) | ConvertFrom-Json).config
  $dialog = New-Object Windows.Forms.Form
  $dialog.Text = '自动备份与恢复演练'; $dialog.ClientSize = New-Object Drawing.Size(620, 450)
  $dialog.StartPosition = 'CenterParent'; $dialog.FormBorderStyle = 'FixedDialog'
  $dialog.MaximizeBox = $false; $dialog.MinimizeBox = $false; $dialog.Font = $Owner.Font
  $note = New-Object Windows.Forms.Label; $note.SetBounds(16, 14, 584, 52)
  $note.Text = '选择柜台空闲时间。备份期间会暂停本地服务；电脑需开机且当前 Windows 用户已登录。错过时间后由系统补跑。恢复演练只写入影子库。'
  $dialog.Controls.Add($note)
  $enabled = New-Object Windows.Forms.CheckBox; $enabled.SetBounds(16, 72, 580, 25)
  $enabled.Text = '启用每天自动备份'; $enabled.Checked = [bool]$settings.enabled; $dialog.Controls.Add($enabled)
  $fields = @(
    @('hour','每日小时（0–23）',0,23), @('minute','每日分钟（0–59）',0,59),
    @('retain_count','最多保留份数（受保护安全点除外）',2,24),
    @('retain_days','保留天数（始终保留最新两份）',1,365),
    @('minimum_free_mib','剩余空间提醒下限（MiB）',512,1048576),
    @('drill_days','恢复演练间隔（天）',1,30)
  )
  $inputs = @{}
  for ($index = 0; $index -lt $fields.Count; $index++) {
    $field = $fields[$index]
    $label = New-Object Windows.Forms.Label; $label.SetBounds(16, (112 + $index * 42), 400, 28); $label.Text = $field[1]
    $number = New-Object Windows.Forms.NumericUpDown; $number.SetBounds(450, (108 + $index * 42), 140, 28)
    $number.Minimum = $field[2]; $number.Maximum = $field[3]; $number.Value = $settings.($field[0])
    $inputs[$field[0]] = $number; $dialog.Controls.Add($label); $dialog.Controls.Add($number)
  }
  $ok = New-Object Windows.Forms.Button; $ok.SetBounds(376, 393, 105, 32); $ok.Text = '保存'; $ok.DialogResult = 'OK'
  $cancel = New-Object Windows.Forms.Button; $cancel.SetBounds(490, 393, 105, 32); $cancel.Text = '取消'; $cancel.DialogResult = 'Cancel'
  $dialog.Controls.Add($ok); $dialog.Controls.Add($cancel); $dialog.CancelButton = $cancel
  try {
    if ($dialog.ShowDialog($Owner) -ne [Windows.Forms.DialogResult]::OK) { return $null }
    $value = @{ version = 1; enabled = [bool]$enabled.Checked }
    foreach ($key in $inputs.Keys) { $value[$key] = [int]$inputs[$key].Value }
    return $value | ConvertTo-Json -Compress
  } finally { $dialog.Dispose() }
}

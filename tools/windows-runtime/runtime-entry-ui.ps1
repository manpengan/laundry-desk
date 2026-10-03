function Show-RuntimeEntry {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [Windows.Forms.Application]::EnableVisualStyles()
  $form = New-Object Windows.Forms.Form
  $form.Text = 'Laundry Desk V2 · 本地服务安装与维护'
  $form.ClientSize = New-Object Drawing.Size(800, 600)
  $form.MinimumSize = New-Object Drawing.Size(720, 560)
  $form.StartPosition = 'CenterScreen'
  $form.AutoScaleMode = 'Dpi'
  $form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
  $script:EntryBusy = $false

  $intro = New-Object Windows.Forms.Label
  $intro.SetBounds(18, 16, 760, 65)
  $intro.Text = "独立本地服务：柜台 EXE 卸载后，数据库与本入口仍保留。`r`n当前发行只用于合成开发测试；正式门店数据需另行准入。`r`n发行来源：$($BoundSource.Substring(0, 12))"
  $form.Controls.Add($intro)
  $buttons = New-Object Windows.Forms.FlowLayoutPanel
  $buttons.SetBounds(18, 90, 760, 90)
  $buttons.Anchor = 'Top,Left,Right'
  $form.Controls.Add($buttons)
  $output = New-Object Windows.Forms.TextBox
  $output.Multiline = $true; $output.ReadOnly = $true; $output.ScrollBars = 'Vertical'
  $output.SetBounds(18, 380, 760, 200)
  $output.Anchor = 'Top,Bottom,Left,Right'
  $output.Text = '请选择“查看状态”；首次使用请选择“安装本地服务”。备份前先退出柜台。'
  $form.Controls.Add($output)

  $backupLabel = New-Object Windows.Forms.Label
  $backupLabel.SetBounds(18, 185, 740, 28); $backupLabel.Text = '恢复/校验：先查看备份并明确选择一份；恢复前退出柜台。'
  $form.Controls.Add($backupLabel)
  $backupList = New-Object Windows.Forms.ComboBox
  $backupList.SetBounds(18, 218, 740, 30); $backupList.DropDownStyle = 'DropDownList'
  $backupList.Anchor = 'Top,Left,Right'
  $form.Controls.Add($backupList)
  $confirmLabel = New-Object Windows.Forms.Label
  $confirmLabel.SetBounds(18, 257, 740, 28); $confirmLabel.Text = '恢复确认：人工输入所选备份的完整 64 位 manifest 摘要（不会自动填入）。'
  $form.Controls.Add($confirmLabel)
  $confirmation = New-Object Windows.Forms.TextBox
  $confirmation.SetBounds(18, 291, 740, 30); $confirmation.MaxLength = 64
  $confirmation.Anchor = 'Top,Left,Right'
  $form.Controls.Add($confirmation)
  $recovery = New-Object Windows.Forms.FlowLayoutPanel
  $recovery.SetBounds(18, 330, 740, 40)
  $form.Controls.Add($recovery)
  $backupList.add_SelectedIndexChanged({ $confirmation.Clear() })

  $run = {
    param([string]$Verb)
    if ($script:EntryBusy) { return }
    $id = $null; $digest = $null
    try {
      if ($Verb -ceq 'restore' -or $Verb -ceq 'backup-verify') {
        if ($null -eq $backupList.SelectedItem) { throw 'WINDOWS_RUNTIME_ENTRY_BACKUP_SELECTION_REQUIRED' }
        $id = [string]$backupList.SelectedItem
        if ($Verb -ceq 'restore') {
          $digest = $confirmation.Text
          Assert-EntryArguments $Verb $id $digest
          $answer = [Windows.Forms.MessageBox]::Show('将恢复所选备份。请确认柜台已退出；系统会先创建恢复前安全点。', '确认恢复', 'YesNo', 'Warning')
          if ($answer -ne [Windows.Forms.DialogResult]::Yes) { return }
        }
      }
      if ($Verb -ceq 'stop' -or $Verb -ceq 'repair' -or $Verb -ceq 'backup' -or $Verb -ceq 'upgrade' -or $Verb -ceq 'rollback' -or $Verb -ceq 'maintenance-recover') {
        $answer = [Windows.Forms.MessageBox]::Show('请先退出柜台。此操作可能暂停本地服务，完成后将按既有规则恢复。', '确认维护', 'YesNo', 'Information')
        if ($answer -ne [Windows.Forms.DialogResult]::Yes) { return }
      }
      $script:EntryBusy = $true; $buttons.Enabled = $false; $recovery.Enabled = $false
      $backupList.Enabled = $false; $confirmation.Enabled = $false
      $output.Text = '正在执行，请等待操作结果……'; [Windows.Forms.Application]::DoEvents()
      $text = Invoke-RuntimeEntryAction $Verb $id $digest
      $result = $text | ConvertFrom-Json
      $states = @{ running = '服务运行中'; stopped = '服务已停止'; initialized = '已初始化'; staged = '初始化未完成'; backups = '已读取备份'; maintenance_required = '维护中断，需要明确恢复' }
      $status = if ($result.PSObject.Properties.Name -contains 'status') { [string]$result.status } else { '' }
      $description = if ($states.ContainsKey($status)) { $states[$status] } else { '操作完成，请查看状态确认' }
      $lines = New-Object 'Collections.Generic.List[string]'
      $lines.Add($description)
      if ($result.PSObject.Properties.Name -contains 'backup_id' -and $result.PSObject.Properties.Name -contains 'manifest_sha256') {
        $lines.Add('备份：' + [string]$result.backup_id); $lines.Add('确认摘要：' + [string]$result.manifest_sha256)
      }
      if ($Verb -ceq 'backup-list') {
        $backupList.Items.Clear(); $confirmation.Clear()
        foreach ($backup in $result.backups) {
          if ($backup.PSObject.Properties.Name -contains 'manifest_sha256') {
            [void]$backupList.Items.Add([string]$backup.backup_id)
            $lines.Add([string]$backup.backup_id + '  ' + [string]$backup.manifest_sha256)
          }
        }
        $backupList.SelectedIndex = -1
      }
      $output.Text = $lines -join "`r`n"
      if ($Verb -ceq 'restore') { $confirmation.Clear() }
    } catch {
      $code = [string]($_.Exception.GetBaseException().Message)
      if ($code -cnotmatch '^WINDOWS_(RUNTIME_ENTRY|COMPANION)_[A-Z_]+$') { $code = 'WINDOWS_RUNTIME_ENTRY_FAILED' }
      $output.Text = "操作未完成。错误代码：$code`r`n" + '如状态显示维护中断，请查看状态后明确选择“继续中断维护”。'
    } finally {
      $script:EntryBusy = $false; $buttons.Enabled = $true; $recovery.Enabled = $true
      $backupList.Enabled = $true; $confirmation.Enabled = $true
    }
  }
  foreach ($entry in @(
    @('安装本地服务','install'), @('查看状态','status'), @('启动服务','start'), @('停止服务','stop'),
    @('修复服务','repair'), @('创建备份','backup'), @('查看备份','backup-list'),
    @('升级到本包','upgrade'), @('回滚程序','rollback'), @('继续中断维护','maintenance-recover')
  )) {
    $button = New-Object Windows.Forms.Button; $button.Text = $entry[0]; $button.Tag = $entry[1]
    $button.AutoSize = $true; $button.Height = 34
    $button.add_Click({ & $run ([string]$this.Tag) })
    $buttons.Controls.Add($button)
  }
  foreach ($entry in @(@('校验所选备份','backup-verify'), @('恢复所选备份','restore'))) {
    $button = New-Object Windows.Forms.Button; $button.Text = $entry[0]; $button.Tag = $entry[1]
    $button.AutoSize = $true; $button.Height = 34
    $button.add_Click({ & $run ([string]$this.Tag) })
    $recovery.Controls.Add($button)
  }
  $form.add_FormClosing({ if ($script:EntryBusy) { $_.Cancel = $true } })
  try { [void]$form.ShowDialog() } finally { $form.Dispose() }
}

function Show-RuntimeEntry {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [Windows.Forms.Application]::EnableVisualStyles()
  $form = New-Object Windows.Forms.Form
  $form.Text = 'Laundry Desk V2 · 本地服务安装与维护'
  $form.ClientSize = New-Object Drawing.Size(800, 670)
  $form.MinimumSize = New-Object Drawing.Size(720, 630)
  $form.StartPosition = 'CenterScreen'
  $form.AutoScaleMode = 'Dpi'
  $form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
  $script:EntryBusy = $false

  $intro = New-Object Windows.Forms.Label
  $intro.SetBounds(18, 16, 760, 65)
  $intro.Text = "独立本地服务：柜台 EXE 卸载后，数据库与本入口仍保留。`r`n当前发行只用于合成开发测试；正式门店数据需另行准入。`r`n发行来源：$($BoundSource.Substring(0, 12))"
  $form.Controls.Add($intro)
  $buttons = New-Object Windows.Forms.FlowLayoutPanel
  $buttons.SetBounds(18, 90, 760, 150)
  $buttons.AutoScroll = $true
  $buttons.Anchor = 'Top,Left,Right'
  $form.Controls.Add($buttons)
  $output = New-Object Windows.Forms.TextBox
  $output.Multiline = $true; $output.ReadOnly = $true; $output.ScrollBars = 'Vertical'
  $output.SetBounds(18, 440, 760, 210)
  $output.Anchor = 'Top,Bottom,Left,Right'
  $output.Text = '请选择“查看状态”；首次使用请选择“安装本地服务”。备份前先退出柜台。'
  $form.Controls.Add($output)

  $backupLabel = New-Object Windows.Forms.Label
  $backupLabel.SetBounds(18, 245, 740, 28); $backupLabel.Text = '恢复/校验：先查看备份并明确选择一份；恢复前退出柜台。'
  $form.Controls.Add($backupLabel)
  $backupList = New-Object Windows.Forms.ComboBox
  $backupList.SetBounds(18, 278, 740, 30); $backupList.DropDownStyle = 'DropDownList'
  $backupList.Anchor = 'Top,Left,Right'
  $form.Controls.Add($backupList)
  $confirmLabel = New-Object Windows.Forms.Label
  $confirmLabel.SetBounds(18, 317, 740, 28); $confirmLabel.Text = '恢复确认：人工输入所选备份的完整 64 位 manifest 摘要（不会自动填入）。'
  $form.Controls.Add($confirmLabel)
  $confirmation = New-Object Windows.Forms.TextBox
  $confirmation.SetBounds(18, 351, 740, 30); $confirmation.MaxLength = 64
  $confirmation.Anchor = 'Top,Left,Right'
  $form.Controls.Add($confirmation)
  $recovery = New-Object Windows.Forms.FlowLayoutPanel
  $recovery.SetBounds(18, 390, 740, 40)
  $form.Controls.Add($recovery)
  $backupList.add_SelectedIndexChanged({ $confirmation.Clear() })

  $run = {
    param([string]$Verb)
    if ($script:EntryBusy) { return }
    $id = $null; $digest = $null; $inputJson = $null
    try {
      if ($Verb -ceq 'backup-schedule') {
        $inputJson = Show-RuntimeScheduleDialog $form
        if ([string]::IsNullOrEmpty($inputJson)) { return }
      }
      if (@('portable-export','portable-inspect','portable-import','v1-import','export-store') -ccontains $Verb) {
        $inputJson = Show-RuntimeDataDialog $Verb $form
        if ([string]::IsNullOrEmpty($inputJson)) { return }
      }
      if ($Verb -ceq 'restore' -or $Verb -ceq 'backup-verify' -or $Verb -ceq 'backup-drill') {
        if ($null -eq $backupList.SelectedItem) { throw 'WINDOWS_RUNTIME_ENTRY_BACKUP_SELECTION_REQUIRED' }
        $id = [string]$backupList.SelectedItem
        if ($Verb -ceq 'restore') {
          $digest = $confirmation.Text
          Assert-EntryArguments $Verb $id $digest
          $answer = [Windows.Forms.MessageBox]::Show('将恢复所选备份。请确认柜台已退出；系统会先创建恢复前安全点。', '确认恢复', 'YesNo', 'Warning')
          if ($answer -ne [Windows.Forms.DialogResult]::Yes) { return }
        }
      }
      if (@('stop','repair','backup','backup-drill','scheduled-backup','upgrade','rollback','maintenance-recover') -ccontains $Verb) {
        $warning = if ($Verb -ceq 'rollback') { '请先退出柜台。跨数据库结构的回退会同时恢复旧程序和升级前数据；升级后的业务变更只保存在回退前安全备份中，不会自动合并。会话和设备授权将失效，自动化暂停；须重新登录、配对和批准。' } else { '请先退出柜台。此操作可能暂停本地服务，完成后将按既有规则恢复。' }
        $answer = [Windows.Forms.MessageBox]::Show($warning, '确认维护', 'YesNo', 'Information')
        if ($answer -ne [Windows.Forms.DialogResult]::Yes) { return }
      }
      $script:EntryBusy = $true; $buttons.Enabled = $false; $recovery.Enabled = $false
      $backupList.Enabled = $false; $confirmation.Enabled = $false
      $output.Text = '正在执行，请等待操作结果……'; [Windows.Forms.Application]::DoEvents()
      $text = Invoke-RuntimeEntryAction $Verb $id $digest $inputJson
      $inputJson = $null
      $result = $text | ConvertFrom-Json
      $states = @{ running = '服务运行中'; stopped = '服务已停止'; initialized = '已初始化'; staged = '初始化未完成'; backups = '已读取备份'; maintenance_required = '维护中断，需要明确恢复'; diagnostic_exported = '已导出脱敏诊断包' }
      $status = if ($result.PSObject.Properties.Name -contains 'status') { [string]$result.status } else { '' }
      $description = if ($states.ContainsKey($status)) { $states[$status] } else { '操作完成，请查看状态确认' }
      $lines = New-Object 'Collections.Generic.List[string]'
      $lines.Add($description)
      if (@('backup-health','backup-schedule','scheduled-backup') -ccontains $Verb -and $result.status -ceq 'backup_health') {
        $lines.Add('自动备份：' + $(if ($result.config.enabled) { '已启用' } else { '已关闭' }))
        $lines.Add('每日时间：' + ('{0:00}:{1:00}' -f $result.config.hour, $result.config.minute))
        $lines.Add('可用空间：' + $result.free_mib + ' MiB')
        $messages = @{ low_space='剩余空间不足'; interrupted='上次备份中断，请明确恢复维护'; last_run_failed='上次备份失败'; backup_overdue='备份已超过预定间隔'; drill_overdue='恢复演练尚未完成或已逾期'; task_missing='自动备份任务缺失或被禁用，请重新保存设置'; task_unavailable='自动备份任务无法验证，请检查任务或重新保存设置' }
        foreach ($alert in $result.alerts) { $lines.Add('提醒：' + $messages[$alert]) }
        if ($null -ne $result.latest) { $lines.Add('最近执行：' + $result.latest.at + ' / ' + $result.latest.status); if ($result.latest.code) { $lines.Add('错误代码：' + $result.latest.code) } }
      }
      if ($Verb -ceq 'backup-drill') { $lines.Add('影子库恢复与照片一致性验证完成，当前业务数据保持原状。') }
      if (@('portable-export','portable-inspect','portable-import') -ccontains $Verb) {
        if ($result.PSObject.Properties.Name -contains 'path') { $lines.Add('文件：' + [string]$result.path) }
        $lines.Add('SHA256：' + [string]$result.sha256)
        $lines.Add('归档已加密；口令未写入命令行、日志或文件。恢复后须重新登录、配对设备和配置外部凭据。')
      }
      if ($Verb -ceq 'v1-import') { $lines.Add('已应用批准请求：' + [string]$result.request_id) }
      if ($Verb -ceq 'export-store') { $lines.Add('门店数据和照片已导出。请按清单校验后妥善保管。'); $lines.Add('目录：' + [string]$result.destination); $lines.Add('清单 SHA256：' + [string]$result.manifest_sha256) }
      if ($Verb -ceq 'diagnostics' -and $status -ceq 'diagnostic_exported') {
        $lines.Add('文件：' + [string]$result.path)
        $lines.Add('SHA256：' + [string]$result.sha256)
        $lines.Add('仅包含版本、服务、维护和备份摘要；不含顾客资料、密钥或原始日志。文件未上传。')
      }
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
      $inputJson = $null
      $script:EntryBusy = $false; $buttons.Enabled = $true; $recovery.Enabled = $true
      $backupList.Enabled = $true; $confirmation.Enabled = $true
    }
  }
  foreach ($entry in @(
    @('安装本地服务','install'), @('查看状态','status'), @('启动服务','start'), @('停止服务','stop'),
    @('修复服务','repair'), @('创建备份','backup'), @('查看备份','backup-list'),
    @('自动备份设置','backup-schedule'), @('备份提醒与记录','backup-health'), @('立即自动备份','scheduled-backup'),
    @('升级到本包','upgrade'), @('回滚程序','rollback'), @('继续中断维护','maintenance-recover'), @('导出诊断','diagnostics'),
    @('加密离机备份','portable-export'), @('校验离机备份','portable-inspect'), @('换机恢复','portable-import'), @('执行旧版导入','v1-import'), @('完整门店导出','export-store')
  )) {
    $button = New-Object Windows.Forms.Button; $button.Text = $entry[0]; $button.Tag = $entry[1]
    $button.AutoSize = $true; $button.Height = 34
    $button.add_Click({ & $run ([string]$this.Tag) })
    $buttons.Controls.Add($button)
  }
  foreach ($entry in @(@('校验所选备份','backup-verify'), @('恢复所选备份','restore'), @('演练所选备份','backup-drill'))) {
    $button = New-Object Windows.Forms.Button; $button.Text = $entry[0]; $button.Tag = $entry[1]
    $button.AutoSize = $true; $button.Height = 34
    $button.add_Click({ & $run ([string]$this.Tag) })
    $recovery.Controls.Add($button)
  }
  $form.add_FormClosing({ if ($script:EntryBusy) { $_.Cancel = $true } })
  try { [void]$form.ShowDialog() } finally { $form.Dispose() }
}

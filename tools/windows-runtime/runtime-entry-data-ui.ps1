function Show-RuntimeDataDialog {
  param([string]$Verb, [Windows.Forms.Form]$Owner, [string]$RequestId)
  $dialog = New-Object Windows.Forms.Form
  $dialog.Text = @{ 'portable-export'='加密离机备份'; 'portable-inspect'='校验离机备份'; 'portable-import'='换机恢复'; 'v1-import'='执行已批准的旧版导入'; 'export-store'='完整门店数据导出' }[$Verb]
  $dialog.ClientSize = New-Object Drawing.Size(650, 350)
  $dialog.StartPosition = 'CenterParent'; $dialog.FormBorderStyle = 'FixedDialog'
  $dialog.MaximizeBox = $false; $dialog.MinimizeBox = $false; $dialog.Font = $Owner.Font
  $note = New-Object Windows.Forms.Label
  $note.SetBounds(16, 14, 610, 60)
  $note.Text = if ($Verb -ceq 'v1-import') { '先在柜台“旧版数据迁移”完成上传、预检和管理员复核，复制批准请求编号，然后退出柜台。批准短时有效且只能使用一次。' } else { '离机副本包含完整业务数据与照片。使用至少 12 字节的独立口令并妥善保存；忘记口令无法恢复。恢复前先校验，再输入返回的完整摘要。' }
  if ($Verb -ceq 'export-store') { $note.Text = '先在柜台完成导出复核并复制批准请求编号，然后退出柜台。导出包含业务数据与照片，保存到新目录，请妥善保管。' }
  $dialog.Controls.Add($note)
  $pathLabel = New-Object Windows.Forms.Label; $pathLabel.SetBounds(16, 80, 600, 24)
  $pathLabel.Text = if ($Verb -ceq 'v1-import') { '批准请求编号' } else { '加密备份文件（.ldbackup）' }
  if ($Verb -ceq 'export-store') { $pathLabel.Text = '新建导出目录（完整绝对路径）' }
  $dialog.Controls.Add($pathLabel)
  $path = New-Object Windows.Forms.TextBox; $path.SetBounds(16, 108, 505, 28); $path.MaxLength = 240
  $dialog.Controls.Add($path)
  if ($Verb -ceq 'v1-import' -and $RequestId) { $path.Text = $RequestId }
  if ($Verb -cne 'v1-import' -and $Verb -cne 'export-store') {
    $browse = New-Object Windows.Forms.Button; $browse.SetBounds(531, 107, 96, 30); $browse.Text = '选择文件'
    $browse.add_Click({
      $picker = if ($Verb -ceq 'portable-export') { New-Object Windows.Forms.SaveFileDialog } else { New-Object Windows.Forms.OpenFileDialog }
      $picker.Filter = 'Laundry 加密备份 (*.ldbackup)|*.ldbackup'; $picker.DefaultExt = 'ldbackup'
      try { if ($picker.ShowDialog($dialog) -eq [Windows.Forms.DialogResult]::OK) { $path.Text = $picker.FileName } }
      finally { $picker.Dispose() }
    })
    $dialog.Controls.Add($browse)
  }
  if ($Verb -ceq 'export-store') {
    $browse = New-Object Windows.Forms.Button; $browse.SetBounds(531, 107, 96, 30); $browse.Text = '选择目录'
    $browse.add_Click({
      $picker = New-Object Windows.Forms.FolderBrowserDialog; $picker.Description = '选择存放导出的父目录；系统会创建一个新子目录。'
      try { if ($picker.ShowDialog($dialog) -eq [Windows.Forms.DialogResult]::OK) { $path.Text = [IO.Path]::Combine($picker.SelectedPath, 'Laundry-export-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss')) } }
      finally { $picker.Dispose() }
    }); $dialog.Controls.Add($browse)
  }
  $secretLabel = New-Object Windows.Forms.Label; $secretLabel.SetBounds(16, 148, 600, 24); $secretLabel.Text = '备份口令'
  $secret = New-Object Windows.Forms.TextBox; $secret.SetBounds(16, 175, 610, 28); $secret.UseSystemPasswordChar = $true; $secret.MaxLength = 256
  if ($Verb -ceq 'export-store' -and $RequestId) { $secret.Text = $RequestId }
  if ($Verb -ceq 'export-store') { $secretLabel.Text = '批准请求编号'; $secret.UseSystemPasswordChar = $false; $secret.MaxLength = 36 }
  $confirmLabel = New-Object Windows.Forms.Label; $confirmLabel.SetBounds(16, 216, 610, 24)
  $confirmLabel.Text = if ($Verb -ceq 'portable-import') { '输入校验结果的完整 64 位 SHA256 摘要' } else { '再次输入口令' }
  $confirmation = New-Object Windows.Forms.TextBox; $confirmation.SetBounds(16, 243, 610, 28)
  $confirmation.UseSystemPasswordChar = $Verb -ceq 'portable-export'
  if ($Verb -cne 'v1-import') { $dialog.Controls.Add($secretLabel); $dialog.Controls.Add($secret) }
  if ($Verb -ceq 'portable-import' -or $Verb -ceq 'portable-export') { $dialog.Controls.Add($confirmLabel); $dialog.Controls.Add($confirmation) }
  $ok = New-Object Windows.Forms.Button; $ok.SetBounds(420, 300, 100, 32); $ok.Text = '继续'
  $cancel = New-Object Windows.Forms.Button; $cancel.SetBounds(528, 300, 100, 32); $cancel.Text = '取消'; $cancel.DialogResult = 'Cancel'
  $dialog.Controls.Add($ok); $dialog.Controls.Add($cancel); $dialog.CancelButton = $cancel
  $ok.add_Click({
    if ($Verb -ceq 'v1-import') {
      if ($path.Text -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') { [void][Windows.Forms.MessageBox]::Show('请粘贴有效的批准请求编号。'); return }
      $value = @{ requestId = $path.Text }
    } elseif ($Verb -ceq 'export-store') {
      if (-not [IO.Path]::IsPathRooted($path.Text) -or $secret.Text -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') { [void][Windows.Forms.MessageBox]::Show('请输入新建目录的绝对路径和有效批准请求编号。'); return }
      $value = @{ destination = $path.Text; requestId = $secret.Text }
    } else {
      $length = [Text.Encoding]::UTF8.GetByteCount($secret.Text)
      if ($length -lt 12 -or $length -gt 256 -or -not [IO.Path]::IsPathRooted($path.Text)) { [void][Windows.Forms.MessageBox]::Show('请选择绝对文件路径，并输入 12–256 字节的口令。'); return }
      if ($Verb -ceq 'portable-export' -and $confirmation.Text -cne $secret.Text) { [void][Windows.Forms.MessageBox]::Show('两次口令不一致。'); return }
      $value = @{ path = $path.Text; password = $secret.Text }
      if ($Verb -ceq 'portable-import') {
        if ($confirmation.Text -cnotmatch '^[a-f0-9]{64}$') { [void][Windows.Forms.MessageBox]::Show('请先校验文件，再输入完整摘要。'); return }
        $value.confirmation = $confirmation.Text
      }
    }
    if ($Verb -cne 'portable-inspect' -and [Windows.Forms.MessageBox]::Show('请确认已退出柜台。系统将先保存安全点；换机恢复会使旧设备与会话失效，并要求重新配置 AI 和短信凭据。', '确认维护', 'YesNo', 'Warning') -ne [Windows.Forms.DialogResult]::Yes) { return }
    $dialog.Tag = $value | ConvertTo-Json -Compress
    $dialog.DialogResult = 'OK'; $dialog.Close()
  })
  try { if ($dialog.ShowDialog($Owner) -eq [Windows.Forms.DialogResult]::OK) { return [string]$dialog.Tag }; return $null }
  finally { $secret.Clear(); $confirmation.Clear(); $dialog.Tag = $null; $dialog.Dispose() }
}

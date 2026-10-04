function Show-RuntimeAssistanceDialog {
  param([Windows.Forms.Form]$Owner)
  $dialog = New-Object Windows.Forms.Form
  $dialog.Text = '受控远程协助 · 支持端配置'
  $dialog.ClientSize = New-Object Drawing.Size(700, 580)
  $dialog.StartPosition = 'CenterParent'; $dialog.FormBorderStyle = 'FixedDialog'
  $dialog.MaximizeBox = $false; $dialog.MinimizeBox = $false; $dialog.Font = $Owner.Font
  $note = New-Object Windows.Forms.Label; $note.SetBounds(16, 12, 668, 68)
  $note.Text = '由受信支持方提供 HTTPS 服务地址、接入令牌和身份签名公钥。保存时会暂停并恢复本机服务，使现有协助失效。每次协助仍须在柜台由管理员确认；不开放入站端口。'
  $dialog.Controls.Add($note)
  $enabled = New-Object Windows.Forms.CheckBox; $enabled.Text = '配置支持端（取消则关闭协助功能）'; $enabled.SetBounds(16, 85, 660, 30)
  $dialog.Controls.Add($enabled)
  $fields = @{}
  $names = @(@('broker_url','HTTPS 支持端地址'),@('broker_token','接入令牌'),@('issuer','身份签发者 Issuer'),@('audience','身份接收方 Audience'),@('kid','签名公钥编号'),@('public_key_spki','Ed25519 公钥 SPKI Base64'))
  $y = 126
  foreach ($pair in $names) {
    $label = New-Object Windows.Forms.Label; $label.Text = $pair[1]; $label.SetBounds(16, $y, 215, 26); $dialog.Controls.Add($label)
    $fieldControl = New-Object Windows.Forms.TextBox; $fieldControl.SetBounds(235, $y, 445, 28); $fieldControl.MaxLength = 2048
    if ($pair[0] -ceq 'broker_token') { $fieldControl.UseSystemPasswordChar = $true; $fieldControl.MaxLength = 256 }
    $fields[$pair[0]] = $fieldControl; $dialog.Controls.Add($fieldControl); $y += 57
  }
  $ok = New-Object Windows.Forms.Button; $ok.Text = '保存配置'; $ok.SetBounds(460, 523, 108, 34)
  $cancel = New-Object Windows.Forms.Button; $cancel.Text = '取消'; $cancel.SetBounds(576, 523, 108, 34); $cancel.DialogResult = 'Cancel'
  $dialog.Controls.Add($ok); $dialog.Controls.Add($cancel); $dialog.CancelButton = $cancel
  $ok.add_Click({
    $trust = $null
    if ($enabled.Checked) {
      $trust = @{ version = 1 }
      foreach ($pair in $names) { if ([string]::IsNullOrWhiteSpace($fields[$pair[0]].Text)) { [void][Windows.Forms.MessageBox]::Show('请完整填写支持端提供的配置。'); return }; $trust[$pair[0]] = $fields[$pair[0]].Text }
    }
    if ([Windows.Forms.MessageBox]::Show('请先退出柜台。保存后现有协助将中断，须重新登录并授权。', '确认配置', 'YesNo', 'Warning') -ne [Windows.Forms.DialogResult]::Yes) { return }
    $dialog.Tag = @{ trust = $trust } | ConvertTo-Json -Compress
    $dialog.DialogResult = 'OK'; $dialog.Close()
  })
  try { if ($dialog.ShowDialog($Owner) -eq [Windows.Forms.DialogResult]::OK) { return [string]$dialog.Tag }; return $null }
  finally { foreach ($field in $fields.Values) { $field.Clear() }; $dialog.Tag = $null; $dialog.Dispose() }
}

function ConvertTo-RuntimeStoreInput {
  param([object]$Admin, [object]$Approver)
  $people = @($Admin, $Approver)
  foreach ($person in $people) {
    if ($person.username -cnotmatch '^[A-Za-z0-9_.-]{1,64}$' -or
        $person.username -match '[\x00\r\n]' -or
        [string]::IsNullOrWhiteSpace($person.displayName) -or $person.displayName.Trim().Length -gt 80 -or $person.displayName -match '[\x00\r\n]' -or
        $person.password.Length -lt 12 -or $person.password.Length -gt 256 -or $person.password -match '[\x00\r\n]' -or
        $person.pin -cnotmatch '^[0-9]{6,8}$' -or $person.pin -match '[\x00\r\n]' -or $person.password -cne $person.passwordConfirmation -or $person.pin -cne $person.pinConfirmation) {
      throw 'WINDOWS_RUNTIME_ENTRY_STORE_INPUT_INVALID'
    }
  }
  if ($Admin.username -ceq $Approver.username -or $Admin.password -ceq $Approver.password -or $Admin.pin -ceq $Approver.pin) {
    throw 'WINDOWS_RUNTIME_ENTRY_STORE_IDENTITIES_NOT_INDEPENDENT'
  }
  $ownerInput = @{ username=$Admin.username; displayName=$Admin.displayName.Trim(); password=$Admin.password; pin=$Admin.pin }
  $reviewerInput = @{ username=$Approver.username; displayName=$Approver.displayName.Trim(); password=$Approver.password; pin=$Approver.pin }
  return (@{ version=1; mode='new_empty'; admin=$ownerInput; approver=$reviewerInput } | ConvertTo-Json -Depth 3 -Compress)
}

function Show-RuntimeStoreDialog {
  param([Windows.Forms.Form]$Owner)
  $dialog = New-Object Windows.Forms.Form
  $dialog.Text = '初始化全新空库 · 设置两位管理员'
  $dialog.ClientSize = New-Object Drawing.Size(760, 565)
  $dialog.StartPosition = 'CenterParent'; $dialog.FormBorderStyle = 'FixedDialog'
  $dialog.MaximizeBox = $false; $dialog.MinimizeBox = $false; $dialog.Font = $Owner.Font
  $note = New-Object Windows.Forms.Label; $note.SetBounds(16, 12, 730, 75)
  $note.Text = "只允许全新实例，不导入旧数据、不覆盖测试库。账号分别由两位操作者设置。`r`n当前仍是开发候选，只能使用合成数据；初始化完成不代表获准真实营业。`r`n密码至少 12 位，PIN 为 6–8 位数字；两人的账号、密码和 PIN 必须不同。"
  $dialog.Controls.Add($note)
  $fields = @('username','displayName','password','passwordConfirmation','pin','pinConfirmation')
  $labels = @('登录用户名','显示姓名','密码','再次输入密码','PIN','再次输入 PIN')
  $inputs = @()
  for ($personIndex = 0; $personIndex -lt 2; $personIndex++) {
    $group = New-Object Windows.Forms.GroupBox; $group.SetBounds((16 + 370 * $personIndex), 95, 355, 385)
    $group.Text = @('日常管理员','独立复核管理员')[$personIndex]
    $controls = @{}
    for ($fieldIndex = 0; $fieldIndex -lt $fields.Count; $fieldIndex++) {
      $label = New-Object Windows.Forms.Label; $label.SetBounds(12, (26 + 58 * $fieldIndex), 325, 24)
      $label.Text = $labels[$fieldIndex]; $group.Controls.Add($label)
      $box = New-Object Windows.Forms.TextBox; $box.SetBounds(12, (49 + 58 * $fieldIndex), 325, 27)
      $box.UseSystemPasswordChar = $fieldIndex -ge 2
      $box.MaxLength = @(64,80,256,256,8,8)[$fieldIndex]
      $group.Controls.Add($box); $controls[$fields[$fieldIndex]] = $box
    }
    $dialog.Controls.Add($group); $inputs += ,$controls
  }
  $ok = New-Object Windows.Forms.Button; $ok.SetBounds(475, 510, 150, 32); $ok.Text = '初始化全新空库'
  $cancel = New-Object Windows.Forms.Button; $cancel.SetBounds(635, 510, 105, 32)
  $cancel.Text = '取消'; $cancel.DialogResult = 'Cancel'
  $dialog.Controls.Add($ok); $dialog.Controls.Add($cancel); $dialog.CancelButton = $cancel
  $ok.add_Click({
    $request = $null
    try {
      $people = @($inputs | ForEach-Object {
        $values = @{}; foreach ($field in $fields) { $values[$field] = $_[$field].Text }; $values
      })
      $request = ConvertTo-RuntimeStoreInput $people[0] $people[1]
      if ([Windows.Forms.MessageBox]::Show('确认创建全新空库？已有实例会被拒绝，当前候选仍只允许合成测试。', '确认初始化', 'YesNo', 'Warning') -ne [Windows.Forms.DialogResult]::Yes) { return }
      $dialog.Tag = $request; $dialog.DialogResult = 'OK'; $dialog.Close()
    } catch {
      [void][Windows.Forms.MessageBox]::Show('请检查用户名、长密码、PIN 和两次输入；两位管理员的账号、密码和 PIN 必须不同。', '输入未通过')
    } finally { $request = $null; $people = $null }
  })
  try { if ($dialog.ShowDialog($Owner) -eq [Windows.Forms.DialogResult]::OK) { return [string]$dialog.Tag }; return $null }
  finally {
    foreach ($person in $inputs) { foreach ($box in $person.Values) { $box.Clear() } }
    $dialog.Tag = $null; $dialog.Dispose()
  }
}

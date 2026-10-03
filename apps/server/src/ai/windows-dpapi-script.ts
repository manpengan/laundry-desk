/** Fixed, non-interpolated bridge. Only framed binary DEKs travel on stdin/stdout. */
export const WINDOWS_DPAPI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = $null; $entropy = $null; $result = $null
try {
  $root = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
  if (-not [string]::Equals($root, 'C:\Windows', [StringComparison]::OrdinalIgnoreCase)) { throw 'root' }
  $trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $paths = @($root, "$root\System32", "$root\System32\WindowsPowerShell", "$root\System32\WindowsPowerShell\v1.0", "$root\System32\WindowsPowerShell\v1.0\powershell.exe")
  foreach ($path in $paths) {
    if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'link' }
    $item = if ([IO.Directory]::Exists($path)) { [IO.DirectoryInfo]::new($path) } else { [IO.FileInfo]::new($path) }
    $acl = $item.GetAccessControl()
    if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'owner' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
          ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
          ($rule.FileSystemRights -band 0xD0116) -ne 0 -and $trusted -notcontains $rule.IdentityReference.Value) { throw 'acl' }
    }
  }
  [void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
  $inputStream = [Console]::OpenStandardInput()
  $reader = [IO.BinaryReader]::new($inputStream)
  $operation = $reader.ReadByte()
  $entropy = $reader.ReadBytes(32)
  $length = $reader.ReadInt32()
  if ($entropy.Length -ne 32 -or $length -lt 16 -or $length -gt 16384 -or ($operation -ne 1 -and $operation -ne 2)) { throw 'frame' }
  if ($operation -eq 1 -and $length -ne 32) { throw 'key' }
  $data = $reader.ReadBytes($length)
  if ($data.Length -ne $length -or $inputStream.ReadByte() -ne -1) { throw 'frame' }
  if ($operation -eq 1) {
    $result = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  } else {
    $result = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  }
  if ($result.Length -lt 16 -or $result.Length -gt 16384 -or ($operation -eq 2 -and $result.Length -ne 32)) { throw 'result' }
  $outputStream = [Console]::OpenStandardOutput()
  $magic = [byte[]]@(76,68,75,49)
  $outputStream.Write($magic, 0, 4)
  $outputStream.Write($result, 0, $result.Length)
  $outputStream.Flush()
} catch { exit 1 } finally {
  foreach ($bytes in @($data, $entropy, $result)) {
    if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
  }
}
`;

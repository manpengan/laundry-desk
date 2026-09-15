# Closed command grammar for processes spawned by this Runtime. Paths may use the
# forward slashes produced by PostgreSQL canonicalize_path on Windows.
function Test-RuntimePath {
  param([string]$Actual, [string]$Expected)
  if ([string]::IsNullOrEmpty($Actual) -or -not [IO.Path]::IsPathRooted($Actual)) { return $false }
  try {
    return [StringComparer]::OrdinalIgnoreCase.Equals(
      [IO.Path]::GetFullPath($Actual.Replace('/', '\')),
      [IO.Path]::GetFullPath($Expected))
  } catch { return $false }
}

function Test-RuntimeCommand {
  param([string]$Command, [int]$Port, [string]$Executable, [string]$Entrypoint, [string]$DataRoot)
  if ([string]::IsNullOrWhiteSpace($Command) -or $Command.Length -gt 8192 -or
      $Command -notmatch '^(?:"[^"\r\n]*"|[^\s"]+)(?:\s+(?:"[^"\r\n]*"|[^\s"]+))*\s*$') { return $false }
  $tokens = @([regex]::Matches($Command, '"[^"\r\n]*"|[^\s"]+') | ForEach-Object { $_.Value.Trim('"') })
  if (-not (Test-RuntimePath $tokens[0] $Executable)) { return $false }
  if ($Port -eq 8787) {
    return $tokens.Count -eq 3 -and (Test-RuntimePath $tokens[1] $Entrypoint) -and $tokens[2] -ceq 'server'
  }
  if ($Port -eq 8543) {
    return $tokens.Count -eq 7 -and $tokens[1] -ceq '-D' -and
      (Test-RuntimePath $tokens[2] $DataRoot) -and $tokens[3] -ceq '-h' -and
      $tokens[4] -ceq '127.0.0.1' -and $tokens[5] -ceq '-p' -and $tokens[6] -ceq '8543'
  }
  return $false
}

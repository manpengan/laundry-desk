param([Parameter(Mandatory=$true)][ValidateSet('install','uninstall')][string]$Action)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_SHA -cnotmatch '^[a-f0-9]{40}$' -or
    $env:LAUNDRY_MANIFEST_SHA256 -cnotmatch '^[a-f0-9]{64}$') { throw 'COUNTER_CI_CONTEXT_REQUIRED' }
$entry = $env:LAUNDRY_WINDOWS_RUNTIME_ENTRY
$evidence = Get-Content -LiteralPath (Join-Path $entry 'release-evidence.json') -Raw | ConvertFrom-Json
if ($evidence.source_git_sha -cne $env:GITHUB_SHA -or $evidence.assurance -cne 'development_only' -or
    $evidence.manifest_sha256 -cne $env:LAUNDRY_MANIFEST_SHA256) { throw 'COUNTER_RUNTIME_SOURCE_MISMATCH' }
$runtime = Join-Path $env:LOCALAPPDATA 'laundry-desk-v2/runtime-companion'
$powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
if ($Action -ceq 'install') {
  if (Test-Path -LiteralPath $runtime) { throw 'COUNTER_RUNTIME_EXISTING_INSTALLATION' }
  # Record ownership before install so cleanup can stop a partially started CI runtime.
  "LAUNDRY_RUNTIME_PAIR_INSTALLED=true" >> $env:GITHUB_ENV
  $result = & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $entry 'runtime-entry.ps1') -Action install
  if ($LASTEXITCODE -ne 0) { throw 'COUNTER_RUNTIME_INSTALL_FAILED' }
  $report = $result | ConvertFrom-Json
  if ($report.status -cne 'running' -or $report.source_git_sha -cne $env:GITHUB_SHA -or
      $report.manifest_sha256 -cne $env:LAUNDRY_MANIFEST_SHA256) { throw 'COUNTER_RUNTIME_INSTALL_IDENTITY_INVALID' }
  "LAUNDRY_WINDOWS_RUNTIME_SECRETS_DIR=$(Join-Path $runtime 'secrets')" >> $env:GITHUB_ENV
} else {
  if ($env:LAUNDRY_RUNTIME_PAIR_INSTALLED -cne 'true') { throw 'COUNTER_RUNTIME_CLEANUP_OWNERSHIP_REQUIRED' }
  & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $entry 'payload/scripts/lifecycle-launch.ps1') -Action uninstall -Payload (Join-Path $entry 'payload') -ManifestDigest $env:LAUNDRY_MANIFEST_SHA256
  if ($LASTEXITCODE -ne 0) { throw 'COUNTER_RUNTIME_UNINSTALL_FAILED' }
}

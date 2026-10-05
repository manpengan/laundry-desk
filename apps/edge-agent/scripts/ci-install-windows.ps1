param([Parameter(Mandatory=$true)][ValidateSet('generic','hongfa')][string]$Profile)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or -not $env:RUNNER_TEMP -or $env:GITHUB_SHA -cnotmatch '^[a-f0-9]{40}$') { throw 'COUNTER_CI_CONTEXT_REQUIRED' }
$package = Split-Path -Parent $PSScriptRoot
$release = Join-Path $package "release/$Profile"
$installers = @(Get-ChildItem -LiteralPath $release -Filter '*-windows-x64-development-only.exe' -File)
if ($installers.Count -ne 1) { throw 'COUNTER_INSTALLER_AMBIGUOUS' }
$target = Join-Path $env:RUNNER_TEMP "counter-installed-$Profile"
if (Test-Path -LiteralPath $target) { throw 'COUNTER_INSTALL_TARGET_EXISTS' }
$process = Start-Process -FilePath $installers[0].FullName -ArgumentList @('/S', "/D=$target") -PassThru
if (-not $process.WaitForExit(120000)) { throw 'COUNTER_INSTALL_TIMEOUT' }
if ($process.ExitCode -ne 0) { throw 'COUNTER_INSTALL_FAILED' }
$name = if ($Profile -ceq 'generic') { 'laundry-desk V2.exe' } else { '宏发洗衣 V2（开发版）.exe' }
$installedExe = Join-Path $target $name
$sourceExe = Join-Path $release "win-unpacked/$name"
$files = @($name, 'resources/app.asar', 'resources/distribution-profile/binding.json')
$hashes = [ordered]@{}
foreach ($relative in $files) {
  $actual = (Get-FileHash -LiteralPath (Join-Path $target $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
  $expected = (Get-FileHash -LiteralPath (Join-Path $release "win-unpacked/$relative") -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -cne $expected) { throw 'COUNTER_INSTALLED_HASH_MISMATCH' }
  $hashes[$relative] = $actual
}
$binding = Get-Content -LiteralPath (Join-Path $target 'resources/distribution-profile/binding.json') -Raw | ConvertFrom-Json
if ($binding.source_git_sha -cne $env:GITHUB_SHA -or $binding.assurance -cne 'development_only') { throw 'COUNTER_SOURCE_BINDING_MISMATCH' }
$report = [ordered]@{ source_git_sha=$env:GITHUB_SHA; profile=$Profile; assurance='development_only'; installer_sha256=(Get-FileHash -LiteralPath $installers[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant(); installed=$hashes }
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $env:RUNNER_TEMP "counter-installed-$Profile.json") -Encoding UTF8
"LAUNDRY_WINDOWS_APP_ROOT=$target" >> $env:GITHUB_ENV
"LAUNDRY_WINDOWS_INSTALLED_EXE=$installedExe" >> $env:GITHUB_ENV

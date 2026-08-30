[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $PostgresArchive,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{64}$')]
  [string] $PostgresArchiveSha256,

  [string] $RepositoryRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName = 'LaundryDeskV2DevelopmentRuntime'
$RuntimeRelease = '0.1.0-win-dev'
$PostgresVersion = '16.15'
$PostgresPort = 8543
$ApiPort = 8787
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = Join-Path $PSScriptRoot '..\..'
}

function Invoke-Checked {
  param([string] $File, [string[]] $Arguments, [string] $FailureCode)
  & $File @Arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw $FailureCode }
}

function Invoke-Captured {
  param([string] $File, [string[]] $Arguments, [string] $FailureCode)
  $output = @(& $File @Arguments)
  if ($LASTEXITCODE -ne 0) { throw $FailureCode }
  return ($output -join "`n")
}

function Invoke-QuietNative {
  param([string] $File, [string[]] $Arguments)
  $renderedArguments = @($Arguments | ForEach-Object {
    if ($_.Contains('"') -or $_.Contains("`0") -or $_.Contains("`r") -or $_.Contains("`n")) {
      throw 'WINDOWS_RUNTIME_NATIVE_ARGUMENT_INVALID'
    }
    if ($_ -match '\s') { return '"' + $_ + '"' }
    return $_
  })
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $File
  $startInfo.Arguments = $renderedArguments -join ' '
  $startInfo.UseShellExecute = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) {
    throw 'WINDOWS_RUNTIME_NATIVE_PROCESS_INVALID'
  }
  try {
    $process.WaitForExit()
    return [int] $process.ExitCode
  } finally {
    $process.Dispose()
  }
}

function New-RandomBase64Url {
  param([int] $ByteCount = 32)
  $bytes = New-Object byte[] $ByteCount
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-RandomPin {
  $bytes = New-Object byte[] 4
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  $number = ([BitConverter]::ToUInt32($bytes, 0) % 900000) + 100000
  return $number.ToString([Globalization.CultureInfo]::InvariantCulture)
}

function New-RuntimeTaskSettings {
  return New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -DisallowHardTerminate `
    -StartWhenAvailable
}

$RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
$PostgresArchive = (Resolve-Path -LiteralPath $PostgresArchive).Path
if (-not (Test-Path -LiteralPath (Join-Path $RepositoryRoot 'pnpm-workspace.yaml'))) {
  throw 'WINDOWS_RUNTIME_REPOSITORY_INVALID'
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw 'WINDOWS_RUNTIME_LOCALAPPDATA_REQUIRED'
}
$StopScript = Join-Path $RepositoryRoot 'tools\windows-runtime\stop-development-runtime.ps1'
if (-not (Test-Path -LiteralPath $StopScript)) {
  throw 'WINDOWS_RUNTIME_STOP_SCRIPT_MISSING'
}

$pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
Push-Location $RepositoryRoot
try {
  Invoke-Checked $pnpm @('--filter', '@laundry/platform-fs', 'build') 'WINDOWS_RUNTIME_HELPER_BUILD_FAILED'
  Invoke-Checked $pnpm @('--filter', '@laundry/contracts', 'build') 'WINDOWS_RUNTIME_CONTRACTS_BUILD_FAILED'
  Invoke-Checked $pnpm @('--filter', '@laundry/domain', 'build') 'WINDOWS_RUNTIME_DOMAIN_BUILD_FAILED'
  Invoke-Checked $pnpm @('--filter', '@laundry/server', 'build') 'WINDOWS_RUNTIME_SERVER_BUILD_FAILED'
} finally {
  Pop-Location
}

$HelperRoot = Join-Path $RepositoryRoot 'packages\platform-fs\native\windows'
$Helper = Join-Path $HelperRoot 'laundry-windows-helper.exe'
$HelperDigest = "$Helper.sha256"
if (-not (Test-Path -LiteralPath $Helper) -or -not (Test-Path -LiteralPath $HelperDigest)) {
  throw 'WINDOWS_RUNTIME_HELPER_MISSING'
}
$expectedHelperDigest = [IO.File]::ReadAllText($HelperDigest).Trim()
$actualHelperDigest = (Get-FileHash -LiteralPath $Helper -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expectedHelperDigest -notmatch '^[0-9a-f]{64}$' -or $actualHelperDigest -ne $expectedHelperDigest) {
  throw 'WINDOWS_RUNTIME_HELPER_INTEGRITY_FAILED'
}

function Invoke-Helper {
  param([string[]] $Arguments, [string] $FailureCode)
  Invoke-Checked $Helper $Arguments $FailureCode
}

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
  Set-ScheduledTask -TaskName $TaskName -Settings (New-RuntimeTaskSettings) | Out-Null
  & $StopScript -RepositoryRoot $RepositoryRoot | Out-Host
}

function Ensure-PrivateDirectory {
  param([string] $Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
  Invoke-Helper @('secure-directory', $Path) 'WINDOWS_RUNTIME_DIRECTORY_SECURITY_FAILED'
  Invoke-Helper @('inspect-private-directory', $Path) 'WINDOWS_RUNTIME_DIRECTORY_SECURITY_FAILED'
}

function Write-PrivateText {
  param([string] $Path, [string] $Value)
  if ($Value.Length -eq 0 -or $Value.Contains("`0") -or $Value.Contains("`r") -or $Value.Contains("`n")) {
    throw 'WINDOWS_RUNTIME_SECRET_INVALID'
  }
  [IO.File]::WriteAllText($Path, $Value, $Utf8NoBom)
  Invoke-Helper @('secure-file', $Path) 'WINDOWS_RUNTIME_FILE_SECURITY_FAILED'
  Invoke-Helper @('inspect-private-file-links', $Path, '1') 'WINDOWS_RUNTIME_FILE_SECURITY_FAILED'
}

function Read-PrivateText {
  param([string] $Path)
  Invoke-Helper @('inspect-private-file-links', $Path, '1') 'WINDOWS_RUNTIME_FILE_SECURITY_FAILED'
  $value = [IO.File]::ReadAllText($Path)
  if ($value.Length -eq 0 -or $value.Contains("`0") -or $value.Contains("`r") -or $value.Contains("`n")) {
    throw 'WINDOWS_RUNTIME_SECRET_INVALID'
  }
  return $value
}

function Ensure-RandomSecret {
  param([string] $Path)
  if (Test-Path -LiteralPath $Path) { return Read-PrivateText $Path }
  $value = New-RandomBase64Url
  Write-PrivateText $Path $value
  return $value
}

function Ensure-ExactSecret {
  param([string] $Path, [string] $Value)
  if (Test-Path -LiteralPath $Path) {
    if ((Read-PrivateText $Path) -ne $Value) { throw 'WINDOWS_RUNTIME_SECRET_COLLISION' }
    return
  }
  Write-PrivateText $Path $Value
}

$RuntimeRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'laundry-desk-v2\development-runtime'))
$SecretsRoot = Join-Path $RuntimeRoot 'secrets'
$LogsRoot = Join-Path $RuntimeRoot 'logs'
Ensure-PrivateDirectory $RuntimeRoot
Ensure-PrivateDirectory $SecretsRoot
Ensure-PrivateDirectory $LogsRoot

$archiveItem = Get-Item -LiteralPath $PostgresArchive
if (-not $archiveItem.PSIsContainer -and -not ($archiveItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  $archiveDigest = (Get-FileHash -LiteralPath $PostgresArchive -Algorithm SHA256).Hash.ToLowerInvariant()
} else {
  throw 'WINDOWS_RUNTIME_POSTGRES_ARCHIVE_INVALID'
}
if ($archiveDigest -ne $PostgresArchiveSha256.ToLowerInvariant()) {
  throw 'WINDOWS_RUNTIME_POSTGRES_ARCHIVE_INTEGRITY_FAILED'
}

$PostgresReleaseRoot = Join-Path $RuntimeRoot "postgresql-$PostgresVersion"
$PostgresHome = Join-Path $PostgresReleaseRoot 'pgsql'
if (-not (Test-Path -LiteralPath $PostgresHome)) {
  $staging = Join-Path $RuntimeRoot ("postgresql-$PostgresVersion.staging-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $staging | Out-Null
  try {
    Expand-Archive -LiteralPath $PostgresArchive -DestinationPath $staging
    if (-not (Test-Path -LiteralPath (Join-Path $staging 'pgsql\bin\postgres.exe'))) {
      throw 'WINDOWS_RUNTIME_POSTGRES_ARCHIVE_LAYOUT_INVALID'
    }
    Move-Item -LiteralPath $staging -Destination $PostgresReleaseRoot
  } catch {
    if (Test-Path -LiteralPath $staging) {
      Remove-Item -LiteralPath $staging -Recurse -Force
    }
    throw
  }
}
Ensure-PrivateDirectory $PostgresReleaseRoot

$PostgresBin = Join-Path $PostgresHome 'bin'
$InitDb = Join-Path $PostgresBin 'initdb.exe'
$PgCtl = Join-Path $PostgresBin 'pg_ctl.exe'
$Psql = Join-Path $PostgresBin 'psql.exe'
$CreateDb = Join-Path $PostgresBin 'createdb.exe'
$Postgres = Join-Path $PostgresBin 'postgres.exe'
foreach ($binary in @($InitDb, $PgCtl, $Psql, $CreateDb, $Postgres)) {
  if (-not (Test-Path -LiteralPath $binary)) { throw 'WINDOWS_RUNTIME_POSTGRES_BINARY_MISSING' }
}
$postgresVersionOutput = Invoke-Captured $Postgres @('--version') 'WINDOWS_RUNTIME_POSTGRES_VERSION_FAILED'
if ($postgresVersionOutput -notmatch "^postgres \(PostgreSQL\) $([Regex]::Escape($PostgresVersion))$") {
  throw 'WINDOWS_RUNTIME_POSTGRES_VERSION_INVALID'
}

$SuperPasswordFile = Join-Path $SecretsRoot 'postgres-superuser-password'
$AppPasswordFile = Join-Path $SecretsRoot 'postgres-app-password'
$AccessSecretFile = Join-Path $SecretsRoot 'access-token-secret'
$CsrfSecretFile = Join-Path $SecretsRoot 'csrf-proof-secret'
$AdminUrlFile = Join-Path $SecretsRoot 'database-admin-url'
$AppUrlFile = Join-Path $SecretsRoot 'database-url'
$PgPassFile = Join-Path $SecretsRoot 'pgpass.conf'
$superPassword = Ensure-RandomSecret $SuperPasswordFile
$appPassword = Ensure-RandomSecret $AppPasswordFile
[void](Ensure-RandomSecret $AccessSecretFile)
[void](Ensure-RandomSecret $CsrfSecretFile)
$adminUrl = "postgresql://postgres:$superPassword@127.0.0.1:$PostgresPort/laundry_v2"
$appUrl = "postgresql://laundry_app:$appPassword@127.0.0.1:$PostgresPort/laundry_v2"
Ensure-ExactSecret $AdminUrlFile $adminUrl
Ensure-ExactSecret $AppUrlFile $appUrl
Ensure-ExactSecret $PgPassFile "127.0.0.1:$PostgresPort`:*:postgres:$superPassword"

$DataRoot = Join-Path $RuntimeRoot 'postgres-data'
$PgVersionFile = Join-Path $DataRoot 'PG_VERSION'
if (-not (Test-Path -LiteralPath $PgVersionFile)) {
  if ((Test-Path -LiteralPath $DataRoot) -and @(Get-ChildItem -LiteralPath $DataRoot -Force).Count -gt 0) {
    throw 'WINDOWS_RUNTIME_POSTGRES_DATA_PARTIAL'
  }
  Invoke-Checked $InitDb @(
    "--pgdata=$DataRoot",
    '--username=postgres',
    "--pwfile=$SuperPasswordFile",
    '--encoding=UTF8',
    '--locale=C',
    '--auth-host=scram-sha-256',
    '--auth-local=scram-sha-256',
    '--data-checksums'
  ) 'WINDOWS_RUNTIME_POSTGRES_INIT_FAILED'
  Ensure-PrivateDirectory $DataRoot
}

$pgStatus = Invoke-QuietNative $PgCtl @('status', "--pgdata=$DataRoot")
if ($pgStatus -ne 0) {
  $pgStatus = Invoke-QuietNative $PgCtl @(
    'start',
    "--pgdata=$DataRoot",
    "--log=$LogsRoot\postgres.log",
    '--options=-h 127.0.0.1 -p 8543',
    '--wait',
    '--timeout=60'
  )
  if ($pgStatus -ne 0) { throw 'WINDOWS_RUNTIME_POSTGRES_START_FAILED' }
}

$env:PGPASSFILE = $PgPassFile
$databaseExists = Invoke-Captured $Psql @(
  '--host=127.0.0.1',
  "--port=$PostgresPort",
  '--username=postgres',
  '--dbname=postgres',
  '--no-password',
  '--tuples-only',
  '--no-align',
  '--command=SELECT 1 FROM pg_database WHERE datname = ''laundry_v2'''
) 'WINDOWS_RUNTIME_POSTGRES_QUERY_FAILED'
if ($databaseExists.Trim() -ne '1') {
  Invoke-Checked $CreateDb @(
    '--host=127.0.0.1',
    "--port=$PostgresPort",
    '--username=postgres',
    '--no-password',
    'laundry_v2'
  ) 'WINDOWS_RUNTIME_DATABASE_CREATE_FAILED'
}

$CredentialsFile = Join-Path $RuntimeRoot 'operator-credentials.development-only.json'
if (Test-Path -LiteralPath $CredentialsFile) {
  Invoke-Helper @('inspect-private-file-links', $CredentialsFile, '1') 'WINDOWS_RUNTIME_FILE_SECURITY_FAILED'
  $credentials = [IO.File]::ReadAllText($CredentialsFile) | ConvertFrom-Json
} else {
  $adminPin = New-RandomPin
  do { $approverPin = New-RandomPin } while ($approverPin -eq $adminPin)
  $credentials = [pscustomobject][ordered]@{
    development_only = $true
    admin_username = 'owner-win-dev'
    admin_display_name = 'Windows Dev Owner'
    admin_password = 'admin-' + (New-RandomBase64Url 24)
    admin_pin = $adminPin
    approver_username = 'approver-win-dev'
    approver_display_name = 'Windows Dev Approver'
    approver_password = 'approver-' + (New-RandomBase64Url 24)
    approver_pin = $approverPin
  }
  [IO.File]::WriteAllText($CredentialsFile, ($credentials | ConvertTo-Json), $Utf8NoBom)
  Invoke-Helper @('secure-file', $CredentialsFile) 'WINDOWS_RUNTIME_FILE_SECURITY_FAILED'
}

$bootstrapFiles = [ordered]@{
  LAUNDRY_BOOTSTRAP_ADMIN_USERNAME = $credentials.admin_username
  LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME = $credentials.admin_display_name
  LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD = $credentials.admin_password
  LAUNDRY_BOOTSTRAP_ADMIN_PIN = $credentials.admin_pin
  LAUNDRY_BOOTSTRAP_APPROVER_USERNAME = $credentials.approver_username
  LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME = $credentials.approver_display_name
  LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD = $credentials.approver_password
  LAUNDRY_BOOTSTRAP_APPROVER_PIN = $credentials.approver_pin
}
foreach ($entry in $bootstrapFiles.GetEnumerator()) {
  $path = Join-Path $SecretsRoot ($entry.Key.ToLowerInvariant().Replace('_', '-'))
  Ensure-ExactSecret $path ([string] $entry.Value)
  Set-Item -Path "Env:$($entry.Key)_FILE" -Value $path
}

$MigrationsRoot = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot 'packages\db\src\migrations'))
$KitEntrypoint = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot 'apps\server\dist\runtime\kit-entrypoint.js'))
$env:LAUNDRY_RUNTIME_MIGRATIONS_DIR = $MigrationsRoot
$migrationInfo = Invoke-Captured $node @($KitEntrypoint, 'migration-info') 'WINDOWS_RUNTIME_MIGRATION_INFO_FAILED'
$migration = $migrationInfo | ConvertFrom-Json
if ($migration.migrations_sha256 -notmatch '^[0-9a-f]{64}$' -or
    $migration.migration_head -notmatch '^[0-9]{4}_[a-z0-9_]+\.sql$') {
  throw 'WINDOWS_RUNTIME_MIGRATION_INFO_INVALID'
}
$env:LAUNDRY_RUNTIME_RELEASE = $RuntimeRelease
$env:LAUNDRY_RUNTIME_CONTRACTS_SHA256 = (Get-FileHash -LiteralPath (Join-Path $RepositoryRoot 'packages\contracts\openapi\laundry-v2.openapi.json') -Algorithm SHA256).Hash.ToLowerInvariant()
$env:LAUNDRY_RUNTIME_SCHEMA_SHA256 = (Get-FileHash -LiteralPath (Join-Path $RepositoryRoot 'packages\db\src\README.md') -Algorithm SHA256).Hash.ToLowerInvariant()
$env:LAUNDRY_RUNTIME_MIGRATIONS_SHA256 = $migration.migrations_sha256
$env:LAUNDRY_RUNTIME_MIGRATION_HEAD = $migration.migration_head
$env:DATABASE_ADMIN_URL_FILE = $AdminUrlFile
$env:DATABASE_URL_FILE = $AppUrlFile
$env:LAUNDRY_APP_PASSWORD_FILE = $AppPasswordFile
$env:LAUNDRY_ACCESS_TOKEN_SECRET_FILE = $AccessSecretFile
$env:LAUNDRY_CSRF_PROOF_SECRET_FILE = $CsrfSecretFile

foreach ($command in @('roles', 'migrate', 'bootstrap', 'verify')) {
  Invoke-Checked $node @($KitEntrypoint, $command) "WINDOWS_RUNTIME_$($command.ToUpperInvariant())_FAILED"
}

$pgStatus = Invoke-QuietNative $PgCtl @(
  'stop',
  "--pgdata=$DataRoot",
  '--mode=fast',
  '--wait',
  '--timeout=60'
)
if ($pgStatus -ne 0) { throw 'WINDOWS_RUNTIME_POSTGRES_STOP_FAILED' }

$Launcher = Join-Path $RuntimeRoot 'start-development-runtime.cmd'
$ServerLog = Join-Path $LogsRoot 'server.log'
$launcherLines = @(
  '@echo off',
  'setlocal',
  'set "NODE_OPTIONS="',
  'set "NODE_PATH="',
  'set "LAUNDRY_CONTAINER_RUNTIME="',
  'set "LAUNDRY_LAN_ORIGIN="',
  'set "LAUNDRY_PUBLIC_ORIGIN="',
  'set "LAUNDRY_RUNTIME_LAN_BIND_HOST="',
  'set "LAUNDRY_PRINT_SPOOL_DIR="',
  'set "LAUNDRY_PHOTO_STORE_DIR="',
  "`"$PgCtl`" status --pgdata=`"$DataRoot`" >nul 2>&1 || `"$PgCtl`" start --pgdata=`"$DataRoot`" --log=`"$LogsRoot\postgres.log`" --options=`"-h 127.0.0.1 -p 8543`" --wait --timeout=60",
  'curl.exe --silent --fail --max-time 3 http://127.0.0.1:8787/health >nul 2>&1 && exit /b 0',
  "set `"NODE_ENV=production`"",
  "set `"LAUNDRY_RUNTIME_RELEASE=$RuntimeRelease`"",
  "set `"LAUNDRY_RUNTIME_CONTRACTS_SHA256=$($env:LAUNDRY_RUNTIME_CONTRACTS_SHA256)`"",
  "set `"LAUNDRY_RUNTIME_SCHEMA_SHA256=$($env:LAUNDRY_RUNTIME_SCHEMA_SHA256)`"",
  "set `"LAUNDRY_RUNTIME_MIGRATIONS_SHA256=$($env:LAUNDRY_RUNTIME_MIGRATIONS_SHA256)`"",
  "set `"LAUNDRY_RUNTIME_MIGRATION_HEAD=$($env:LAUNDRY_RUNTIME_MIGRATION_HEAD)`"",
  "set `"LAUNDRY_RUNTIME_MIGRATIONS_DIR=$MigrationsRoot`"",
  "set `"DATABASE_URL_FILE=$AppUrlFile`"",
  "set `"LAUNDRY_ACCESS_TOKEN_SECRET_FILE=$AccessSecretFile`"",
  "set `"LAUNDRY_CSRF_PROOF_SECRET_FILE=$CsrfSecretFile`"",
  'set "LAUNDRY_NOTIFICATION_PROVIDER_MODE=disabled"',
  "`"$node`" `"$KitEntrypoint`" server >> `"$ServerLog`" 2>&1",
  'set "LAUNDRY_SERVER_EXIT=%ERRORLEVEL%"',
  "`"$PgCtl`" stop --pgdata=`"$DataRoot`" --mode=fast --wait --timeout=60 >> `"$LogsRoot\postgres.log`" 2>&1",
  'if errorlevel 1 exit /b 1',
  'exit /b %LAUNDRY_SERVER_EXIT%'
)
[IO.File]::WriteAllText($Launcher, (($launcherLines -join "`r`n") + "`r`n"), $Utf8NoBom)
Invoke-Helper @('secure-file', $Launcher) 'WINDOWS_RUNTIME_FILE_SECURITY_FAILED'

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument "/d /c `"`"$Launcher`"`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-RuntimeTaskSettings
Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

$ready = $false
for ($attempt = 0; $attempt -lt 45; $attempt += 1) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/health" -TimeoutSec 2
    if ($health.ok -eq $true -and $health.data.status -eq 'ready') {
      $ready = $true
      break
    }
  } catch {
    Start-Sleep -Seconds 2
  }
}
if (-not $ready) { throw 'WINDOWS_RUNTIME_HEALTH_TIMEOUT' }

[pscustomobject]@{
  Status = 'ready'
  RuntimeRelease = $RuntimeRelease
  RuntimeRoot = $RuntimeRoot
  PostgresVersion = $PostgresVersion
  PostgresPort = $PostgresPort
  ApiUrl = "http://127.0.0.1:$ApiPort"
  ScheduledTask = $TaskName
  OperatorCredentials = $CredentialsFile
  StopScript = $StopScript
}

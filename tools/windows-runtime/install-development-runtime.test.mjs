import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = join(repositoryRoot, "tools/windows-runtime/install-development-runtime.ps1");
const stopScriptPath = join(repositoryRoot, "tools/windows-runtime/stop-development-runtime.ps1");

test("development runtime installs a real loopback PostgreSQL and Fastify lifecycle", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.match(source, /PostgresArchiveSha256/u);
  assert.match(source, /Join-Path \$PSScriptRoot '\.\.\\\.\.'/u);
  assert.match(source, /Get-FileHash[^\n]+PostgresArchive/u);
  assert.match(source, /--auth-host=scram-sha-256/u);
  assert.match(source, /--data-checksums/u);
  assert.match(source, /--options=-h 127\.0\.0\.1 -p 8543/u);
  assert.match(source, /kit-entrypoint\.js/u);
  assert.match(source, /@\('roles', 'migrate', 'bootstrap', 'verify'\)/u);
  assert.match(source, /Register-ScheduledTask/u);
  assert.match(source, /DisallowHardTerminate/u);
  assert.match(source, /Set-ScheduledTask[^\n]+New-RuntimeTaskSettings/u);
  assert.match(source, /& \$StopScript -RepositoryRoot \$RepositoryRoot/u);
  assert.match(source, /stop --pgdata=.*--mode=fast --wait --timeout=60/u);
  assert.match(source, /stop-development-runtime\.ps1/u);
  assert.match(source, /\[System\.Diagnostics\.Process\]::Start/u);
  assert.match(source, /\.UseShellExecute = \$true/u);
  assert.match(source, /\.WaitForExit\(\)/u);
  assert.match(source, /\.Dispose\(\)/u);
  assert.doesNotMatch(source, /Start-Process/u);
  assert.doesNotMatch(source, /& \$File @Arguments > \$null 2>&1/u);
  assert.match(source, /http:\/\/127\.0\.0\.1:\$ApiPort\/health/u);
  for (const name of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "LAUNDRY_CONTAINER_RUNTIME",
    "LAUNDRY_LAN_ORIGIN",
    "LAUNDRY_PUBLIC_ORIGIN",
    "LAUNDRY_RUNTIME_LAN_BIND_HOST",
    "LAUNDRY_PRINT_SPOOL_DIR",
    "LAUNDRY_PHOTO_STORE_DIR",
  ]) {
    assert.match(source, new RegExp(`set "${name}="`, "u"));
  }
  assert.doesNotMatch(source, /ServiceGate|status\s*=\s*'ready'\s*#|SQLite/iu);
});

test("development secrets inherit a protected DACL and never enter source constants", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.match(source, /Ensure-PrivateDirectory \$SecretsRoot/u);
  assert.match(source, /inspect-private-file-links/u);
  assert.match(source, /New-RandomBase64Url/u);
  assert.match(source, /DATABASE_URL_FILE/u);
  assert.match(source, /LAUNDRY_ACCESS_TOKEN_SECRET_FILE/u);
  assert.doesNotMatch(source, /password\s*=\s*['"][^'"]{12,}['"]/iu);
  assert.doesNotMatch(source, /postgresql:\/\/[^:$]+:[^$]/u);
});

test("development runtime stops the server before PostgreSQL without hard-terminating the task", async () => {
  const source = await readFile(stopScriptPath, "utf8");

  assert.match(source, /Disable-ScheduledTask/u);
  assert.match(source, /Join-Path \$PSScriptRoot '\.\.\\\.\.'/u);
  assert.match(source, /Get-NetTCPConnection/u);
  assert.match(source, /Stop-Process/u);
  assert.match(source, /--mode=fast/u);
  assert.match(source, /\[System\.Diagnostics\.Process\]::Start/u);
  assert.match(source, /\.UseShellExecute = \$true/u);
  assert.match(source, /\.WaitForExit\(\)/u);
  assert.match(source, /\.Dispose\(\)/u);
  assert.doesNotMatch(source, /Start-Process/u);
  assert.doesNotMatch(source, /& \$File @Arguments > \$null 2>&1/u);
  assert.match(source, /Enable-ScheduledTask/u);
  assert.match(source, /taskWasDisabled/u);
  assert.doesNotMatch(source, /Stop-ScheduledTask/u);
});

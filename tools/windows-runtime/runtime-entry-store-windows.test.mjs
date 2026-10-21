import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const windowsOnly = { skip: process.platform !== "win32", timeout: 45000 };
const ui = fileURLToPath(new URL("runtime-entry-store-ui.ps1", import.meta.url));

async function runPowerShell(t, source, input = {}) {
  const folder = await mkdtemp(join(await realpath(tmpdir()), "ld-store-ui-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const script = join(folder, "probe.ps1");
  const helper = join(folder, "runtime-entry-store-ui.ps1");
  const local = join(folder, "local");
  await mkdir(local);
  // Match the generated operator package's UTF-8 BOM for Windows PowerShell 5.1.
  await writeFile(helper, `\ufeff${await readFile(ui, "utf8")}`, "utf8");
  await writeFile(
    script,
    `\ufeff$ErrorActionPreference='Stop'\nSet-StrictMode -Version Latest\n${source}`,
    "utf8",
  );
  const child = spawn(
    join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-STA", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    {
      env: { ...process.env, LOCALAPPDATA: local, LAUNDRY_STORE_UI: helper },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return new Promise((resolve, reject) => {
    const output = [],
      errors = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("STORE_UI_TEST_TIMEOUT"));
    }, 30000);
    const collect = (target) => (bytes) => {
      size += bytes.length;
      if (size > 65536) {
        child.kill();
        reject(new Error("STORE_UI_TEST_OUTPUT_LIMIT"));
      } else target.push(bytes);
    };
    child.stdout.on("data", collect(output));
    child.stderr.on("data", collect(errors));
    child.once("error", reject);
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(output).toString("utf8"),
        stderr: Buffer.concat(errors).toString("utf8"),
        local,
      });
    });
    child.stdin.end(Buffer.from(JSON.stringify(input)));
  });
}

function people() {
  return [
    {
      username: "synthetic-owner",
      displayName: "合成店长",
      password: "Synthetic-owner-only",
      passwordConfirmation: "Synthetic-owner-only",
      pin: "832714",
      pinConfirmation: "832714",
    },
    {
      username: "synthetic-reviewer",
      displayName: "合成复核员",
      password: "Synthetic-reviewer-only",
      passwordConfirmation: "Synthetic-reviewer-only",
      pin: "581927",
      pinConfirmation: "581927",
    },
  ];
}

test(
  "WinPS 5 store form requires matching secrets and independent identities without emitting them",
  windowsOnly,
  async (t) => {
    const variants = [
      people(),
      ...[
        { passwordConfirmation: "different-confirmation" },
        { pinConfirmation: "111111" },
        { username: "bad/name" },
        { username: "synthetic-owner" },
        { password: "Synthetic-owner-only", passwordConfirmation: "Synthetic-owner-only" },
        { pin: "832714", pinConfirmation: "832714" },
        { pin: "１２３４５６", pinConfirmation: "１２３４５６" },
      ].map((changed) => [people()[0], { ...people()[1], ...changed }]),
    ];
    const result = await runPowerShell(
      t,
      `
Add-Type -AssemblyName System.Windows.Forms
. $env:LAUNDRY_STORE_UI
$reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), (New-Object Text.UTF8Encoding($false,$true)))
$requests = $reader.ReadToEnd() | ConvertFrom-Json
$results = @()
foreach ($people in $requests) {
  try {
    $json = ConvertTo-RuntimeStoreInput $people[0] $people[1]
    $parsed = $json | ConvertFrom-Json
    if ($parsed.version -ne 1 -or $parsed.mode -cne 'new_empty' -or @($parsed.PSObject.Properties.Name).Count -ne 4 -or @($parsed.admin.PSObject.Properties.Name).Count -ne 4) { throw 'UNEXPECTED_WIRE_FORMAT' }
    $results += 'valid'
  } catch {
    $code = $_.Exception.GetBaseException().Message
    if ($code -cnotmatch '^WINDOWS_RUNTIME_ENTRY_STORE_[A-Z_]+$') { throw 'STORE_TEST_UNEXPECTED_FAILURE' }
    $results += $code
  } finally { $json=$null; $parsed=$null }
}
[Console]::Out.WriteLine(($results | ConvertTo-Json -Compress))
`,
      variants,
    );
    assert.equal(result.code, 0, result.stderr);
    const statuses = JSON.parse(result.stdout);
    assert.equal(statuses[0], "valid");
    assert.equal(
      statuses.slice(1).every((value) => value.startsWith("WINDOWS_RUNTIME_ENTRY_STORE_")),
      true,
    );
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /Synthetic-|832714|581927|synthetic-owner|合成/u,
    );
  },
);

test(
  "WinPS existing root refusal occurs before operator installation, for both files and directories",
  windowsOnly,
  async (t) => {
    const entry = await readFile(new URL("runtime-entry.ps1", import.meta.url), "utf8");
    const invoke = entry.slice(
      entry.indexOf("function Invoke-RuntimeEntryAction"),
      entry.indexOf("\ntry {\n  if (($PSBoundParameters"),
    );
    assert.ok(invoke.includes("Install-RuntimeEntry"));
    const result = await runPowerShell(
      t,
      `
function Assert-EntryArguments { }
$script:installed = 0
function Install-RuntimeEntry { $script:installed++; throw 'INSTALL_MUST_NOT_RUN' }
${invoke}
$parent=Join-Path $env:LOCALAPPDATA 'laundry-desk-v2'
[void][IO.Directory]::CreateDirectory($parent)
$root=Join-Path $parent 'runtime-companion'
foreach ($kind in @('file','directory')) {
  if ($kind -ceq 'file') { [IO.File]::WriteAllText($root,'retained') }
  else { [void][IO.Directory]::CreateDirectory($root) }
  try { Invoke-RuntimeEntryAction 'install-store' '' '' '{}'; throw 'EXISTING_ROOT_ACCEPTED' }
  catch { if ($_.Exception.GetBaseException().Message -cne 'WINDOWS_COMPANION_STORE_REQUIRES_NEW_INSTANCE') { throw } }
  if ($kind -ceq 'file') { if ([IO.File]::ReadAllText($root) -cne 'retained') { throw 'EXISTING_ROOT_CHANGED' }; [IO.File]::Delete($root) }
  else { [IO.Directory]::Delete($root) }
}
if ($script:installed -ne 0) { throw 'OPERATOR_INSTALL_RAN' }
[Console]::Out.WriteLine('EXISTING_ROOT_PRESERVED')
`,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "EXISTING_ROOT_PRESERVED");
  },
);

test(
  "WinPS store dialog masks passwords and PINs; cancel clears all input and creates no instance",
  windowsOnly,
  async (t) => {
    const result = await runPowerShell(
      t,
      `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. $env:LAUNDRY_STORE_UI
$owner=New-Object Windows.Forms.Form
$script:boxes=@(); $script:maskCount=0; $script:timerError=$null
$timer=New-Object Windows.Forms.Timer
$timer.Interval=200
$timer.add_Tick({
  $timer.Stop()
  try {
    $dialog=@([Windows.Forms.Application]::OpenForms | Where-Object { $_ -ne $owner })[0]
    foreach ($group in @($dialog.Controls | Where-Object { $_ -is [Windows.Forms.GroupBox] })) {
      foreach ($box in @($group.Controls | Where-Object { $_ -is [Windows.Forms.TextBox] })) {
        $script:boxes += $box
        if ($box.UseSystemPasswordChar) { $script:maskCount++ }
        $box.Text='Synthetic-cancel-only'
      }
    }
    $dialog.CancelButton.PerformClick()
  } catch { $script:timerError='DIALOG_CANCEL_FAILED'; foreach ($form in @([Windows.Forms.Application]::OpenForms)) { $form.Close() } }
})
try {
  $timer.Start()
  $value=Show-RuntimeStoreDialog $owner
  if ($null -ne $script:timerError) { throw $script:timerError }
  if ($null -ne $value -or $script:boxes.Count -ne 12 -or $script:maskCount -ne 8) { throw 'DIALOG_INPUT_NOT_MASKED_OR_CANCELLED' }
  if (@($script:boxes | Where-Object { $_.Text.Length -ne 0 }).Count -ne 0) { throw 'DIALOG_INPUT_RETAINED' }
  if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'laundry-desk-v2')) { throw 'CANCEL_CREATED_INSTANCE' }
  [Console]::Out.WriteLine('MASK_AND_CANCEL_OK')
} finally { $timer.Dispose(); $owner.Dispose() }
`,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "MASK_AND_CANCEL_OK");
  },
);

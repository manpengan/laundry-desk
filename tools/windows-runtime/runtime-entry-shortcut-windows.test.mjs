import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cleanEnvironment } from "./lifecycle-environment.mjs";
import { packageRuntimeEntry } from "./package-runtime-entry.mjs";
import { runtimeEntryFixture } from "./runtime-entry-test-fixture.mjs";

const execute = promisify(execFile);
const sourceRoot = dirname(fileURLToPath(import.meta.url));
// The rejection case invokes six separately bounded PowerShell processes.
const windowsOnly = { skip: process.platform !== "win32", timeout: 360000 };
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const shortcutName = (fixture) =>
  `Laundry Runtime V2 安装与维护 (${fixture.manifestSha.slice(0, 12)}).lnk`;

async function runScript(fixture, id, script, environment = {}) {
  const runner = join(fixture.root, `${id}.ps1`);
  const installer = join(fixture.root, `${id}-installer.ps1`);
  // Match the generated package's UTF-8 BOM; WinPS 5.1 otherwise decodes source using its ACP.
  await writeFile(
    installer,
    Buffer.from("\uFEFF" + (await readFile(join(sourceRoot, "runtime-entry-install.ps1"), "utf8"))),
    { flag: "wx" },
  );
  await writeFile(
    runner,
    Buffer.from(`\uFEFF$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
Set-StrictMode -Version Latest
try {
  . ${quote(join(sourceRoot, "runtime-entry-trust.ps1"))}
  . ${quote(join(sourceRoot, "runtime-entry-shortcut.ps1"))}
  . ${quote(installer)}
  $BoundManifest=${quote(fixture.manifestSha)}
  ${script}
} catch {
  [Console]::Error.WriteLine('SHORTCUT_REGRESSION_FAILED')
  exit 1
} finally { [LaundryRuntimeEntryTrust]::ReleaseDirectories() }
`),
    { flag: "wx" },
  );
  const result = await execute(
    join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner],
    {
      env: { ...cleanEnvironment(), ...environment },
      windowsHide: true,
      maxBuffer: 65536,
      timeout: 60000,
    },
  );
  assert.equal(result.stderr.trim(), "");
  return JSON.parse(result.stdout);
}

test(
  "installation preserves Chinese shortcut filename, parent paths and persisted wide fields",
  windowsOnly,
  async (t) => {
    const fixture = await runtimeEntryFixture(t);
    await packageRuntimeEntry(fixture);
    const local = join(fixture.root, "L用户"),
      roaming = join(fixture.root, "漫游"),
      user = join(fixture.root, "用户");
    const menu = join(roaming, "Microsoft/Windows/Start Menu/Programs");
    const desktop = join(user, "Desktop");
    for (const path of [local, menu, desktop]) await mkdir(path, { recursive: true });
    const environment = { LOCALAPPDATA: local, APPDATA: roaming, USERPROFILE: user };
    const installed = join(local, "Programs/Laundry Desk Runtime V2", fixture.manifestSha);
    const report = await runScript(
      fixture,
      "unicode-install",
      `. ${quote(join(fixture.output, "runtime-entry.ps1"))} -Action install`,
      environment,
    );
    assert.equal(report.action, "install");
    const directory = join(menu, "Laundry Desk Runtime V2"),
      path = join(directory, shortcutName(fixture));
    assert.deepEqual(await readdir(directory), [shortcutName(fixture)]);
    assert.deepEqual(await readdir(desktop), [shortcutName(fixture)]);
    const bytes = await readFile(path);
    const fields = await runScript(
      fixture,
      "unicode-readback",
      `[void][LaundryRuntimeEntryTrust]::HoldDirectoryPath(${quote(directory)})
  $shortcut=[LaundryRuntimeUnicodeShortcut]::new(${quote(path)})
  try {
    $powershell=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    $arguments='-NoProfile -STA -ExecutionPolicy Bypass -File "'+${quote(join(installed, "runtime-entry.ps1"))}+'"'
    [ordered]@{ existed=$shortcut.Existed; target=($shortcut.TargetPath -ceq $powershell);
      arguments=($shortcut.Arguments -ceq $arguments); working_directory=($shortcut.WorkingDirectory -ceq ${quote(installed)});
      description=($shortcut.Description -ceq '独立本地服务的安装、状态与备份恢复（开发合成数据）') }|ConvertTo-Json -Compress
  } finally { $shortcut.Dispose() }`,
    );
    assert.equal(
      Object.values(fields).every((value) => value === true),
      true,
    );
    const repeated = await runScript(
      fixture,
      "unicode-repeat",
      `. ${quote(join(installed, "runtime-entry.ps1"))} -Action install`,
      environment,
    );
    assert.equal(repeated.action, "install");
    assert.deepEqual(await readFile(path), bytes);
  },
);

test(
  "unknown, corrupt, oversized and linked shortcuts are rejected with original bytes preserved",
  windowsOnly,
  async (t) => {
    const fixture = await runtimeEntryFixture(t);
    const sentinel = Buffer.from("unrelated user shortcut\n");
    for (const kind of ["unknown", "corrupt", "oversized", "hardlink", "junction", "directory"]) {
      const directory = join(fixture.root, kind);
      await mkdir(directory);
      const path = join(directory, shortcutName(fixture));
      let original = sentinel;
      if (kind === "corrupt") {
        original = Buffer.alloc(76);
        original.writeUInt32LE(76);
        Buffer.from("0114020000000000c000000000000046", "hex").copy(original, 4);
      } else if (kind === "oversized") original = Buffer.alloc(1048577, 0x41);
      const target = join(fixture.root, `${kind}-original`);
      if (["junction", "directory"].includes(kind)) {
        await mkdir(target);
        await writeFile(join(target, "sentinel.txt"), sentinel, { flag: "wx" });
        if (kind === "junction") await symlink(target, path, "junction");
        else {
          await mkdir(path);
          await writeFile(join(path, "sentinel.txt"), sentinel, { flag: "wx" });
        }
      } else {
        await writeFile(path, original, { flag: "wx" });
        if (kind === "hardlink") await link(path, target);
      }
      const report = await runScript(
        fixture,
        `reject-${kind}`,
        `$code=$null
  try { Set-RuntimeEntryShortcut ${quote(directory)} ${quote(fixture.root)} }
  catch { $code=[string]($_.Exception.GetBaseException().Message) }
  @{ rejected=($code -ceq 'WINDOWS_RUNTIME_ENTRY_SHORTCUT_CONFLICT') }|ConvertTo-Json -Compress`,
      );
      assert.equal(report.rejected, true, kind);
      if (["junction", "directory"].includes(kind))
        assert.deepEqual(await readFile(join(path, "sentinel.txt")), sentinel);
      else assert.deepEqual(await readFile(path), original);
    }
  },
);

test(
  "CreateNew refuses a file created between shortcut probing and saving",
  windowsOnly,
  async (t) => {
    const fixture = await runtimeEntryFixture(t);
    const directory = join(fixture.root, "并发");
    await mkdir(directory);
    const path = join(directory, shortcutName(fixture));
    const report = await runScript(
      fixture,
      "concurrent-create",
      `[void][LaundryRuntimeEntryTrust]::HoldDirectoryPath(${quote(directory)})
  $shortcut=[LaundryRuntimeUnicodeShortcut]::new(${quote(path)})
  try {
    $shortcut.TargetPath=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    $shortcut.Arguments='-NoProfile'; $shortcut.WorkingDirectory=${quote(directory)}
    [IO.File]::WriteAllBytes(${quote(path)},[Text.Encoding]::UTF8.GetBytes('created in concurrent window'))
    $rejected=$false
    try { $shortcut.Save() } catch { $rejected=$_.Exception.GetBaseException() -is [IO.IOException] }
    @{ rejected=$rejected }|ConvertTo-Json -Compress
  } finally { $shortcut.Dispose() }`,
    );
    assert.equal(report.rejected, true);
    assert.equal(await readFile(path, "utf8"), "created in concurrent window");
  },
);

test(
  "existing shortcut validation holds its nofollow handle against mutation until disposal",
  windowsOnly,
  async (t) => {
    const fixture = await runtimeEntryFixture(t);
    const directory = join(fixture.root, "持有");
    await mkdir(directory);
    const path = join(directory, shortcutName(fixture));
    await runScript(
      fixture,
      "create-held-link",
      `Set-RuntimeEntryShortcut ${quote(directory)} ${quote(fixture.root)}
  @{ created=$true }|ConvertTo-Json -Compress`,
    );
    const original = await readFile(path);
    const report = await runScript(
      fixture,
      "validate-held-link",
      `[void][LaundryRuntimeEntryTrust]::HoldDirectoryPath(${quote(directory)})
  $shortcut=[LaundryRuntimeUnicodeShortcut]::new(${quote(path)})
  try {
    $writeRejected=$false; $moveRejected=$false
    try { [IO.File]::WriteAllText(${quote(path)},'changed') } catch { $writeRejected=$true }
    try { [IO.File]::Move(${quote(path)},${quote(join(directory, "changed.lnk"))}) } catch { $moveRejected=$true }
    @{ write_rejected=$writeRejected; move_rejected=$moveRejected }|ConvertTo-Json -Compress
  } finally { $shortcut.Dispose() }`,
    );
    assert.equal(report.write_rejected, true);
    assert.equal(report.move_rejected, true);
    assert.deepEqual(await readFile(path), original);
  },
);

test(
  "a junction in shortcut ancestors is rejected before any target directory write",
  windowsOnly,
  async (t) => {
    const fixture = await runtimeEntryFixture(t);
    const real = join(fixture.root, "real-menu"),
      alias = join(fixture.root, "菜单");
    await mkdir(real);
    const sentinel = join(real, "sentinel.txt");
    await writeFile(sentinel, "unrelated directory", { flag: "wx" });
    await symlink(real, alias, "junction");
    const report = await runScript(
      fixture,
      "ancestor-junction",
      `$code=$null
  try { Set-RuntimeEntryShortcut ${quote(alias)} ${quote(fixture.root)} }
  catch { $code=[string]($_.Exception.GetBaseException().Message) }
  @{ rejected=($code -ceq 'WINDOWS_RUNTIME_ENTRY_INTEGRITY_FAILED') }|ConvertTo-Json -Compress`,
    );
    assert.equal(report.rejected, true);
    assert.deepEqual(await readdir(real), ["sentinel.txt"]);
    assert.equal(await readFile(sentinel, "utf8"), "unrelated directory");
  },
);

test(
  "shortcut serialization rejects oversized, negative and overflowing stream operations before growth",
  windowsOnly,
  async (t) => {
    const fixture = await runtimeEntryFixture(t);
    const report = await runScript(
      fixture,
      "bounded-stream",
      `$stream=[LaundryRuntimeUnicodeShortcut+BoundedStream]::new()
  try {
    $count=0
    try { $stream.SetSize(1048577) } catch { $count++ }
    try { $stream.Seek([long]::MaxValue,0,[IntPtr]::Zero) } catch { $count++ }
    try { $stream.Seek(-1,0,[IntPtr]::Zero) } catch { $count++ }
    try { $stream.Write((New-Object byte[] 1048577),1048577,[IntPtr]::Zero) } catch { $count++ }
    $stat=New-Object Runtime.InteropServices.ComTypes.STATSTG
    $stream.Stat([ref]$stat,1)
    @{ rejected=$count; empty=($stat.cbSize -eq 0) }|ConvertTo-Json -Compress
  } finally { $stream.Dispose() }`,
    );
    assert.equal(report.rejected, 4);
    assert.equal(report.empty, true);
  },
);

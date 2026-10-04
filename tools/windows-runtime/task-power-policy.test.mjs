import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (name) => readFile(new URL(name, import.meta.url), "utf8");

test("runtime tasks start and keep running on battery power", async () => {
  const host = await read("lifecycle-host.ps1");
  const register = host.match(/New-ScheduledTaskSettingsSet [^\n]+/u)?.[0] ?? "";
  assert.match(register, /-AllowStartIfOnBatteries/u);
  assert.match(register, /-DontStopIfGoingOnBatteries/u);
  // Tasks registered by older releases are repaired on the next register or enable.
  assert.match(host, /function Repair-TaskPowerPolicy/u);
  assert.match(host, /'task-register' \{[\s\S]*?Repair-TaskPowerPolicy[\s\S]*?\n {4}\}/u);
  assert.match(host, /'task-enable' \{[\s\S]*?Repair-TaskPowerPolicy \$task[\s\S]*?\n {4}\}/u);

  const development = await read("install-development-runtime.ps1");
  const settings = development.match(/function New-RuntimeTaskSettings \{[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.match(settings, /-AllowStartIfOnBatteries/u);
  assert.match(settings, /-DontStopIfGoingOnBatteries/u);

  const backup = await read("schedule-task.ps1");
  assert.match(backup, /DisallowStartIfOnBatteries = \$false/u);
  assert.match(backup, /StopIfGoingOnBatteries = \$false/u);
});

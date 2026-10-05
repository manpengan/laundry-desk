import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { adoptLegacyUserData, GENERIC_WINDOWS_APP_NAME } from "./user-data-identity.js";

const appData = join("C:", "Users", "staff", "AppData", "Roaming");
function fixture(name: string, existing: readonly string[], switches: readonly string[] = []) {
  const present = new Set(existing);
  const renames: [string, string][] = [];
  const app = {
    getName: () => name,
    getPath: (key: "userData" | "appData") => {
      if (key === "appData") return appData;
      // Electron 41 on Windows creates userData the first time it is asked for it.
      const userData = join(appData, name);
      present.add(userData);
      return userData;
    },
    commandLine: { hasSwitch: (flag: string) => switches.includes(flag) },
  } as Parameters<typeof adoptLegacyUserData>[0];
  const files = {
    existsSync: (path: string) => present.has(path),
    renameSync: (from: string, to: string) => {
      renames.push([from, to]);
    },
  };
  return { app, files, renames };
}
const legacy = join(appData, "@laundry", "edge-agent");

test("the generic build adopts the pre-split shared userData exactly once", () => {
  const first = fixture(GENERIC_WINDOWS_APP_NAME, [legacy]);
  assert.equal(adoptLegacyUserData(first.app, "win32", first.files), "adopted");
  assert.deepEqual(first.renames, [[legacy, join(appData, GENERIC_WINDOWS_APP_NAME)]]);
  const again = fixture(GENERIC_WINDOWS_APP_NAME, [
    legacy,
    join(appData, GENERIC_WINDOWS_APP_NAME),
  ]);
  assert.equal(adoptLegacyUserData(again.app, "win32", again.files), "skipped");
  assert.deepEqual(again.renames, []);
});

test("the hongfa build, non-Windows platforms and an explicit --user-data-dir never take it", () => {
  for (const [name, platform, switches] of [
    ["laundry-desk-v2-hongfa", "win32", []],
    [GENERIC_WINDOWS_APP_NAME, "darwin", []],
    [GENERIC_WINDOWS_APP_NAME, "win32", ["user-data-dir"]],
  ] as const) {
    const f = fixture(name, [legacy], switches);
    assert.equal(adoptLegacyUserData(f.app, platform, f.files), "skipped");
    assert.deepEqual(f.renames, []);
  }
});

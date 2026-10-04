import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { adoptLegacyUserData, GENERIC_WINDOWS_APP_NAME } from "./user-data-identity.js";

const appData = join("C:", "Users", "staff", "AppData", "Roaming");
function fixture(name: string, existing: readonly string[]) {
  const present = new Set(existing);
  const renames: [string, string][] = [];
  const app = {
    getName: () => name,
    getPath: (key: "userData" | "appData") => (key === "appData" ? appData : join(appData, name)),
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

test("the hongfa build and non-Windows platforms never take the shared directory", () => {
  for (const [name, platform] of [
    ["laundry-desk-v2-hongfa", "win32"],
    [GENERIC_WINDOWS_APP_NAME, "darwin"],
  ] as const) {
    const f = fixture(name, [legacy]);
    assert.equal(adoptLegacyUserData(f.app, platform, f.files), "skipped");
    assert.deepEqual(f.renames, []);
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { WINDOWS_PACKAGE_VERSION, parseWindowsPackageVersion } from "./windows-package-version.mjs";
import { getWindowsProfileBuildSettings, loadWindowsProfile } from "./windows-profile.mjs";

test("Counter package metadata supplies the same version to both distribution identities", async () => {
  const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(WINDOWS_PACKAGE_VERSION, metadata.version);
  for (const profileId of ["generic", "hongfa"]) {
    const { profile } = await loadWindowsProfile({ profileId });
    const settings = getWindowsProfileBuildSettings(profile, {
      packageVersion: WINDOWS_PACKAGE_VERSION,
    });
    assert.ok(settings.installerFileName.includes(`-${metadata.version}-windows-x64-`));
    const next = getWindowsProfileBuildSettings(profile, { packageVersion: "1.2.3" });
    assert.ok(next.installerFileName.includes("-1.2.3-windows-x64-"));
  }
});

test("malformed, noncanonical, oversized and injected versions fail with a stable code", () => {
  for (const bytes of [
    Buffer.from("{broken"),
    Buffer.from([0xff]),
    Buffer.alloc(16385),
    ...[null, {}, "", "01.2.3", "1.2", "1.2.3-beta", "1.2.3/other", "1.2.3\n", "1000000.2.3"].map(
      (version) => Buffer.from(JSON.stringify({ version })),
    ),
  ])
    assert.throws(() => parseWindowsPackageVersion(bytes), /WINDOWS_PROFILE_VERSION_INVALID/u);
  assert.equal(parseWindowsPackageVersion(Buffer.from('{"version":"1.2.3"}')), "1.2.3");
});

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseWindowsUpdateEnvironment } from "./release-windows-update.mjs";

const env = Object.freeze({
  LAUNDRY_WINDOWS_DISTRIBUTION_PROFILE: "generic",
  LAUNDRY_WINDOWS_UPDATE_VERSION: "0.2.0",
  LAUNDRY_WINDOWS_SIGNING_THUMBPRINT: "a".repeat(40),
  LAUNDRY_WINDOWS_BUILD_GIT_SHA: "b".repeat(40),
  LAUNDRY_UPDATE_PRIVATE_KEY_FILE: join(tmpdir(), "private.pem"),
  LAUNDRY_UPDATE_PUBLIC_KEY_FILE: join(tmpdir(), "public.pem"),
  LAUNDRY_RELEASE_POLICY_FILE: join(tmpdir(), "policy.json"),
  LAUNDRY_UPDATE_CONFIG_FILE: join(tmpdir(), "config.json"),
  LAUNDRY_WINDOWS_UPDATE_OUTPUT: join(tmpdir(), "candidate"),
});
test("Windows update publication requires explicit profile, signing identity, exact source and fixed file inputs", () => {
  assert.equal(parseWindowsUpdateEnvironment(env, "win32").version, "0.2.0");
  assert.throws(() => parseWindowsUpdateEnvironment(env, "darwin"), /REQUIRES_WINDOWS/u);
  for (const key of Object.keys(env)) {
    assert.throws(
      () => parseWindowsUpdateEnvironment({ ...env, [key]: "" }, "win32"),
      /INPUT_INVALID/u,
    );
  }
  for (const patch of [
    { LAUNDRY_WINDOWS_SIGNING_THUMBPRINT: "arbitrary subject" },
    { LAUNDRY_WINDOWS_DISTRIBUTION_PROFILE: "other" },
    { LAUNDRY_WINDOWS_UPDATE_VERSION: "0.2.0 --unsafe" },
    { LAUNDRY_WINDOWS_BUILD_GIT_SHA: "main" },
    { LAUNDRY_UPDATE_PRIVATE_KEY_FILE: "../key" },
  ])
    assert.throws(
      () => parseWindowsUpdateEnvironment({ ...env, ...patch }, "win32"),
      /INPUT_INVALID/u,
    );
});

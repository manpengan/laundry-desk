import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { securePrivateDirectory } from "@laundry/platform-fs";
import { signReleaseManifest, verifyReleaseManifest } from "./release-manifest.js";
import { createWindowsUpdateIo, validateWindowsUpdateLaunch } from "./windows-update-io.js";
import type { WindowsUpdateRequest } from "./windows-update-process.js";

const keys = generateKeyPairSync("ed25519");
const target = Object.freeze({
  platform: "win32" as const,
  arch: "x64" as const,
  profile: "generic" as const,
});
const bytes = Buffer.from("verified fixture zip: extraction bridge is explicitly injected");
const base = {
  protocol_version: 1 as const,
  target,
  channel: "beta" as const,
  version: "0.2.0",
  minimum_secure_version: "0.1.0",
  minimum_upgradable_version: "0.1.0",
  contracts_major: 0,
  local_schema: 3,
  published_at: "2026-10-03T00:00:00.000Z",
  artifacts: [
    {
      kind: "zip" as const,
      name: "laundry-windows.zip",
      size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ],
  rollback: {
    target_version: "0.1.0",
    artifact_sha256: "a".repeat(64),
    max_compatible_local_schema: 3,
  },
};
const context = {
  target,
  channel: "beta" as const,
  current_version: "0.1.0",
  installed_minimum_secure_version: "0.1.0",
  current_local_schema: 3,
  supported_contracts_majors: [0],
};

test("Windows releases bind platform/profile and require joint handling for queue schema changes", () => {
  const manifest = signReleaseManifest(base, keys.privateKey);
  assert.equal(verifyReleaseManifest(manifest, keys.publicKey, context).ok, true);
  assert.deepEqual(
    verifyReleaseManifest(manifest, keys.publicKey, { ...context, target: undefined }),
    { ok: false, error: "UPDATE_PLATFORM_MISMATCH" },
  );
  assert.deepEqual(
    verifyReleaseManifest(manifest, keys.publicKey, {
      ...context,
      target: { ...target, profile: "hongfa" },
    }),
    { ok: false, error: "UPDATE_PLATFORM_MISMATCH" },
  );
  assert.deepEqual(
    verifyReleaseManifest(
      signReleaseManifest({ ...base, local_schema: 4 }, keys.privateKey),
      keys.publicKey,
      context,
    ),
    { ok: false, error: "UPDATE_JOINT_SCHEMA_UPGRADE_REQUIRED" },
  );
  assert.equal(Object.isFrozen(manifest.authority.target), true);
});

async function fixture(parent: string) {
  const root = await realpath(parent);
  const current = join(root, "installed", "Counter.exe");
  const updates = join(root, "updates");
  const slot = join(updates, "slots", "B", "0.2.0-unique");
  await mkdir(slot, { recursive: true, mode: 0o700 });
  await securePrivateDirectory(slot);
  const resources = join(dirname(current), "resources");
  await mkdir(join(resources, "update"), { recursive: true });
  await mkdir(join(resources, "distribution-profile"));
  await writeFile(current, "synthetic executable");
  await writeFile(join(resources, "update", "update-config.json"), '{"enabled":true}');
  await writeFile(
    join(resources, "update", "update-public-key.pem"),
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  await writeFile(
    join(resources, "distribution-profile", "profile.json"),
    '{"profile_id":"generic"}',
  );
  const zip = join(slot, base.artifacts[0]!.name);
  await writeFile(zip, bytes);
  const requests: WindowsUpdateRequest[] = [];
  const bridge = async (request: WindowsUpdateRequest) => {
    requests.push(request);
    if (request.verifyOnly) return;
    assert.equal(request.expectedVersion, "0.2.0");
    const next = join(dirname(request.targetExe), "resources");
    await mkdir(join(next, "update"), { recursive: true });
    await mkdir(join(next, "distribution-profile"));
    await writeFile(request.targetExe, "synthetic executable");
    for (const name of ["update-config.json", "update-public-key.pem"])
      await copyFile(join(resources, "update", name), join(next, "update", name));
    await copyFile(
      join(resources, "distribution-profile", "profile.json"),
      join(next, "distribution-profile", "profile.json"),
    );
  };
  return { root, current, updates, slot, zip, requests, bridge };
}

test("Windows staged launch retains signed proof and rechecks archive/profile/authority before native verification", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "laundry-windows-update-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const f = await fixture(temporary);
  const manifest = signReleaseManifest(base, keys.privateKey);
  const io = createWindowsUpdateIo(f.current, f.bridge);
  const next = await io.extractAndVerifyWindowsApp!(f.zip, f.slot, manifest);
  const options = {
    currentExe: f.current,
    targetExe: next,
    updatesRoot: f.updates,
    publicKey: keys.publicKey,
    target,
    minimumSecureVersion: "0.1.0",
    originalExe: f.current,
  };
  await validateWindowsUpdateLaunch(options, f.bridge);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1]!.verifyOnly, true);
  await writeFile(f.zip, Buffer.alloc(bytes.length));
  await assert.rejects(validateWindowsUpdateLaunch(options, f.bridge), /UPDATE_ZIP_HASH_INVALID/u);
  assert.equal(f.requests.length, 2, "tampering must fail before executing native code");
  await writeFile(f.zip, bytes);
  await writeFile(
    join(dirname(next), "resources", "update", "update-config.json"),
    '{"enabled":false}',
  );
  await assert.rejects(
    validateWindowsUpdateLaunch(options, f.bridge),
    /UPDATE_BUNDLED_AUTHORITY_CHANGED/u,
  );
  await assert.rejects(
    validateWindowsUpdateLaunch(
      { ...options, targetExe: join(f.root, "unexpected.exe") },
      f.bridge,
    ),
    /UPDATE_TARGET_OUTSIDE_SLOT/u,
  );
});

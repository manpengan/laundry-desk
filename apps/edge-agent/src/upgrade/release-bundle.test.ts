import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSignedReleaseBundle } from "./release-bundle.js";
import { verifyReleaseManifest } from "./release-manifest.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "laundry-release-bundle-"));
  t.after(async () => {
    await rm(root, { recursive: true });
  });
  const releaseDirectory = join(root, "release");
  await mkdir(releaseDirectory);
  await writeFile(join(releaseDirectory, "laundry-desk-2.0.0-arm64.dmg"), "dmg");
  await writeFile(join(releaseDirectory, "laundry-desk-2.0.0-arm64.zip"), "zip");
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPath = join(root, "update-private.pem");
  await writeFile(privateKeyPath, keys.privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  const policyPath = join(root, "policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      channel: "stable",
      minimum_secure_version: "1.8.0",
      minimum_upgradable_version: "1.9.0",
      contracts_major: 1,
      local_schema: 4,
      rollback: null,
    }),
  );
  return { root, releaseDirectory, privateKeyPath, policyPath, keys };
}

test("release bundle signs the exact DMG and ZIP metadata and is create-only", async (t) => {
  const setup = await fixture(t);
  const result = await buildSignedReleaseBundle({
    ...setup,
    version: "2.0.0",
    publishedAt: "2026-07-30T08:00:00.000Z",
  });
  const parsed = JSON.parse(await readFile(result.path, "utf8"));
  assert.equal(
    verifyReleaseManifest(parsed, setup.keys.publicKey, {
      channel: "stable",
      current_version: "1.9.0",
      installed_minimum_secure_version: "1.8.0",
      current_local_schema: 3,
      supported_contracts_majors: [0, 1],
    }).ok,
    true,
  );
  assert.deepEqual(result.manifest.authority.artifacts.map((artifact) => artifact.kind).sort(), [
    "dmg",
    "zip",
  ]);
  await assert.rejects(
    () =>
      buildSignedReleaseBundle({
        ...setup,
        version: "2.0.0",
      }),
    /EEXIST/u,
  );
});

test("release bundle rejects permissive private key and symlinked artifact", async (t) => {
  const permissive = await fixture(t);
  await chmod(permissive.privateKeyPath, 0o644);
  await assert.rejects(
    () => buildSignedReleaseBundle({ ...permissive, version: "2.0.0" }),
    /permissions/u,
  );

  const linked = await fixture(t);
  await rm(join(linked.releaseDirectory, "laundry-desk-2.0.0-arm64.zip"));
  await writeFile(join(linked.root, "outside.zip"), "zip");
  await symlink(
    join(linked.root, "outside.zip"),
    join(linked.releaseDirectory, "laundry-desk-2.0.0-arm64.zip"),
  );
  await assert.rejects(() => buildSignedReleaseBundle({ ...linked, version: "2.0.0" }), /unsafe/u);
});

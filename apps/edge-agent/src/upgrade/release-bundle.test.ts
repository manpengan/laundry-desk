import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { describeCanonicalAppTree } from "../../scripts/release-tree.mjs";

import {
  buildSignedReleaseBundle,
  readBoundedRealFile,
  verifySignedReleaseBundle,
} from "./release-bundle.js";
import { verifyReleaseManifest } from "./release-manifest.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "laundry-release-bundle-"));
  t.after(async () => {
    await rm(root, { recursive: true });
  });
  const releaseDirectory = join(root, "release");
  await mkdir(releaseDirectory);
  const appPath = join(releaseDirectory, "mac-universal", "Laundry Desk.app");
  await mkdir(join(appPath, "Contents", "Resources"), { recursive: true });
  await writeFile(join(appPath, "Contents", "Resources", "application.txt"), "application");
  await writeFile(join(releaseDirectory, "laundry-desk-2.0.0-arm64.dmg"), "dmg");
  await writeFile(join(releaseDirectory, "laundry-desk-2.0.0-arm64.zip"), "zip");
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPath = join(root, "update-private.pem");
  const publicKeyPath = join(root, "update-public.pem");
  await writeFile(privateKeyPath, keys.privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  await writeFile(publicKeyPath, keys.publicKey.export({ format: "pem", type: "spki" }));
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
    { mode: 0o600 },
  );
  const updateConfigPath = join(root, "update-config.json");
  await writeFile(updateConfigPath, '{"channel":"stable"}\n');
  return {
    root,
    releaseDirectory,
    appPath,
    privateKeyPath,
    publicKeyPath,
    policyPath,
    updateConfigPath,
    keys,
  };
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function descriptor(setup: Awaited<ReturnType<typeof fixture>>) {
  const artifactNames = [
    ["dmg", "laundry-desk-2.0.0-arm64.dmg"],
    ["zip", "laundry-desk-2.0.0-arm64.zip"],
  ] as const;
  const artifacts = await Promise.all(
    artifactNames.map(async ([kind, name]) => {
      const bytes = await readFile(join(setup.releaseDirectory, name));
      return { kind, name, size_bytes: bytes.byteLength, sha256: sha256(bytes) };
    }),
  );
  const appTree = await describeCanonicalAppTree(setup.appPath);
  return {
    schema_version: 1,
    version: "2.0.0",
    channel: "stable",
    public_key_spki_sha256: sha256(setup.keys.publicKey.export({ format: "der", type: "spki" })),
    policy_sha256: sha256(await readFile(setup.policyPath)),
    update_config_sha256: sha256(await readFile(setup.updateConfigPath)),
    application: {
      relative_path: "mac-universal/Laundry Desk.app",
      name: appTree.name,
      bundle_identifier: "com.laundry-desk.v2",
      version: "2.0.0",
      team_identifier: "ABCDE12345",
      root_mode: appTree.root_mode,
      entry_count: appTree.entry_count,
      size_bytes: appTree.size_bytes,
      tree_sha256: appTree.tree_sha256,
    },
    artifacts,
  };
}

test("release bundle signs the exact DMG and ZIP metadata and is create-only", async (t) => {
  const setup = await fixture(t);
  const immutableInput = await descriptor(setup);
  const result = await buildSignedReleaseBundle({
    ...setup,
    descriptor: immutableInput,
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
        descriptor: immutableInput,
      }),
    /EEXIST|unexpected entry/u,
  );
});

test("release bundle rejects permissive private key and symlinked artifact", async (t) => {
  const permissive = await fixture(t);
  await chmod(permissive.privateKeyPath, 0o644);
  await assert.rejects(
    async () =>
      await buildSignedReleaseBundle({
        ...permissive,
        descriptor: await descriptor(permissive),
      }),
    /metadata is unsafe/u,
  );

  const linked = await fixture(t);
  await rm(join(linked.releaseDirectory, "laundry-desk-2.0.0-arm64.zip"));
  await writeFile(join(linked.root, "outside.zip"), "zip");
  await symlink(
    join(linked.root, "outside.zip"),
    join(linked.releaseDirectory, "laundry-desk-2.0.0-arm64.zip"),
  );
  await assert.rejects(
    async () => await buildSignedReleaseBundle({ ...linked, descriptor: await descriptor(linked) }),
    /unsafe|symlink/u,
  );
});

test("immutable inputs reject replaced key, policy, ZIP, and DMG bytes", async (t) => {
  for (const replacement of ["key", "policy", "zip", "dmg"] as const) {
    const setup = await fixture(t);
    const immutableInput = await descriptor(setup);
    if (replacement === "key") {
      const other = generateKeyPairSync("ed25519");
      await writeFile(
        setup.privateKeyPath,
        other.privateKey.export({ format: "pem", type: "pkcs8" }),
        { mode: 0o600 },
      );
    } else if (replacement === "policy") {
      await writeFile(
        setup.policyPath,
        JSON.stringify({
          channel: "beta",
          minimum_secure_version: "1.8.0",
          minimum_upgradable_version: "1.9.0",
          contracts_major: 1,
          local_schema: 4,
          rollback: null,
        }),
      );
    } else {
      await writeFile(
        join(setup.releaseDirectory, `laundry-desk-2.0.0-arm64.${replacement}`),
        "replaced",
      );
    }
    await assert.rejects(
      () => buildSignedReleaseBundle({ ...setup, descriptor: immutableInput }),
      /immutable release input/u,
    );
  }
});

test("post-sign verification binds the embedded key, app tree, and current artifact bytes", async (t) => {
  const setup = await fixture(t);
  const immutableInput = await descriptor(setup);
  await buildSignedReleaseBundle({ ...setup, descriptor: immutableInput });
  assert.deepEqual(await verifySignedReleaseBundle({ ...setup, descriptor: immutableInput }), {
    ok: true,
  });
  await writeFile(join(setup.releaseDirectory, "laundry-desk-2.0.0-arm64.zip"), "replaced");
  await assert.rejects(
    () => verifySignedReleaseBundle({ ...setup, descriptor: immutableInput }),
    /immutable release input/u,
  );

  const appSetup = await fixture(t);
  const appInput = await descriptor(appSetup);
  await buildSignedReleaseBundle({ ...appSetup, descriptor: appInput });
  await writeFile(
    join(appSetup.appPath, "Contents", "Resources", "application.txt"),
    "replaced application",
  );
  await assert.rejects(
    () => verifySignedReleaseBundle({ ...appSetup, descriptor: appInput }),
    /application does not match/u,
  );
});

test("release bundle rejects every unexpected release-root entry", async (t) => {
  const setup = await fixture(t);
  const immutableInput = await descriptor(setup);
  await writeFile(join(setup.releaseDirectory, "private.pem"), "sensitive");
  await assert.rejects(
    () => buildSignedReleaseBundle({ ...setup, descriptor: immutableInput }),
    /unexpected entry/u,
  );
});

test("signer input reads reject a same-inode mutation after open", async (t) => {
  const setup = await fixture(t);
  await assert.rejects(
    () =>
      readBoundedRealFile(setup.policyPath, "release policy", 64 * 1024, {
        requiredMode: 0o600,
        afterOpen: async () => await appendFile(setup.policyPath, " "),
      }),
    /changed while reading/u,
  );
});

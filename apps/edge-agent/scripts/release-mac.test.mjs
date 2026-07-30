import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createReleaseChildEnvironment,
  parseReleaseEnvironment,
  stageUpdatePublicKey,
} from "./release-mac.mjs";

async function releaseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "laundry-release-preflight-"));
  t.after(async () => {
    await rm(root, { recursive: true });
  });
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPath = join(root, "private.pem");
  const publicKeyPath = join(root, "public.pem");
  const policyPath = join(root, "policy.json");
  const keychain = join(root, "release.keychain-db");
  await writeFile(privateKeyPath, keys.privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  await writeFile(publicKeyPath, keys.publicKey.export({ format: "pem", type: "spki" }));
  await writeFile(policyPath, "{}");
  await writeFile(keychain, "fixture");
  const env = {
    HOME: root,
    PATH: process.env.PATH,
    DATABASE_URL: "must-not-pass",
    CSC_NAME: "Developer ID Application: Laundry Desk (ABCDE12345)",
    APPLE_KEYCHAIN: keychain,
    APPLE_KEYCHAIN_PROFILE: "laundry-notary",
    LAUNDRY_UPDATE_PRIVATE_KEY_FILE: privateKeyPath,
    LAUNDRY_UPDATE_PUBLIC_KEY_FILE: publicKeyPath,
    LAUNDRY_RELEASE_POLICY_FILE: policyPath,
  };
  return { root, env };
}

test("release environment is explicit, keychain-only, and rejects argument injection", async (t) => {
  const setup = await releaseFixture(t);
  const parsed = parseReleaseEnvironment(setup.env, "darwin");
  assert.equal(parsed.profile, "laundry-notary");
  assert.throws(
    () =>
      parseReleaseEnvironment(
        { ...setup.env, CSC_NAME: "Developer ID Application: x;rm" },
        "darwin",
      ),
    /CSC_NAME/u,
  );
  assert.throws(
    () => parseReleaseEnvironment({ ...setup.env, APPLE_ID: "unexpected" }, "darwin"),
    /APPLE_ID/u,
  );
  assert.throws(() => parseReleaseEnvironment(setup.env, "linux"), /requires Darwin/u);
});

test("release child environment excludes unrelated host secrets", async (t) => {
  const setup = await releaseFixture(t);
  const parsed = parseReleaseEnvironment(setup.env, "darwin");
  const child = createReleaseChildEnvironment(setup.env, parsed);
  assert.equal(child.DATABASE_URL, undefined);
  assert.equal(child.HOME, setup.root);
  assert.equal(child.CSC_KEYCHAIN, parsed.keychain);
  assert.equal(child.LAUNDRY_UPDATE_PRIVATE_KEY_FILE, parsed.privateKeyPath);
});

test("release stages only the matching Ed25519 public key", async (t) => {
  const setup = await releaseFixture(t);
  const parsed = parseReleaseEnvironment(setup.env, "darwin");
  const packageRoot = join(setup.root, "package");
  await mkdir(join(packageRoot, "build"), { recursive: true });
  const staged = await stageUpdatePublicKey(parsed, packageRoot);
  assert.equal(
    await readFile(staged.stagingPath, "utf8"),
    await readFile(parsed.publicKeyPath, "utf8"),
  );

  const other = generateKeyPairSync("ed25519");
  await writeFile(parsed.publicKeyPath, other.publicKey.export({ format: "pem", type: "spki" }));
  const secondRoot = join(setup.root, "other-package");
  await mkdir(join(secondRoot, "build"), { recursive: true });
  await assert.rejects(() => stageUpdatePublicKey(parsed, secondRoot), /does not match/u);
});

import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { chmod, link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalizeRuntimeManifestPayload,
  generateRuntimeManifest,
  signRuntimeManifestPayload,
} from "./generate-manifest.mjs";

const repeated = (value) => value.repeat(64);

function fixturePayload() {
  return {
    schema_version: 1,
    product: "laundry-desk-runtime",
    release: "0.2.0",
    contracts_major: 2,
    contracts_sha256: repeated("a"),
    server_version: "0.2.0",
    web_bundle_sha256: repeated("b"),
    minimum_app_version: "0.1.0",
    database_schema_sha256: repeated("c"),
    migrations_sha256: repeated("d"),
    migration_head: "0036_member_bonus_rules.sql",
    maximum_compatible_schema: "0036_member_bonus_rules.sql",
    rollback_target: {
      release: "0.1.0",
      server_image_index: `registry.example/laundry/server@sha256:${repeated("e")}`,
      maximum_compatible_schema: "0036_member_bonus_rules.sql",
    },
    compose_sha256: repeated("f"),
    server_image: {
      index: `registry.example/laundry/server@sha256:${repeated("1")}`,
      linux_arm64: `sha256:${repeated("2")}`,
      linux_amd64: `sha256:${repeated("3")}`,
    },
    postgres_major: 16,
    postgres_image: `docker.io/library/postgres@sha256:${repeated("4")}`,
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "laundry-runtime-manifest-"));
  t.after(async () => rm(root, { recursive: true }));
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPath = join(root, "private.pem");
  const publicKeyPath = join(root, "public.txt");
  const inputPath = join(root, "input.json");
  const outputPath = join(root, "release.json");
  const spki = keys.publicKey.export({ format: "der", type: "spki" });
  await writeFile(privateKeyPath, keys.privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  await writeFile(publicKeyPath, `${spki.subarray(spki.length - 32).toString("base64url")}\n`, {
    mode: 0o600,
  });
  await writeFile(inputPath, JSON.stringify(fixturePayload()), { mode: 0o600 });
  return {
    root,
    keys,
    privateKeyPath,
    publicKeyPath,
    inputPath,
    outputPath,
    env: {
      LAUNDRY_RUNTIME_MANIFEST_INPUT_FILE: inputPath,
      LAUNDRY_RUNTIME_MANIFEST_PRIVATE_KEY_FILE: privateKeyPath,
      LAUNDRY_RUNTIME_MANIFEST_PUBLIC_KEY_FILE: publicKeyPath,
      LAUNDRY_RUNTIME_MANIFEST_OUTPUT_FILE: outputPath,
    },
  };
}

test("ephemeral Ed25519 generator emits the production Runtime manifest envelope", async (t) => {
  const setup = await fixture(t);
  const result = await generateRuntimeManifest(setup.env);
  const written = JSON.parse(await readFile(result.outputPath, "utf8"));
  assert.deepEqual(Object.keys(written).sort(), ["payload", "signature"]);
  assert.equal(written.signature.length, 86);
  assert.equal(
    verify(
      null,
      canonicalizeRuntimeManifestPayload(written.payload),
      setup.keys.publicKey,
      Buffer.from(written.signature, "base64url"),
    ),
    true,
  );
  assert.equal(Object.isFrozen(result.manifest.payload.server_image), true);
  assert.equal(Object.isFrozen(result.manifest.payload.rollback_target), true);
  await assert.rejects(() => generateRuntimeManifest(setup.env), /EEXIST/u);
});

test("generator rejects mismatched keys, permissive private keys, and unsigned shape drift", async (t) => {
  const mismatch = await fixture(t);
  const other = generateKeyPairSync("ed25519");
  const otherSpki = other.publicKey.export({ format: "der", type: "spki" });
  await writeFile(
    mismatch.publicKeyPath,
    `${otherSpki.subarray(otherSpki.length - 32).toString("base64url")}\n`,
  );
  await assert.rejects(() => generateRuntimeManifest(mismatch.env), /KEY_PAIR_MISMATCH/u);

  const permissive = await fixture(t);
  await chmod(permissive.privateKeyPath, 0o644);
  await assert.rejects(() => generateRuntimeManifest(permissive.env), /0600/u);

  const linked = await fixture(t);
  await link(linked.inputPath, join(linked.root, "second-input-link.json"));
  await assert.rejects(() => generateRuntimeManifest(linked.env), /single-link/u);

  const shape = await fixture(t);
  await writeFile(shape.inputPath, JSON.stringify({ ...fixturePayload(), secret: "must-reject" }));
  await assert.rejects(() => generateRuntimeManifest(shape.env), /INPUT_INVALID/u);
});

test("manifest signing rejects invalid rollback and non-Ed25519 keys", () => {
  const keys = generateKeyPairSync("ed25519");
  assert.throws(
    () =>
      signRuntimeManifestPayload(
        {
          ...fixturePayload(),
          rollback_target: { ...fixturePayload().rollback_target, release: "0.2.0" },
        },
        keys.privateKey,
        keys.publicKey,
      ),
    /INPUT_INVALID/u,
  );
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () =>
      signRuntimeManifestPayload(fixturePayload(), rsa.privateKey, createPublicKey(rsa.privateKey)),
    /PRIVATE_KEY_INVALID/u,
  );
});

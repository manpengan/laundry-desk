import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  canonicalizeReleaseManifest,
  evaluateReleaseRollback,
  signReleaseManifest,
  verifyReleaseArtifact,
  verifyReleaseManifest,
  verifyReleaseRollbackArtifact,
  type ReleaseManifestAuthority,
} from "./release-manifest.js";

const keys = generateKeyPairSync("ed25519");
const otherKeys = generateKeyPairSync("ed25519");
const zipBytes = Buffer.from("signed zip bytes");
const zipSha256 = createHash("sha256").update(zipBytes).digest("hex");

const authority: ReleaseManifestAuthority = {
  protocol_version: 1,
  channel: "stable",
  version: "2.0.0",
  minimum_secure_version: "1.8.0",
  minimum_upgradable_version: "1.9.0",
  contracts_major: 1,
  local_schema: 4,
  published_at: "2026-07-30T08:00:00.000Z",
  artifacts: [
    {
      kind: "zip",
      name: "laundry-desk-V2-2.0.0-arm64.zip",
      size_bytes: zipBytes.byteLength,
      sha256: zipSha256,
    },
  ],
  rollback: {
    target_version: "1.9.0",
    artifact_sha256: "a".repeat(64),
    max_compatible_local_schema: 4,
  },
};

const context = {
  channel: "stable" as const,
  current_version: "1.9.0",
  installed_minimum_secure_version: "1.8.0",
  current_local_schema: 3,
  supported_contracts_majors: [0, 1],
};

test("release manifest canonical bytes and signature cover policy, hashes, and rollback", () => {
  const signed = signReleaseManifest(authority, keys.privateKey);
  const verified = verifyReleaseManifest(signed, keys.publicKey, context);
  assert.equal(verified.ok, true);
  assert.match(signed.signature, /^[A-Za-z0-9+/]{86}==$/u);
  assert.match(canonicalizeReleaseManifest(authority).toString("utf8"), /^laundry-desk\//u);
  assert.equal(Object.isFrozen(signed.authority.artifacts), true);

  const changed = {
    ...signed,
    authority: { ...signed.authority, minimum_secure_version: "1.7.0" },
  };
  assert.equal(verifyReleaseManifest(changed, keys.publicKey, context).ok, false);
  assert.equal(verifyReleaseManifest(signed, otherKeys.publicKey, context).ok, false);
});

test("manifest rejects downgrade, skipped upgrade window, channel mismatch, and weak key", () => {
  const signed = signReleaseManifest(authority, keys.privateKey);
  const sameVersion = verifyReleaseManifest(signed, keys.publicKey, {
    ...context,
    current_version: "2.0.0",
  });
  assert.deepEqual(sameVersion, { ok: false, error: "UPDATE_VERSION_NOT_NEWER" });

  const tooOld = verifyReleaseManifest(signed, keys.publicKey, {
    ...context,
    current_version: "1.8.9",
  });
  assert.deepEqual(tooOld, { ok: false, error: "UPDATE_STEP_REQUIRED" });

  const wrongChannel = verifyReleaseManifest(signed, keys.publicKey, {
    ...context,
    channel: "beta",
  });
  assert.deepEqual(wrongChannel, { ok: false, error: "UPDATE_CHANNEL_MISMATCH" });

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.deepEqual(verifyReleaseManifest(signed, rsa.publicKey, context), {
    ok: false,
    error: "UPDATE_PUBLIC_KEY_INVALID",
  });
});

test("manifest rejects unsupported contracts and a target behind the current local schema", () => {
  const signed = signReleaseManifest(authority, keys.privateKey);
  assert.deepEqual(
    verifyReleaseManifest(signed, keys.publicKey, {
      ...context,
      supported_contracts_majors: [0],
    }),
    { ok: false, error: "UPDATE_CONTRACTS_INCOMPATIBLE" },
  );
  assert.deepEqual(
    verifyReleaseManifest(signed, keys.publicKey, {
      ...context,
      current_local_schema: 5,
    }),
    { ok: false, error: "UPDATE_SCHEMA_DOWNGRADE" },
  );
  assert.deepEqual(
    verifyReleaseManifest(signed, keys.publicKey, {
      ...context,
      supported_contracts_majors: [],
    }),
    { ok: false, error: "UPDATE_CONTEXT_INVALID" },
  );
});

test("artifact bytes must match signed size and SHA-256", () => {
  assert.deepEqual(verifyReleaseArtifact(authority, authority.artifacts[0]?.name ?? "", zipBytes), {
    ok: true,
  });
  assert.deepEqual(
    verifyReleaseArtifact(authority, authority.artifacts[0]?.name ?? "", Buffer.from("tampered")),
    { ok: false, error: "UPDATE_ARTIFACT_SIZE_MISMATCH" },
  );
  assert.deepEqual(verifyReleaseArtifact(authority, "unknown.zip", zipBytes), {
    ok: false,
    error: "UPDATE_ARTIFACT_UNKNOWN",
  });
});

test("rollback requires the signed target, both security floors, and schema compatibility", () => {
  assert.deepEqual(evaluateReleaseRollback(authority, "1.9.0", 4, "1.8.0"), {
    allowed: true,
    reason: "ROLLBACK_SIGNED_AND_COMPATIBLE",
  });
  assert.deepEqual(evaluateReleaseRollback(authority, "1.8.0", 4, "1.8.0"), {
    allowed: false,
    reason: "ROLLBACK_TARGET_NOT_SIGNED",
  });
  assert.deepEqual(evaluateReleaseRollback(authority, "1.9.0", 5, "1.8.0"), {
    allowed: false,
    reason: "ROLLBACK_SCHEMA_INCOMPATIBLE",
  });
  assert.deepEqual(evaluateReleaseRollback(authority, "1.9.0", 4, "1.9.1"), {
    allowed: false,
    reason: "ROLLBACK_BELOW_SECURITY_FLOOR",
  });
  const rollbackBytes = Buffer.from("rollback artifact");
  const rollbackAuthority = {
    ...authority,
    rollback: {
      ...authority.rollback!,
      artifact_sha256: createHash("sha256").update(rollbackBytes).digest("hex"),
    },
  };
  assert.deepEqual(verifyReleaseRollbackArtifact(rollbackAuthority, rollbackBytes), { ok: true });
  assert.deepEqual(verifyReleaseRollbackArtifact(rollbackAuthority, Buffer.from("tampered")), {
    ok: false,
    error: "ROLLBACK_ARTIFACT_HASH_MISMATCH",
  });
});

test("malformed semver and duplicate artifact kinds are rejected", () => {
  assert.throws(
    () => signReleaseManifest({ ...authority, version: "2" }, keys.privateKey),
    /Invalid string/u,
  );
  assert.throws(
    () =>
      signReleaseManifest(
        { ...authority, minimum_upgradable_version: authority.version },
        keys.privateKey,
      ),
    /minimum upgradable version must precede the release/u,
  );
  assert.throws(
    () =>
      signReleaseManifest({ ...authority, minimum_upgradable_version: "2.1.0" }, keys.privateKey),
    /minimum upgradable version must precede the release/u,
  );
  assert.throws(
    () =>
      signReleaseManifest(
        {
          ...authority,
          artifacts: [authority.artifacts[0], { ...authority.artifacts[0], name: "other.zip" }],
        },
        keys.privateKey,
      ),
    /artifact kinds must be unique/u,
  );
});

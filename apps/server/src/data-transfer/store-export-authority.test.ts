import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { signStoreExportApproval, verifyStoreExportApproval } from "./store-export-authority.js";

test("approval signature binds every claim and the source instance", () => {
  const secret = "synthetic-store-export-signing-secret-32-bytes";
  const claims = {
    id: randomUUID(),
    org_id: randomUUID(),
    store_id: randomUUID(),
    actor_id: randomUUID(),
    session_id: randomUUID(),
    session_version: 1,
    permission_version: 1,
    policy_sha256: "a".repeat(64),
    approved_at_ms: 1_700_000_000_000,
    expires_at_ms: 1_700_000_600_000,
  };
  const signature = signStoreExportApproval(secret, claims);
  verifyStoreExportApproval(secret, claims, signature);
  for (const field of ["id", "org_id", "store_id", "actor_id", "session_id"] as const)
    assert.throws(() =>
      verifyStoreExportApproval(secret, { ...claims, [field]: randomUUID() }, signature),
    );
  for (const field of ["session_version", "permission_version", "approved_at_ms"] as const)
    assert.throws(() =>
      verifyStoreExportApproval(secret, { ...claims, [field]: claims[field] + 1 }, signature),
    );
  assert.throws(() =>
    verifyStoreExportApproval(
      secret,
      { ...claims, expires_at_ms: claims.expires_at_ms - 1 },
      signature,
    ),
  );
  assert.throws(() =>
    verifyStoreExportApproval(secret, { ...claims, policy_sha256: "b".repeat(64) }, signature),
  );
  assert.throws(() =>
    verifyStoreExportApproval("another-instance-secret-with-32-bytes", claims, signature),
  );
  assert.throws(() =>
    verifyStoreExportApproval(secret, claims, Buffer.alloc(64).toString("base64")),
  );
  assert.throws(() =>
    signStoreExportApproval(secret, { ...claims, expires_at_ms: claims.expires_at_ms + 1 }),
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDataProtectionOffsiteAuthority,
  parseDataProtectionOffsiteAuthority,
} from "./hk-vps-data-protection-offsite-authority.mjs";

const NOW = new Date("2026-08-12T12:00:00.000Z");

function authority(overrides = {}) {
  return {
    schema: "laundry.cloud-data-protection.offsite-authority",
    version: 1,
    target_id: "nas-a",
    mount_source: "backup.internal:/laundry",
    mount_fstype: "nfs4",
    failure_domain: "nas-taipei-a",
    remote_identity: "ed25519:SHA256:0123456789abcdef",
    attested_at: "2026-08-12T00:00:00.000Z",
    expires_at: "2027-08-12T00:00:00.000Z",
    ...overrides,
  };
}

test("offsite authority binds an external source, remote identity and failure domain", async () => {
  const parsed = parseDataProtectionOffsiteAuthority(authority(), NOW);
  const result = await assertDataProtectionOffsiteAuthority(
    { source: parsed.mount_source, fstype: parsed.mount_fstype },
    parsed.target_id,
    { readAuthority: async () => parsed },
  );
  assert.equal(result.failure_domain, "nas-taipei-a");
});

test("loopback, local-domain, expired and mismatched authority fail closed", async () => {
  for (const value of [
    authority({ mount_source: "127.0.0.1:/laundry" }),
    authority({ failure_domain: "hk-vps" }),
    authority({ expires_at: "2026-08-12T11:59:59.000Z" }),
  ]) {
    assert.throws(() => parseDataProtectionOffsiteAuthority(value, NOW), {
      code: "CLOUD_DATA_OFFSITE_AUTHORITY_INVALID",
    });
  }
  await assert.rejects(
    () =>
      assertDataProtectionOffsiteAuthority(
        { source: "other.internal:/laundry", fstype: "nfs4" },
        "nas-a",
        { readAuthority: async () => parseDataProtectionOffsiteAuthority(authority(), NOW) },
      ),
    { code: "CLOUD_DATA_OFFSITE_AUTHORITY_INVALID" },
  );
});

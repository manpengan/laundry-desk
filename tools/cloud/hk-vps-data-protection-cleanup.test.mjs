import assert from "node:assert/strict";
import test from "node:test";

import { dataProtectionFailureRequiresOperation } from "./hk-vps-data-protection-cleanup.mjs";
import { CloudReleaseError } from "./hk-vps-release-core.mjs";

test("only failures that can leave operation-derived artifacts retain authority", () => {
  for (const code of [
    "CLOUD_DATA_SHADOW_DROP_FAILED",
    "CLOUD_DATA_STAGING_CLEANUP_FAILED",
    "CLOUD_DATA_OFFSITE_CLEANUP_FAILED",
    "CLOUD_DATA_CODE_STAGING_CLEANUP_FAILED",
    "CLOUD_DATA_PHOTO_STAGING_CLEANUP_FAILED",
  ]) {
    assert.equal(dataProtectionFailureRequiresOperation(new CloudReleaseError(code)), true);
  }
  assert.equal(
    dataProtectionFailureRequiresOperation(new CloudReleaseError("CLOUD_DATA_BACKUP_FAILED")),
    false,
  );
  assert.equal(dataProtectionFailureRequiresOperation(new Error("not stable")), false);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  createDataProtectionManifest,
  createDataProtectionSetId,
  createDataProtectionVerification,
  dataProtectionSetPath,
  parseDataProtectionManifest,
  parseDataProtectionOperation,
} from "./hk-vps-data-protection-contract.mjs";

const digest = (character) => character.repeat(64);
const photo = Object.freeze({
  storage_key: "11111111-1111-4111-8111-111111111111.jpg",
  bytes: 4,
  sha256: digest("a"),
});

function manifest(overrides = {}) {
  return createDataProtectionManifest({
    set_id: "manual-20260812T010203Z-0123456789abcdef",
    kind: "manual",
    code_sha: "1".repeat(40),
    created_at: "2026-08-12T01:02:03.000Z",
    migration: {
      head: "0051_customer_extended_profiles.sql",
      count: 51,
      ledger_sha256: digest("b"),
      catalog_sha256: digest("c"),
    },
    database: { file: "database.dump", bytes: 12, sha256: digest("d") },
    photos: {
      directory: "photos",
      count: 1,
      bytes: 4,
      inventory_sha256: digest("e"),
      files: [photo],
    },
    ...overrides,
  });
}

test("data protection ids and paths are fixed and traversal-safe", () => {
  assert.equal(
    createDataProtectionSetId(
      "scheduled",
      new Date("2026-08-12T01:02:03.000Z"),
      "0123456789abcdef",
    ),
    "scheduled-20260812T010203Z-0123456789abcdef",
  );
  assert.equal(
    dataProtectionSetPath("manual-20260812T010203Z-0123456789abcdef", "/private/sets"),
    "/private/sets/manual-20260812T010203Z-0123456789abcdef",
  );
  for (const value of ["../escape", "manual-x", "manual-20260812T010203Z-0123456789abcdeg"]) {
    assert.throws(() => dataProtectionSetPath(value), { code: "CLOUD_DATA_SET_ID_INVALID" });
  }
});

test("manifest freezes exact code, migration, database and sorted photo inventory", () => {
  const value = manifest();
  assert.equal(value.photos.files[0]?.storage_key, photo.storage_key);
  assert.equal(Object.isFrozen(value.photos.files), true);
  assert.equal(Object.isFrozen(value.migration), true);

  assert.throws(() => parseDataProtectionManifest({ ...value, unexpected: true }), {
    code: "CLOUD_DATA_MANIFEST_INVALID",
  });
  assert.throws(() => manifest({ photos: { ...value.photos, bytes: 5 } }), {
    code: "CLOUD_DATA_PHOTO_INVENTORY_INVALID",
  });
  assert.throws(
    () =>
      manifest({
        photos: { ...value.photos, count: 2, files: [photo, photo], bytes: 8 },
      }),
    { code: "CLOUD_DATA_PHOTO_INVENTORY_INVALID" },
  );
});

test("verification and operation state reject loose or ambiguous authority", () => {
  const verified = createDataProtectionVerification({
    set_id: manifest().set_id,
    manifest_sha256: digest("1"),
    migration_ledger_sha256: digest("2"),
    catalog_sha256: digest("3"),
    photo_inventory_sha256: digest("4"),
    completed_at: "2026-08-12T01:03:03.000Z",
  });
  assert.equal(verified.set_id, manifest().set_id);

  const operation = {
    schema: "laundry.cloud-data-protection.operation",
    version: 1,
    operation_id: "a".repeat(32),
    action: "backup",
    phase: "intent",
    set_id: null,
    pre_recovery_set_id: null,
    app_role_original_can_login: null,
    created_at: "2026-08-12T01:02:03.000Z",
    updated_at: "2026-08-12T01:02:03.000Z",
  };
  assert.equal(parseDataProtectionOperation(operation).phase, "intent");
  assert.throws(() => parseDataProtectionOperation({ ...operation, phase: "gate_active" }), {
    code: "CLOUD_DATA_OPERATION_INVALID",
  });
  assert.throws(() => parseDataProtectionOperation({ ...operation, secret: "no" }), {
    code: "CLOUD_DATA_OPERATION_INVALID",
  });
});

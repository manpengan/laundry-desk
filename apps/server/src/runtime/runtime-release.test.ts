import assert from "node:assert/strict";
import test from "node:test";

import { parseRuntimeRelease } from "./runtime-release.js";

const CHECKSUM = "a".repeat(64);
const valid = Object.freeze({
  LAUNDRY_RUNTIME_RELEASE: "1.2.3",
  LAUNDRY_RUNTIME_CONTRACTS_SHA256: CHECKSUM,
  LAUNDRY_RUNTIME_SCHEMA_SHA256: CHECKSUM,
  LAUNDRY_RUNTIME_MIGRATIONS_SHA256: CHECKSUM,
  LAUNDRY_RUNTIME_MIGRATION_HEAD: "0033_offline_grant_replay.sql",
});

test("strict runtime release metadata binds all startup gates", () => {
  assert.deepEqual(parseRuntimeRelease(valid), {
    release: "1.2.3",
    contractsChecksum: CHECKSUM,
    schemaChecksum: CHECKSUM,
    migrationsChecksum: CHECKSUM,
    migrationHead: "0033_offline_grant_replay.sql",
  });
});

test("release metadata rejects missing, malformed, and unexpected versions without echo", () => {
  for (const environment of [
    {},
    { ...valid, LAUNDRY_RUNTIME_RELEASE: "latest" },
    { ...valid, LAUNDRY_RUNTIME_SCHEMA_SHA256: "short" },
    { ...valid, LAUNDRY_RUNTIME_MIGRATION_HEAD: "../../secret.sql" },
  ]) {
    assert.throws(() => parseRuntimeRelease(environment), /RUNTIME_RELEASE_INVALID/u);
  }
});

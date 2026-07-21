import assert from "node:assert/strict";
import test from "node:test";

import {
  TENANT_GUC_KEYS,
  TenantGucError,
  buildSetLocalGucStatements,
  isUuid,
  parseTenantContext,
} from "./guc.js";

const VALID_CTX = Object.freeze({
  orgId: "11111111-1111-4111-8111-111111111111",
  storeId: "22222222-2222-4222-8222-222222222222",
  staffId: "33333333-3333-4333-8333-333333333333",
});

test("isUuid accepts RFC 4122 ids and rejects empty or garbage", () => {
  assert.equal(isUuid(VALID_CTX.orgId), true);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid("11111111-1111-4111-8111-11111111111"), false);
  assert.equal(isUuid(null), false);
});

test("buildSetLocalGucStatements emits stable org → store → staff order", () => {
  const first = buildSetLocalGucStatements(VALID_CTX);
  const second = buildSetLocalGucStatements(VALID_CTX);

  assert.equal(first.length, 3);
  assert.deepEqual(
    first.map((s) => s.key),
    [TENANT_GUC_KEYS.orgId, TENANT_GUC_KEYS.storeId, TENANT_GUC_KEYS.staffId],
  );
  assert.deepEqual(
    first.map((s) => s.sql),
    second.map((s) => s.sql),
  );
  assert.deepEqual(
    first.map((s) => s.values[0]),
    [VALID_CTX.orgId, VALID_CTX.storeId, VALID_CTX.staffId],
  );
});

test("GUC SQL uses set_config with bind param and literal allowlisted names", () => {
  const statements = buildSetLocalGucStatements(VALID_CTX);
  for (const statement of statements) {
    assert.match(statement.sql, /^SELECT set_config\('app\.[a-z_]+', \$1, true\)$/);
    assert.equal(statement.values.length, 1);
    // Values must never be interpolated into the SQL string.
    assert.equal(statement.sql.includes(statement.values[0]), false);
  }
});

test("parseTenantContext normalizes UUID case", () => {
  const parsed = parseTenantContext({
    orgId: VALID_CTX.orgId.toUpperCase(),
    storeId: VALID_CTX.storeId,
    staffId: VALID_CTX.staffId,
  });
  assert.equal(parsed.orgId, VALID_CTX.orgId.toLowerCase());
});

test("invalid or missing tenant ids fail closed", () => {
  assert.throws(() => buildSetLocalGucStatements(null), TenantGucError);
  assert.throws(() => buildSetLocalGucStatements({ ...VALID_CTX, orgId: "" }), /orgId is required/);
  assert.throws(
    () => buildSetLocalGucStatements({ ...VALID_CTX, storeId: "bad" }),
    /storeId must be a valid UUID/,
  );
  assert.throws(
    () =>
      buildSetLocalGucStatements({
        orgId: VALID_CTX.orgId,
        storeId: VALID_CTX.storeId,
      }),
    /staffId is required/,
  );
});

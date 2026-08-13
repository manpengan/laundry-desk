import assert from "node:assert/strict";
import test from "node:test";

import type { PgPool } from "../db/pg-pool.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { createPgByokStore } from "./byok-pg-store.js";
import type { StoredCredential } from "./byok-types.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "11111111-1111-4111-8111-111111111111",
  storeId: "22222222-2222-4222-8222-222222222222",
  staffId: "33333333-3333-4333-8333-333333333333",
});
const CREDENTIAL_ID = "44444444-4444-4444-8444-444444444444";
const AT = new Date("2026-08-13T08:00:00.000Z");

type RecordedQuery = Readonly<{ sql: string; params: readonly unknown[] | undefined }>;

const credentialRow = (status: StoredCredential["status"], rowVersion: number) =>
  Object.freeze({
    id: CREDENTIAL_ID,
    org_id: TENANT.orgId,
    provider_code: "official-test",
    credential_version: 1,
    row_version: rowVersion,
    status,
    ciphertext: Buffer.alloc(32, 1),
    nonce: Buffer.alloc(12, 2),
    auth_tag: Buffer.alloc(16, 3),
    wrapped_dek: Buffer.alloc(32, 4),
    kms_key_id: "test-kms",
    kms_key_version: "v1",
    envelope_schema_version: 1,
    last4: "test",
    created_by_staff_id: TENANT.staffId,
    created_at: AT,
    updated_by_staff_id: TENANT.staffId,
    updated_at: AT,
    activated_at: status === "active" ? AT : null,
    revoked_at: status === "revoked" ? AT : null,
    superseded_at: status === "superseded" ? AT : null,
  });

function capturingClient(): Readonly<{ client: SqlClient; queries: RecordedQuery[] }> {
  const queries: RecordedQuery[] = [];
  const client = {
    async query(sql: string, params?: readonly unknown[]) {
      queries.push(Object.freeze({ sql, params }));
      if (sql.includes("ai_provider_key_stage")) {
        return { rows: [{ credential_ref: CREDENTIAL_ID }], rowCount: 1 };
      }
      if (sql.includes("ai_provider_key_revoke")) {
        return { rows: [{ changed: true }], rowCount: 1 };
      }
      if (sql.includes("ai_provider_key_verify_transition")) {
        return { rows: [{ changed: true }], rowCount: 1 };
      }
      if (sql.includes("ai_provider_key_rewrap")) {
        return { rows: [{ changed: true }], rowCount: 1 };
      }
      if (sql.includes("FROM ai_provider_keys")) {
        const wasRevoked = queries.some((query) => query.sql.includes("ai_provider_key_revoke"));
        const wasActivated = queries.some((query) =>
          query.sql.includes("ai_provider_key_verify_transition"),
        );
        return {
          rows: [
            credentialRow(
              wasRevoked ? "revoked" : wasActivated ? "active" : "pending_verification",
              1,
            ),
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as SqlClient;
  return Object.freeze({ client, queries });
}

function record(): StoredCredential {
  return Object.freeze({
    id: CREDENTIAL_ID,
    orgId: TENANT.orgId,
    providerCode: "official-test",
    credentialVersion: 1,
    rowVersion: 1,
    status: "pending_verification",
    envelope: Object.freeze({
      ciphertext: Buffer.alloc(32, 1),
      nonce: Buffer.alloc(12, 2),
      authTag: Buffer.alloc(16, 3),
      wrappedDek: Buffer.alloc(32, 4),
      kmsKeyId: "test-kms",
      kmsKeyVersion: "v1",
      schemaVersion: 1,
    }),
    last4: "test",
    createdByStaffId: TENANT.staffId,
    createdAt: AT,
    updatedByStaffId: TENANT.staffId,
    updatedAt: AT,
    activatedAt: null,
    revokedAt: null,
    supersededAt: null,
  });
}

const unusedPool = Object.freeze({}) as unknown as PgPool;

test("PG credential stage uses the guarded function without caller-owned actor or time", async () => {
  const { client, queries } = capturingClient();
  const store = createPgByokStore(unusedPool);

  await store.stageCredential(record(), Object.freeze({ tenant: TENANT, client }));

  assert.equal(queries.length, 1);
  assert.match(queries[0]?.sql ?? "", /public\.ai_provider_key_stage/iu);
  assert.doesNotMatch(queries[0]?.sql ?? "", /\b(?:INSERT|UPDATE)\s+ai_provider_keys\b/iu);
  assert.ok(!queries[0]?.params?.includes(TENANT.orgId));
  assert.ok(!queries[0]?.params?.includes(TENANT.staffId));
  assert.ok(!queries[0]?.params?.includes(AT));
});

test("PG lifecycle methods call bounded transition and maintenance functions", async () => {
  const revokeCapture = capturingClient();
  const activateCapture = capturingClient();
  const rewrapCapture = capturingClient();
  const store = createPgByokStore(unusedPool);

  assert.equal(
    (
      await store.revokeCredential(
        CREDENTIAL_ID,
        TENANT.staffId,
        AT,
        Object.freeze({ tenant: TENANT, client: revokeCapture.client }),
      )
    )?.status,
    "revoked",
  );
  assert.equal(
    (
      await store.activateCredential(
        CREDENTIAL_ID,
        TENANT.staffId,
        AT,
        Object.freeze({ tenant: TENANT, client: activateCapture.client }),
      )
    )?.status,
    "active",
  );
  assert.ok(
    await store.rewrapCredential(
      CREDENTIAL_ID,
      1,
      Object.freeze({
        wrappedDek: Buffer.alloc(32, 9),
        kmsKeyId: "replacement-kms",
        kmsKeyVersion: "v2",
      }),
      TENANT.staffId,
      AT,
      Object.freeze({ tenant: TENANT, client: rewrapCapture.client }),
    ),
  );

  const sql = [...revokeCapture.queries, ...activateCapture.queries, ...rewrapCapture.queries]
    .map((query) => query.sql)
    .join("\n");
  assert.match(sql, /public\.ai_provider_key_revoke/iu);
  assert.match(sql, /public\.ai_provider_key_verify_transition/iu);
  assert.match(sql, /public\.ai_provider_key_rewrap/iu);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE)\s+ai_provider_keys\b/iu);
});

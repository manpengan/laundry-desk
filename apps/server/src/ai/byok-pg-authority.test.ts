import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPgPool, resolvePgUrls, withClient, type PgPool } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { createPgByokStore } from "./byok-pg-store.js";
import type { StoredCredential } from "./byok-types.js";

const pgUrls = resolvePgUrls(process.env);
const FUTURE = new Date("2099-01-01T00:00:00.000Z");

type Fixture = Readonly<{
  orgId: string;
  storeId: string;
  adminId: string;
  approverId: string;
  staffId: string;
  sessionId: string;
  credentialId: string;
  replaceRef: string;
  replaceProofRef: string;
  revokeRef: string;
  revokeProofRef: string;
  otherOrgId: string;
  otherStoreId: string;
  otherAdminId: string;
}>;

function fixture(): Fixture {
  return Object.freeze({
    orgId: randomUUID(),
    storeId: randomUUID(),
    adminId: randomUUID(),
    approverId: randomUUID(),
    staffId: randomUUID(),
    sessionId: randomUUID(),
    credentialId: randomUUID(),
    replaceRef: randomUUID(),
    replaceProofRef: randomUUID(),
    revokeRef: randomUUID(),
    revokeProofRef: randomUUID(),
    otherOrgId: randomUUID(),
    otherStoreId: randomUUID(),
    otherAdminId: randomUUID(),
  });
}

function tenant(rows: Fixture, staffId = rows.adminId): TenantContext {
  return Object.freeze({ orgId: rows.orgId, storeId: rows.storeId, staffId });
}

async function seedIdentity(admin: PgPool, rows: Fixture): Promise<void> {
  const now = new Date();
  await admin.query(
    `INSERT INTO orgs (id, code, name, created_at, updated_at)
     VALUES ($1::uuid, $2, 'BYOK guard', $3, $3),
            ($4::uuid, $5, 'BYOK guard other', $3, $3)`,
    [rows.orgId, `byok-${rows.orgId}`, now, rows.otherOrgId, `byok-${rows.otherOrgId}`],
  );
  await admin.query(
    `INSERT INTO stores (id, org_id, code, name, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'main', 'Main', $5, $5),
            ($3::uuid, $4::uuid, 'other', 'Other', $5, $5)`,
    [rows.storeId, rows.orgId, rows.otherStoreId, rows.otherOrgId, now],
  );
  await admin.query(
    `INSERT INTO staffs (
       id, org_id, username, password_hash, display_name, is_active,
       permission_version, created_at, updated_at
     ) VALUES
       ($1::uuid, $4::uuid, 'admin', 'fixture', 'Admin', true, 1, $7, $7),
       ($2::uuid, $4::uuid, 'approver', 'fixture', 'Approver', true, 1, $7, $7),
       ($3::uuid, $4::uuid, 'staff', 'fixture', 'Staff', true, 1, $7, $7),
       ($5::uuid, $6::uuid, 'other-admin', 'fixture', 'Other admin', true, 1, $7, $7)`,
    [
      rows.adminId,
      rows.approverId,
      rows.staffId,
      rows.orgId,
      rows.otherAdminId,
      rows.otherOrgId,
      now,
    ],
  );
  await admin.query(
    `INSERT INTO staff_store_roles (
       id, org_id, store_id, staff_id, role, is_active, created_at, updated_at
     ) VALUES
       ($1::uuid, $7::uuid, $8::uuid, $2::uuid, 'admin', true, $10, $10),
       ($3::uuid, $7::uuid, $8::uuid, $4::uuid, 'admin', true, $10, $10),
       ($5::uuid, $7::uuid, $8::uuid, $6::uuid, 'staff', true, $10, $10),
       ($9::uuid, $11::uuid, $12::uuid, $13::uuid, 'admin', true, $10, $10)`,
    [
      randomUUID(),
      rows.adminId,
      randomUUID(),
      rows.approverId,
      randomUUID(),
      rows.staffId,
      rows.orgId,
      rows.storeId,
      randomUUID(),
      now,
      rows.otherOrgId,
      rows.otherStoreId,
      rows.otherAdminId,
    ],
  );
  await admin.query(
    `INSERT INTO sessions (
       id, org_id, store_id, staff_id, device_id, session_version,
       permission_version, authentication_method, status, created_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1, 1,
               'password', 'active', $6)`,
    [rows.sessionId, rows.orgId, rows.storeId, rows.adminId, randomUUID(), now],
  );
}

async function seedConsumedOperation(
  admin: PgPool,
  rows: Fixture,
  operation: "replace" | "revoke",
  rowVersion: number,
): Promise<void> {
  const operationRef = operation === "replace" ? rows.replaceRef : rows.revokeRef;
  const proofRef = operation === "replace" ? rows.replaceProofRef : rows.revokeProofRef;
  const idempotencyKey = randomUUID();
  const args = Object.freeze({
    operation,
    provider_code: "official-test",
    ...(operation === "revoke" ? { credential_ref: rows.credentialId } : {}),
    idempotency_key: idempotencyKey,
  });
  const versions =
    operation === "replace"
      ? Object.freeze([])
      : Object.freeze([
          Object.freeze({
            entityType: "ai_provider_key",
            entityId: rows.credentialId,
            version: rowVersion,
          }),
        ]);
  const now = Math.floor(Date.now() / 1_000);
  const argsHash = operation === "replace" ? "a".repeat(64) : "b".repeat(64);
  await admin.query(
    `INSERT INTO ai_pending_actions (
       nonce, org_id, store_id, command, command_version, args_json,
       args_hash, entity_versions_json, creator_staff_id, idempotency_key,
       created_at_epoch, expires_at_epoch, status, effective_risk,
       policy_outcome, requires_other_approver, consumed_by_staff_id, consumed_at_epoch
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, '1.0.0', $5::jsonb,
       $6, $7::jsonb, $8::uuid, $9::uuid, $10, $11, 'consumed', 'R5',
       'step_up', true, $12::uuid, $10
     )`,
    [
      operationRef,
      rows.orgId,
      rows.storeId,
      `ai.provider_credential.${operation}`,
      JSON.stringify(args),
      argsHash,
      JSON.stringify(versions),
      rows.adminId,
      idempotencyKey,
      now,
      now + 300,
      rows.approverId,
    ],
  );
  await admin.query(
    `INSERT INTO step_up_proofs (
       proof_id, org_id, store_id, pending_action_ref, args_hash,
       entity_versions_json, idempotency_key, requester_staff_id,
       approver_staff_id, session_id, session_version, issued_at_epoch,
       expires_at_epoch, status, consumed_at_epoch
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb, $7::uuid,
       $8::uuid, $9::uuid, $10::uuid, 1, $11, $12, 'consumed', $11
     )`,
    [
      proofRef,
      rows.orgId,
      rows.storeId,
      operationRef,
      argsHash,
      JSON.stringify(versions),
      idempotencyKey,
      rows.adminId,
      rows.approverId,
      rows.sessionId,
      now,
      now + 300,
    ],
  );
}

function storedCredential(rows: Fixture): StoredCredential {
  return Object.freeze({
    id: rows.credentialId,
    orgId: rows.orgId,
    providerCode: "official-test",
    credentialVersion: 1,
    rowVersion: 1,
    status: "pending_verification",
    envelope: Object.freeze({
      ciphertext: Buffer.alloc(32, 1),
      nonce: Buffer.alloc(12, 2),
      authTag: Buffer.alloc(16, 3),
      wrappedDek: Buffer.alloc(32, 4),
      kmsKeyId: "fixture-kms",
      kmsKeyVersion: "v1",
      schemaVersion: 1,
    }),
    last4: "test",
    createdByStaffId: rows.adminId,
    createdAt: FUTURE,
    updatedByStaffId: rows.adminId,
    updatedAt: FUTURE,
    activatedAt: null,
    revokedAt: null,
    supersededAt: null,
  });
}

async function bindOperation(client: SqlClient, operationRef: string, proofRef: string) {
  await client.query(
    `SELECT set_config('app.byok_operation_ref', $1, true),
            set_config('app.byok_proof_ref', $2, true)`,
    [operationRef, proofRef],
  );
}

async function cleanup(admin: PgPool, rows: Fixture): Promise<void> {
  await admin.query("DELETE FROM ai_provider_keys WHERE org_id = $1::uuid", [rows.orgId]);
  await admin.query("DELETE FROM ai_pending_actions WHERE org_id = $1::uuid", [rows.orgId]);
  await admin.query("DELETE FROM sessions WHERE org_id = $1::uuid", [rows.orgId]);
  await admin.query("DELETE FROM staff_store_roles WHERE org_id = ANY($1::uuid[])", [
    [rows.orgId, rows.otherOrgId],
  ]);
  await admin.query("DELETE FROM staffs WHERE org_id = ANY($1::uuid[])", [
    [rows.orgId, rows.otherOrgId],
  ]);
  await admin.query("DELETE FROM stores WHERE org_id = ANY($1::uuid[])", [
    [rows.orgId, rows.otherOrgId],
  ]);
  await admin.query("DELETE FROM customer_privacy_hmac_keys WHERE org_id = ANY($1::uuid[])", [
    [rows.orgId, rows.otherOrgId],
  ]);
  await admin.query("DELETE FROM orgs WHERE id = ANY($1::uuid[])", [[rows.orgId, rows.otherOrgId]]);
}

test(
  "real PG rejects direct BYOK mutation while guarded store paths remain usable",
  { skip: pgUrls === null },
  async () => {
    assert.ok(pgUrls);
    const admin = createPgPool({ connectionString: pgUrls.admin, max: 1 });
    const app = createPgPool({ connectionString: pgUrls.app, max: 3 });
    const rows = fixture();
    const store = createPgByokStore(app);
    try {
      await seedIdentity(admin, rows);
      await seedConsumedOperation(admin, rows, "replace", 0);
      await withClient(app, (client) =>
        withTenantTransaction(client, tenant(rows), async (transaction) => {
          await bindOperation(transaction, rows.replaceRef, rows.replaceProofRef);
          await store.stageCredential(storedCredential(rows), {
            tenant: tenant(rows),
            client: transaction,
          });
        }),
      );
      const staged = await admin.query<Readonly<{ created_at: Date; row_version: number }>>(
        `SELECT created_at, row_version FROM ai_provider_keys WHERE id = $1::uuid`,
        [rows.credentialId],
      );
      assert.equal(staged.rows[0]?.row_version, 1);
      assert.notEqual(staged.rows[0]?.created_at.toISOString(), FUTURE.toISOString());

      for (const sql of [
        "INSERT INTO ai_provider_keys (id) VALUES ($1::uuid)",
        "UPDATE ai_provider_keys SET status = 'active' WHERE id = $1::uuid",
        "UPDATE ai_provider_keys SET wrapped_dek = decode(repeat('ff', 32), 'hex') WHERE id = $1::uuid",
        "UPDATE ai_provider_keys SET updated_at = '2099-01-01' WHERE id = $1::uuid",
      ]) {
        await assert.rejects(() =>
          withClient(app, (client) =>
            withTenantTransaction(client, tenant(rows), (transaction) =>
              transaction.query(sql, [rows.credentialId]),
            ),
          ),
        );
      }
      await assert.rejects(() =>
        withClient(app, (client) =>
          withTenantTransaction(client, tenant(rows), (transaction) =>
            transaction.query(
              "SELECT public.ai_provider_key_verify_transition($1::uuid, 1, 'active')",
              [rows.credentialId],
            ),
          ),
        ),
      );
      await assert.rejects(() =>
        withClient(app, (client) =>
          withTenantTransaction(client, tenant(rows), (transaction) =>
            transaction.query(
              `SELECT public.ai_provider_key_rewrap(
                 $1::uuid, 1, decode(repeat('ee', 32), 'hex'), 'forged', 'v9'
               )`,
              [rows.credentialId],
            ),
          ),
        ),
      );
      await assert.rejects(() =>
        withClient(app, (client) =>
          withTenantTransaction(client, tenant(rows, rows.staffId), async (transaction) => {
            await bindOperation(transaction, rows.replaceRef, rows.replaceProofRef);
            await transaction.query(
              `SELECT public.ai_provider_key_stage(
                 $1::uuid, 'official-test', 2, decode('aa', 'hex'),
                 decode(repeat('aa', 12), 'hex'), decode(repeat('aa', 16), 'hex'),
                 decode(repeat('aa', 32), 'hex'), 'forged', 'v1', 1, 'test'
               )`,
              [randomUUID()],
            );
          }),
        ),
      );

      const beforeRewrap = await admin.query(
        `SELECT ciphertext, nonce, auth_tag, wrapped_dek, row_version
           FROM ai_provider_keys WHERE id = $1::uuid`,
        [rows.credentialId],
      );
      await withClient(admin, (client) =>
        withTenantTransaction(client, tenant(rows), async (transaction) => {
          await transaction.query("SET LOCAL ROLE laundry_owner");
          const changed = await transaction.query<Readonly<{ changed: boolean }>>(
            `SELECT public.ai_provider_key_rewrap(
               $1::uuid, 1, decode(repeat('dd', 32), 'hex'), 'rotated-kms', 'v2'
             ) AS changed`,
            [rows.credentialId],
          );
          assert.equal(changed.rows[0]?.changed, true);
        }),
      );
      const afterRewrap = await admin.query(
        `SELECT ciphertext, nonce, auth_tag, wrapped_dek, row_version
           FROM ai_provider_keys WHERE id = $1::uuid`,
        [rows.credentialId],
      );
      assert.deepEqual(afterRewrap.rows[0]?.ciphertext, beforeRewrap.rows[0]?.ciphertext);
      assert.deepEqual(afterRewrap.rows[0]?.nonce, beforeRewrap.rows[0]?.nonce);
      assert.deepEqual(afterRewrap.rows[0]?.auth_tag, beforeRewrap.rows[0]?.auth_tag);
      assert.notDeepEqual(afterRewrap.rows[0]?.wrapped_dek, beforeRewrap.rows[0]?.wrapped_dek);
      assert.equal(afterRewrap.rows[0]?.row_version, 2);

      await seedConsumedOperation(admin, rows, "revoke", 2);
      const revokeOnce = () =>
        withClient(app, (client) =>
          withTenantTransaction(client, tenant(rows), async (transaction) => {
            await bindOperation(transaction, rows.revokeRef, rows.revokeProofRef);
            return store.revokeCredential(rows.credentialId, rows.adminId, FUTURE, {
              tenant: tenant(rows),
              client: transaction,
            });
          }),
        );
      const concurrent = await Promise.all([revokeOnce(), revokeOnce()]);
      assert.equal(concurrent.filter((result) => result?.status === "revoked").length, 1);
      assert.equal(concurrent.filter((result) => result === null).length, 1);
      const revoked = concurrent.find((result) => result !== null);
      assert.notEqual(revoked?.updated_at, FUTURE.toISOString());
      const otherTenant = Object.freeze({
        orgId: rows.otherOrgId,
        storeId: rows.otherStoreId,
        staffId: rows.otherAdminId,
      });
      const hidden = await withClient(app, (client) =>
        withTenantTransaction(client, otherTenant, (transaction) =>
          transaction.query("SELECT id FROM ai_provider_keys WHERE id = $1::uuid", [
            rows.credentialId,
          ]),
        ),
      );
      assert.equal(hidden.rowCount, 0);
      assert.deepEqual(await store.listModels(), []);
    } finally {
      await cleanup(admin, rows);
      await Promise.all([admin.end(), app.end()]);
    }
  },
);

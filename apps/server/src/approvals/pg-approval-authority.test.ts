import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { withTenantTransaction } from "../db/tenant-transaction.js";
import { createPgPool, resolvePgUrls, withClient, type PgPool } from "../db/pg-pool.js";
import type { TenantContext } from "../db/types.js";
import { createPendingActionSnapshot } from "../pending-actions/store.js";
import type { PendingAction } from "../pending-actions/types.js";
import { createPgApprovalStore } from "./pg-store.js";
import { ApprovalStoreError } from "./types.js";

const pgUrls = resolvePgUrls(process.env);

type Fixture = Readonly<{
  orgId: string;
  storeId: string;
  otherStoreId: string;
  requesterId: string;
  approverId: string;
  otherAdminId: string;
}>;

const fixture = (): Fixture =>
  Object.freeze({
    orgId: randomUUID(),
    storeId: randomUUID(),
    otherStoreId: randomUUID(),
    requesterId: randomUUID(),
    approverId: randomUUID(),
    otherAdminId: randomUUID(),
  });

const tenant = (rows: Fixture, staffId: string, storeId = rows.storeId): TenantContext =>
  Object.freeze({ orgId: rows.orgId, storeId, staffId });

async function seedIdentity(admin: PgPool, rows: Fixture): Promise<void> {
  const now = new Date();
  await admin.query(
    `INSERT INTO orgs (id, code, name, created_at, updated_at)
     VALUES ($1::uuid, $2, 'Approval PG', $3, $3)`,
    [rows.orgId, `approval-${rows.orgId}`, now],
  );
  await admin.query(
    `INSERT INTO stores (id, org_id, code, name, created_at, updated_at)
     VALUES ($1::uuid, $3::uuid, 'main', 'Main', $4, $4),
            ($2::uuid, $3::uuid, 'other', 'Other', $4, $4)`,
    [rows.storeId, rows.otherStoreId, rows.orgId, now],
  );
  await admin.query(
    `INSERT INTO staffs (
       id, org_id, username, password_hash, display_name, is_active,
       permission_version, created_at, updated_at
     ) VALUES
       ($1::uuid, $4::uuid, 'requester', 'fixture', 'Requester', true, 1, $5, $5),
       ($2::uuid, $4::uuid, 'approver', 'fixture', 'Approver', true, 1, $5, $5),
       ($3::uuid, $4::uuid, 'other-admin', 'fixture', 'Other', true, 1, $5, $5)`,
    [rows.requesterId, rows.approverId, rows.otherAdminId, rows.orgId, now],
  );
  await admin.query(
    `INSERT INTO staff_store_roles (
       id, org_id, store_id, staff_id, role, is_active, created_at, updated_at
     ) VALUES
       ($1::uuid, $7::uuid, $8::uuid, $2::uuid, 'admin', true, $10, $10),
       ($3::uuid, $7::uuid, $8::uuid, $4::uuid, 'admin', true, $10, $10),
       ($5::uuid, $7::uuid, $9::uuid, $6::uuid, 'admin', true, $10, $10)`,
    [
      randomUUID(),
      rows.requesterId,
      randomUUID(),
      rows.approverId,
      randomUUID(),
      rows.otherAdminId,
      rows.orgId,
      rows.storeId,
      rows.otherStoreId,
      now,
    ],
  );
}

function pending(rows: Fixture, risk: "R4" | "R5" = "R4"): PendingAction {
  const now = Math.floor(Date.now() / 1_000);
  return createPendingActionSnapshot({
    nonce: randomUUID(),
    command: "payment.refund",
    commandVersion: "0.2.0",
    args: Object.freeze({
      order_id: randomUUID(),
      ref_payment_id: randomUUID(),
      amount_cents: 100,
      method: "cash",
      reason: "duplicate capture",
    }),
    entityVersions: Object.freeze([
      Object.freeze({ entityType: "payment", entityId: randomUUID(), version: 1 }),
    ]),
    creatorStaffId: rows.requesterId,
    orgId: rows.orgId,
    storeId: rows.storeId,
    idempotencyKey: randomUUID(),
    createdAt: now,
    ttlSeconds: 300,
    effectiveRisk: risk,
    policyOutcome: "step_up",
    requiresOtherApprover: true,
  });
}

async function seedPending(admin: PgPool, action: PendingAction): Promise<void> {
  await admin.query(
    `INSERT INTO ai_pending_actions (
       nonce, org_id, store_id, command, command_version, args_json, args_hash,
       entity_versions_json, creator_staff_id, idempotency_key, created_at_epoch,
       expires_at_epoch, status, effective_risk, policy_outcome, requires_other_approver
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7, $8::jsonb,
       $9::uuid, $10::uuid, $11, $12, 'pending', $13, $14, $15
     )`,
    [
      action.nonce,
      action.orgId,
      action.storeId,
      action.command,
      action.commandVersion,
      JSON.stringify(action.args),
      action.argsHash,
      JSON.stringify(action.entityVersions),
      action.creatorStaffId,
      action.idempotencyKey,
      action.createdAt,
      action.expiresAt,
      action.effectiveRisk,
      action.policyOutcome,
      action.requiresOtherApprover,
    ],
  );
}

async function cleanup(admin: PgPool, rows: Fixture): Promise<void> {
  await admin.query("DELETE FROM ai_approval_requests WHERE org_id = $1::uuid", [rows.orgId]);
  await admin.query("DELETE FROM ai_pending_actions WHERE org_id = $1::uuid", [rows.orgId]);
  await admin.query("DELETE FROM staff_store_roles WHERE org_id = $1::uuid", [rows.orgId]);
  await admin.query("DELETE FROM staffs WHERE org_id = $1::uuid", [rows.orgId]);
  await admin.query("DELETE FROM stores WHERE org_id = $1::uuid", [rows.orgId]);
  await admin.query("DELETE FROM customer_privacy_hmac_keys WHERE org_id = $1::uuid", [rows.orgId]);
  await admin.query("DELETE FROM orgs WHERE id = $1::uuid", [rows.orgId]);
}

test(
  "real PG enforces scoped other-admin approval, frozen authority and single consumption",
  { skip: pgUrls === null },
  async () => {
    assert.ok(pgUrls);
    const admin = createPgPool({ connectionString: pgUrls.admin, max: 1 });
    const app = createPgPool({ connectionString: pgUrls.app, max: 3 });
    const rows = fixture();
    const store = createPgApprovalStore(app);
    const action = pending(rows);
    try {
      await seedIdentity(admin, rows);
      await seedPending(admin, action);
      const request = await withClient(app, (client) =>
        withTenantTransaction(client, tenant(rows, rows.requesterId), (transaction) =>
          store.create(randomUUID(), action, 1, {
            tenant: tenant(rows, rows.requesterId),
            client: transaction,
          }),
        ),
      );

      const hidden = await store.get(request.approvalRef, action.createdAt + 1, {
        tenant: tenant(rows, rows.otherAdminId, rows.otherStoreId),
      });
      assert.equal(hidden, null);
      await assert.rejects(
        withClient(app, (client) =>
          withTenantTransaction(client, tenant(rows, rows.requesterId), (transaction) =>
            store.decide(
              request.approvalRef,
              request.rowVersion,
              "approved",
              null,
              1,
              action.createdAt + 1,
              { tenant: tenant(rows, rows.requesterId), client: transaction },
            ),
          ),
        ),
        (error: unknown) =>
          error instanceof ApprovalStoreError && error.code === "SELF_APPROVE_FORBIDDEN",
      );
      await assert.rejects(() =>
        withClient(app, (client) =>
          withTenantTransaction(client, tenant(rows, rows.approverId), (transaction) =>
            transaction.query(
              "SELECT public.ai_approval_request_decide($1::uuid, NULL, 'approved', NULL)",
              [request.approvalRef],
            ),
          ),
        ),
      );

      const approved = await withClient(app, (client) =>
        withTenantTransaction(client, tenant(rows, rows.approverId), (transaction) =>
          store.decide(
            request.approvalRef,
            request.rowVersion,
            "approved",
            null,
            1,
            action.createdAt + 1,
            { tenant: tenant(rows, rows.approverId), client: transaction },
          ),
        ),
      );
      assert.equal(approved.status, "approved");
      await assert.rejects(() =>
        withClient(app, (client) =>
          withTenantTransaction(client, tenant(rows, rows.requesterId), (transaction) =>
            transaction.query(
              `SELECT public.ai_approval_request_consume(
                 $1::uuid, NULL, NULL, NULL, NULL
               )`,
              [request.approvalRef],
            ),
          ),
        ),
      );

      await admin.query(
        "UPDATE staffs SET permission_version = 2 WHERE org_id = $1::uuid AND id = $2::uuid",
        [rows.orgId, rows.approverId],
      );
      const consume = () =>
        withClient(app, (client) =>
          withTenantTransaction(client, tenant(rows, rows.requesterId), (transaction) =>
            store.consume(request.approvalRef, action, action.createdAt + 2, {
              tenant: tenant(rows, rows.requesterId),
              client: transaction,
            }),
          ),
        );
      await assert.rejects(
        consume(),
        (error: unknown) =>
          error instanceof ApprovalStoreError && error.code === "AUTHORITY_CHANGED",
      );
      await admin.query(
        "UPDATE staffs SET permission_version = 1 WHERE org_id = $1::uuid AND id = $2::uuid",
        [rows.orgId, rows.approverId],
      );
      assert.equal((await consume()).approval.status, "consumed");
      await assert.rejects(
        consume(),
        (error: unknown) =>
          error instanceof ApprovalStoreError && error.code === "AUTHORITY_CHANGED",
      );

      const r5 = pending(rows, "R5");
      await seedPending(admin, r5);
      await assert.rejects(
        withClient(app, (client) =>
          withTenantTransaction(client, tenant(rows, rows.requesterId), (transaction) =>
            store.create(randomUUID(), r5, 1, {
              tenant: tenant(rows, rows.requesterId),
              client: transaction,
            }),
          ),
        ),
        (error: unknown) => error instanceof ApprovalStoreError && error.code === "INVALID_PENDING",
      );
    } finally {
      await cleanup(admin, rows);
      await Promise.all([admin.end(), app.end()]);
    }
  },
);

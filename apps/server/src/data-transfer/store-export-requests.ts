import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthorizedSession } from "../auth/session-view.js";
import { writeAudit } from "../audit/write-audit.js";
import type { PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { exportPolicyHash, verifyExportSchema } from "./store-export-policy.js";
import {
  signStoreExportApproval,
  verifyStoreExportApproval,
  type StoreExportApprovalClaims,
} from "./store-export-authority.js";

const currentAuthority = `JOIN sessions s ON s.org_id=t.org_id AND s.store_id=t.store_id AND s.id=t.session_id
  JOIN staffs a ON a.org_id=t.org_id AND a.id=t.actor_id
  JOIN staff_store_roles r ON r.org_id=t.org_id AND r.store_id=t.store_id AND r.staff_id=t.actor_id`;
const validAuthority = `s.staff_id=t.actor_id AND s.status='active'
  AND s.session_version=t.session_version AND s.permission_version=t.permission_version
  AND a.permission_version=t.permission_version AND a.is_active
  AND r.role='admin' AND r.is_privacy_admin AND r.is_active`;
export async function approveStoreExport(
  pool: PgPool,
  authorized: AuthorizedSession,
  policyHash: string,
  signingSecret: string,
) {
  if (policyHash !== exportPolicyHash()) throw new Error("STORE_EXPORT_POLICY_CHANGED");
  const s = authorized.session;
  const tenant = { orgId: s.org_id, storeId: s.store_id, staffId: s.staff_id };
  const requestId = randomUUID();
  const now = new Date();
  const expiresAt = now.getTime() + 10 * 60_000;
  const signature = signStoreExportApproval(signingSecret, {
    id: requestId,
    org_id: s.org_id,
    store_id: s.store_id,
    actor_id: s.staff_id,
    session_id: s.session_id,
    session_version: s.session_version,
    permission_version: s.permission_version,
    policy_sha256: policyHash,
    approved_at_ms: now.getTime(),
    expires_at_ms: expiresAt,
  });
  await withPoolClient(pool, (client) =>
    withTenantTransaction(client, tenant, async () => {
      await verifyExportSchema(client);
      const authority = await client.query(
        `SELECT s.id FROM sessions s
      JOIN staffs a ON a.org_id=s.org_id AND a.id=s.staff_id
      JOIN staff_store_roles r ON r.org_id=s.org_id AND r.store_id=s.store_id AND r.staff_id=s.staff_id
      WHERE s.id=$1 AND s.staff_id=$2 AND s.session_version=$3 AND s.permission_version=$4
        AND s.status='active' AND a.permission_version=$4 AND a.is_active
        AND r.role='admin' AND r.is_privacy_admin AND r.is_active FOR SHARE OF s,a,r`,
        [s.session_id, s.staff_id, s.session_version, s.permission_version],
      );
      if (authority.rows.length !== 1) throw new Error("STORE_EXPORT_AUTHORIZATION_INVALID");
      await client.query(
        `INSERT INTO store_export_requests(id,org_id,store_id,actor_id,session_id,
      session_version,permission_version,policy_sha256,approved_at,expires_at,approval_signature)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          requestId,
          tenant.orgId,
          tenant.storeId,
          tenant.staffId,
          s.session_id,
          s.session_version,
          s.permission_version,
          policyHash,
          now,
          new Date(expiresAt),
          signature,
        ],
      );
      await exportAudit(client, tenant, requestId, "authorize", {
        policy_sha256: policyHash,
        expires_at: expiresAt,
      });
    }),
  );
  return { request_id: requestId, expires_at: expiresAt };
}

export async function readStoreExportActor(
  client: SqlClient,
  requestId: string,
  signingSecret: string,
): Promise<string> {
  z.uuid().parse(requestId);
  const result = await client.query<StoreExportApprovalClaims & { approval_signature: string }>(
    `SELECT t.id,t.org_id,t.store_id,t.actor_id,t.session_id,t.session_version,t.permission_version,
      t.policy_sha256,(extract(epoch FROM t.approved_at)*1000)::bigint AS approved_at_ms,
      (extract(epoch FROM t.expires_at)*1000)::bigint AS expires_at_ms,t.approval_signature
      FROM store_export_requests t
    ${currentAuthority} WHERE t.id=$1 AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>now()
    AND t.policy_sha256=$2 AND ${validAuthority} FOR UPDATE OF t FOR SHARE OF s,a,r`,
    [requestId, exportPolicyHash()],
  );
  const actor = result.rows[0]?.actor_id;
  if (!actor || result.rows.length !== 1) throw new Error("STORE_EXPORT_AUTHORIZATION_INVALID");
  const { approval_signature, ...claims } = result.rows[0]!;
  verifyStoreExportApproval(signingSecret, claims, approval_signature);
  return actor;
}
export async function consumeStoreExport(
  client: SqlClient,
  tenant: TenantContext,
  requestId: string,
  manifestSha256: string,
) {
  const result = await client.query(
    `UPDATE store_export_requests SET consumed_at=now(),manifest_sha256=$2
    WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING id`,
    [requestId, manifestSha256],
  );
  if (result.rowCount !== 1) throw new Error("STORE_EXPORT_AUTHORIZATION_INVALID");
  await exportAudit(client, tenant, requestId, "prepare", {
    manifest_sha256: manifestSha256,
    policy_sha256: exportPolicyHash(),
  });
}
async function exportAudit(
  client: SqlClient,
  tenant: TenantContext,
  requestId: string,
  phase: string,
  receipt: unknown,
) {
  await writeAudit(client, {
    id: randomUUID(),
    ...tenant,
    staffId: tenant.staffId ?? null,
    via: "ui",
    command: `store.export.${phase}`,
    idempotencyKey: requestId,
    dryRun: false,
    entity: "store_export_requests",
    entityId: requestId,
    beforeJson: null,
    afterJson: JSON.stringify(receipt),
    ip: null,
    deviceId: null,
    at: new Date(),
  });
}

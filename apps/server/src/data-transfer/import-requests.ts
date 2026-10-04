import { z } from "zod";
import type { AuthorizedSession } from "../auth/session-view.js";
import { writeAudit } from "../audit/write-audit.js";
import { randomUUID } from "node:crypto";
import type { PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { MigrationAuthorization } from "./pg-v1-import.js";

const hash = z.string().regex(/^[0-9a-f]{64}$/u);
export const migrationApprovalSchema = z
  .object({
    source_sha256: hash,
    plan_sha256: hash,
    photos_sha256: hash,
    photo_associations_reviewed: z.literal(true),
    password: z.string().min(1).max(1024),
  })
  .strict();
export type MigrationDigests = Pick<
  z.infer<typeof migrationApprovalSchema>,
  "source_sha256" | "plan_sha256" | "photos_sha256"
>;

export async function approveMigrationRequest(
  pool: PgPool,
  authorized: AuthorizedSession,
  requestId: string,
  digests: MigrationDigests,
  now = new Date(),
): Promise<number> {
  z.uuid().parse(requestId);
  // TypeScript Pick does not strip extra runtime properties. Re-project at the
  // persistence boundary so a caller's password can never enter the audit JSON.
  const approvedDigests = migrationApprovalSchema
    .pick({
      source_sha256: true,
      plan_sha256: true,
      photos_sha256: true,
    })
    .strip()
    .parse(digests);
  const session = authorized.session;
  const tenant = { orgId: session.org_id, storeId: session.store_id, staffId: session.staff_id };
  const expiresAt = now.getTime() + 10 * 60_000;
  await withPoolClient(pool, (client) =>
    withTenantTransaction(client, tenant, async () => {
      const current = await client.query<{ ok: boolean }>(
        `SELECT true AS ok FROM sessions s
      JOIN staffs staff ON staff.org_id=s.org_id AND staff.id=s.staff_id
      JOIN staff_store_roles r ON r.org_id=s.org_id AND r.store_id=s.store_id AND r.staff_id=s.staff_id
      WHERE s.id=$1 AND s.staff_id=$2 AND s.status='active' AND s.session_version=$3
        AND s.permission_version=$4 AND staff.permission_version=$4 AND staff.is_active
        AND r.is_active AND r.role='admin' AND r.is_privacy_admin FOR SHARE OF s, staff, r`,
        [session.session_id, session.staff_id, session.session_version, session.permission_version],
      );
      if (current.rows.length !== 1) throw new Error("V1_MIGRATION_AUTHORIZATION_INVALID");
      await client.query(
        `INSERT INTO v1_import_requests (id,org_id,store_id,actor_id,session_id,
      session_version,permission_version,source_sha256,plan_sha256,photos_sha256,approved_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          requestId,
          tenant.orgId,
          tenant.storeId,
          tenant.staffId,
          session.session_id,
          session.session_version,
          session.permission_version,
          approvedDigests.source_sha256,
          approvedDigests.plan_sha256,
          approvedDigests.photos_sha256,
          now,
          new Date(expiresAt),
        ],
      );
      await writeAudit(client, {
        id: randomUUID(),
        ...tenant,
        orgId: tenant.orgId,
        storeId: tenant.storeId,
        staffId: tenant.staffId,
        via: "ui",
        command: "migration.v1.authorize",
        idempotencyKey: requestId,
        dryRun: false,
        entity: "v1_import_requests",
        entityId: requestId,
        beforeJson: null,
        afterJson: JSON.stringify({ ...approvedDigests, expires_at: expiresAt }),
        ip: null,
        deviceId: session.device_id,
        at: now,
      });
    }),
  );
  return expiresAt;
}

type RequestRow = Readonly<{
  actor_id: string;
  permission_version: number;
  source_sha256: string;
  plan_sha256: string;
  photos_sha256: string;
  expires_at: Date;
  consumed_at: Date | null;
}>;

export async function readApprovedMigrationRequest(
  pool: PgPool,
  configuredTenant: TenantContext,
  requestId: string,
): Promise<MigrationAuthorization> {
  z.uuid().parse(requestId);
  return withPoolClient(pool, (client) =>
    withTenantTransaction(client, configuredTenant, async () => {
      const result = await client.query<RequestRow>(
        `SELECT t.actor_id,t.permission_version,
      t.source_sha256,t.plan_sha256,t.photos_sha256,t.expires_at,t.consumed_at FROM v1_import_requests t
      JOIN sessions s ON s.org_id=t.org_id AND s.store_id=t.store_id AND s.id=t.session_id
      JOIN staffs staff ON staff.org_id=t.org_id AND staff.id=t.actor_id
      JOIN staff_store_roles r ON r.org_id=t.org_id AND r.store_id=t.store_id AND r.staff_id=t.actor_id
      WHERE t.id=$1 AND t.expires_at>now() AND s.status='active'
        AND s.staff_id=t.actor_id AND s.session_version=t.session_version
        AND s.permission_version=t.permission_version AND staff.permission_version=t.permission_version
        AND staff.is_active AND r.is_active AND r.role='admin' AND r.is_privacy_admin`,
        [requestId],
      );
      const row = result.rows[0];
      if (!row || result.rows.length !== 1) throw new Error("V1_MIGRATION_AUTHORIZATION_INVALID");
      return {
        ...configuredTenant,
        staffId: row.actor_id,
        requestId,
        permissionVersion: row.permission_version,
        sourceSha256: row.source_sha256,
        planSha256: row.plan_sha256,
        photoManifestSha256: row.photos_sha256,
        expiresAt: row.expires_at.getTime(),
        photoAssociationsReviewed: true,
      };
    }),
  );
}

export async function lockMigrationRequest(
  client: SqlClient,
  auth: MigrationAuthorization,
): Promise<boolean> {
  const result = await client.query<RequestRow>(
    `SELECT t.actor_id,t.permission_version,t.source_sha256,
    t.plan_sha256,t.photos_sha256,t.expires_at,t.consumed_at FROM v1_import_requests t
    JOIN sessions s ON s.org_id=t.org_id AND s.store_id=t.store_id AND s.id=t.session_id
    WHERE t.id=$1 AND s.status='active' AND s.staff_id=t.actor_id
      AND s.session_version=t.session_version AND s.permission_version=t.permission_version
    FOR UPDATE OF t FOR SHARE OF s`,
    [auth.requestId],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.actor_id !== auth.staffId ||
    row.permission_version !== auth.permissionVersion ||
    row.source_sha256 !== auth.sourceSha256 ||
    row.plan_sha256 !== auth.planSha256 ||
    row.photos_sha256 !== auth.photoManifestSha256 ||
    row.expires_at.getTime() !== auth.expiresAt
  ) {
    throw new Error("V1_MIGRATION_AUTHORIZATION_INVALID");
  }
  return row.consumed_at !== null;
}

export async function consumeMigrationRequest(client: SqlClient, requestId: string): Promise<void> {
  const consumed = await client.query(
    `UPDATE v1_import_requests SET consumed_at=now()
    WHERE id=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING id`,
    [requestId],
  );
  if (consumed.rowCount !== 1) throw new Error("V1_MIGRATION_AUTHORIZATION_INVALID");
}

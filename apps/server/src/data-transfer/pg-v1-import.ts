import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validateMigrationPlan, type V2PostgresMigrationLoader } from "@laundry/migrate-v1/plan";
import { writeAudit } from "../audit/write-audit.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { PgPool } from "../db/pg-pool.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { PhotoFileStore } from "../photo/file-store.js";
import { assertSupportedLegacySettings, migrationId } from "./import-legacy.js";
import { prepareMigrationPhotos } from "./import-photos.js";
import { buildImportRows, verifyImportRows, writeImportRows } from "./import-rows.js";

import { lockMigrationRequest, consumeMigrationRequest } from "./import-requests.js";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const authorizationSchema = z
  .object({
    requestId: z.uuid(),
    permissionVersion: z.number().int().positive(),
    orgId: z.uuid(),
    storeId: z.uuid(),
    staffId: z.uuid(),
    sourceSha256: sha256,
    planSha256: sha256,
    photoManifestSha256: sha256,
    expiresAt: z.number().int().safe(),
    photoAssociationsReviewed: z.literal(true),
  })
  .strict();
export type MigrationAuthorization = z.infer<typeof authorizationSchema>;
export type MigrationBackupPoint = Readonly<{
  id: string;
  sourceSha256: string;
  orgId: string;
  storeId: string;
  verified: true;
}>;
export type PgV1MigrationOptions = Readonly<{
  pool: PgPool;
  /** Fixed configured app-role URL, used only for exact target binding. */
  targetDatabaseUrl: string;
  /** Authenticated, stepped-up server session; never populate from source/CLI IDs. */
  authorize: () => Promise<MigrationAuthorization>;
  /** Must hold the local runtime's exclusive maintenance lease around operation. */
  withMaintenanceLease: <T>(operation: () => Promise<T>) => Promise<T>;
  createBackupPoint: (scope: TenantContext, sourceSha256: string) => Promise<MigrationBackupPoint>;
  photoSourceRoot: string;
  photoFiles: PhotoFileStore;
  now?: () => Date;
}>;

async function checkActor(client: SqlClient, tenant: MigrationAuthorization): Promise<string> {
  const role = await client.query<{
    current_user: string;
    rolbypassrls: boolean;
    rolsuper: boolean;
  }>("SELECT current_user, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user");
  if (
    role.rows[0]?.current_user !== "laundry_app" ||
    role.rows[0].rolbypassrls ||
    role.rows[0].rolsuper
  ) {
    throw new Error("V1_MIGRATION_APP_ROLE_REQUIRED");
  }
  const actor = await client.query<{ timezone: string }>(
    `SELECT stores.timezone FROM stores JOIN staff_store_roles roles
       ON roles.org_id = stores.org_id AND roles.store_id = stores.id
     JOIN staffs ON staffs.org_id = roles.org_id AND staffs.id = roles.staff_id
     WHERE stores.org_id = $1::uuid AND stores.id = $2::uuid AND staffs.id = $3::uuid
       AND staffs.is_active AND roles.is_active AND roles.role = 'admin' AND roles.is_privacy_admin
       AND staffs.permission_version = $4
     FOR SHARE OF roles, staffs`,
    [tenant.orgId, tenant.storeId, tenant.staffId, tenant.permissionVersion],
  );
  if (actor.rows.length !== 1) throw new Error("V1_MIGRATION_ADMIN_REQUIRED");
  return actor.rows[0]!.timezone;
}

async function assertEmptyTarget(client: SqlClient): Promise<void> {
  const result = await client.query<{ empty: boolean }>(
    `SELECT NOT EXISTS(SELECT 1 FROM customers) AND NOT EXISTS(SELECT 1 FROM orders)
        AND NOT EXISTS(SELECT 1 FROM v1_import_batches) AS empty`,
  );
  if (result.rows[0]?.empty !== true) throw new Error("V1_MIGRATION_TARGET_NOT_EMPTY");
}

/** Schema-owned loader: app RLS, reviewed source/plan, verified backup, one
 * transaction for imported business records, receipt, reconciliation and audit. */
export function createPgV1MigrationLoader(
  options: PgV1MigrationOptions,
): V2PostgresMigrationLoader {
  const now = options.now ?? (() => new Date());
  const maintenance = new AsyncLocalStorage<{ backup: MigrationBackupPoint | null }>();
  return Object.freeze({
    kind: "v2-postgresql" as const,
    withExclusiveMaintenance: (operation) =>
      options.withMaintenanceLease(() => maintenance.run({ backup: null }, operation)),
    createBackupPoint: async (request) => {
      const lease = maintenance.getStore();
      if (!lease) throw new Error("V1_MIGRATION_MAINTENANCE_REQUIRED");
      if (request.targetDatabaseUrl !== options.targetDatabaseUrl) {
        throw new Error("V1_MIGRATION_TARGET_MISMATCH");
      }
      const auth = authorizationSchema.parse(await options.authorize());
      if (auth.sourceSha256 !== request.sourceBackupSha256 || auth.expiresAt <= now().getTime()) {
        throw new Error("V1_MIGRATION_AUTHORIZATION_INVALID");
      }
      const backup = await options.createBackupPoint(auth, auth.sourceSha256);
      if (
        !backup.verified ||
        backup.id.length < 1 ||
        backup.id.length > 256 ||
        backup.sourceSha256 !== auth.sourceSha256 ||
        backup.orgId !== auth.orgId ||
        backup.storeId !== auth.storeId
      )
        throw new Error("V1_MIGRATION_BACKUP_INVALID");
      lease.backup = Object.freeze({ ...backup });
      return Object.freeze({ id: backup.id });
    },
    applyIdempotently: async (request) => {
      const auth = authorizationSchema.parse(await options.authorize());
      const { plan, report, planSha256 } = validateMigrationPlan(request.plan, request.report);
      const backup = maintenance.getStore()?.backup ?? null;
      if (
        backup === null ||
        backup.id !== request.backupPointId ||
        backup.sourceSha256 !== plan.sourceBackupSha256 ||
        auth.sourceSha256 !== plan.sourceBackupSha256 ||
        auth.planSha256 !== planSha256 ||
        auth.expiresAt <= now().getTime() ||
        backup.orgId !== auth.orgId ||
        backup.storeId !== auth.storeId
      ) {
        throw new Error("V1_MIGRATION_AUTHORIZATION_INVALID");
      }
      assertSupportedLegacySettings(plan);
      const photos = await prepareMigrationPhotos(
        plan,
        options.photoSourceRoot,
        options.photoFiles,
        auth.photoManifestSha256,
      );
      const batchId = migrationId(`${auth.orgId}:${auth.storeId}:${plan.sourceBackupSha256}`);
      await withPoolClient(options.pool, (client) =>
        withTenantTransaction(
          client,
          {
            orgId: auth.orgId,
            storeId: auth.storeId,
            staffId: auth.staffId,
          },
          async () => {
            await client.query("SET LOCAL lock_timeout = '5s'");
            await client.query("SET LOCAL statement_timeout = '120s'");
            const timezone = await checkActor(client, auth);
            const consumed = await lockMigrationRequest(client, auth);
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 74))", [
              auth.orgId,
            ]);
            const existing = await client.query<{ plan_sha256: string }>(
              "SELECT plan_sha256 FROM v1_import_batches WHERE id = $1::uuid",
              [batchId],
            );
            const rows = buildImportRows(plan, auth, timezone, batchId, photos);
            if (existing.rows.length > 0) {
              if (!consumed) throw new Error("V1_MIGRATION_REQUEST_STATE_INVALID");
              if (existing.rows[0]?.plan_sha256 !== planSha256)
                throw new Error("V1_MIGRATION_CONFLICT");
              await verifyImportRows(client, rows);
              return;
            }
            if (consumed) throw new Error("V1_MIGRATION_REQUEST_STATE_INVALID");
            await assertEmptyTarget(client);
            await client.query(
              `INSERT INTO v1_import_batches (id, org_id, store_id, source_sha256, plan_sha256,
             mapping_version, backup_point_id, totals, actor_id, created_at)
           VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9)`,
              [
                batchId,
                auth.orgId,
                auth.storeId,
                plan.sourceBackupSha256,
                planSha256,
                backup.id,
                report.target,
                auth.staffId,
                now(),
              ],
            );
            await writeImportRows(client, rows);
            await verifyImportRows(client, rows);
            await consumeMigrationRequest(client, auth.requestId);
            await writeAudit(client, {
              id: randomUUID(),
              orgId: auth.orgId,
              storeId: auth.storeId,
              staffId: auth.staffId,
              via: "ui",
              command: "migration.v1.apply",
              idempotencyKey: batchId,
              dryRun: false,
              entity: "v1_import_batches",
              entityId: batchId,
              beforeJson: null,
              afterJson: JSON.stringify({
                source_sha256: plan.sourceBackupSha256,
                plan_sha256: planSha256,
                totals: report.target,
                mapping_version: 1,
              }),
              ip: null,
              deviceId: null,
              at: now(),
            });
          },
        ),
      );
    },
  });
}

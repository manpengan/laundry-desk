import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadV2Migration,
  reconcileMigration,
  transformV1Snapshot,
  validateMigrationPlan,
} from "@laundry/migrate-v1/plan";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { createPhotoFileStore } from "../photo/file-store.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { createPgV1MigrationLoader } from "./pg-v1-import.js";
import { reviewMigrationPhotos } from "./import-photos.js";
import { approveMigrationRequest } from "./import-requests.js";
import {
  migrationFixture,
  seedMigrationTenant,
  seedMigrationTicket,
} from "./import-test-fixture.js";

const urls = process.env.LAUNDRY_USE_LOCAL_PG === "1" ? resolvePgUrls() : null;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

test(
  "v1 PG import is atomic, RLS scoped, lossless, idempotent and privacy-erasable",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin });
    const app = createPgPool({ connectionString: urls.app });
    const dir = await realpath(await mkdtemp(join(tmpdir(), "laundry-v1-fixture-")));
    try {
      const tenant = await seedMigrationTenant(admin);
      const other = await seedMigrationTenant(admin);
      const snapshot = migrationFixture();
      const plan = transformV1Snapshot(snapshot);
      const report = reconcileMigration(snapshot, plan);
      const { planSha256 } = validateMigrationPlan(plan, report);
      await mkdir(join(dir, "source", "2024"), { recursive: true });
      await writeFile(join(dir, "source", "2024", "item.png"), png);
      const photoFiles = await createPhotoFileStore({ rootPath: join(dir, "photos") });
      const photos = await reviewMigrationPhotos(plan, join(dir, "source"));
      const auth = {
        ...tenant,
        requestId: randomUUID(),
        permissionVersion: 1,
        sourceSha256: plan.sourceBackupSha256,
        planSha256,
        photoManifestSha256: photos.sha256,
        expiresAt: Date.now() + 60_000,
        photoAssociationsReviewed: true as const,
      };
      const seeded = await seedMigrationTicket(admin, auth);
      const approvalId = randomUUID();
      const secretInput = {
        source_sha256: auth.sourceSha256,
        plan_sha256: auth.planSha256,
        photos_sha256: auth.photoManifestSha256,
        password: "synthetic-approval-password-must-not-persist",
      };
      const expiry = await approveMigrationRequest(
        app,
        {
          session: {
            session_id: seeded.sessionId,
            session_version: 1,
            org_id: tenant.orgId,
            store_id: tenant.storeId,
            staff_id: tenant.staffId,
            device_id: randomUUID(),
            permission_version: 1,
            authentication_method: "password",
            status: "active",
            family_id: randomUUID(),
            created_at: Math.floor(Date.now() / 1000),
            revoked_at: null,
          },
          authority: {
            staff_id: tenant.staffId,
            display_name: "Fixture",
            role: "admin",
            permission_version: 1,
            is_privacy_admin: true,
          },
        },
        approvalId,
        secretInput,
      );
      const approvalAudit = await admin.query(
        "SELECT after_json FROM audit_log WHERE org_id=$1 AND entity_id=$2",
        [tenant.orgId, approvalId],
      );
      assert.equal(typeof approvalAudit.rows[0]?.after_json, "string");
      assert.deepEqual(JSON.parse(approvalAudit.rows[0].after_json as string), {
        source_sha256: auth.sourceSha256,
        plan_sha256: auth.planSha256,
        photos_sha256: auth.photoManifestSha256,
        expires_at: expiry,
      });
      assert.equal(JSON.stringify(approvalAudit.rows).includes(secretInput.password), false);
      let lease = false;
      let backups = 0;
      const options = {
        pool: app,
        targetDatabaseUrl: urls.app,
        authorize: async () => auth,
        photoFiles,
        photoSourceRoot: join(dir, "source"),
        withMaintenanceLease: async <T>(operation: () => Promise<T>) => {
          assert.equal(lease, false);
          lease = true;
          try {
            return await operation();
          } finally {
            lease = false;
          }
        },
        createBackupPoint: async () => {
          assert.equal(lease, true);
          backups += 1;
          return {
            id: randomUUID(),
            ...tenant,
            sourceSha256: plan.sourceBackupSha256,
            verified: true as const,
          };
        },
      };
      const loader = createPgV1MigrationLoader(options);
      await assert.rejects(
        loader.applyIdempotently({ backupPointId: "fake", plan, report }),
        /AUTHORIZATION_INVALID/,
      );
      await loadV2Migration(loader, urls.app, plan, report);
      await loadV2Migration(loader, urls.app, plan, report);
      assert.equal(backups, 2);
      const batch = await admin.query("SELECT * FROM v1_import_batches WHERE org_id=$1", [
        tenant.orgId,
      ]);
      assert.equal(batch.rows.length, 1);
      assert.deepEqual(batch.rows[0].totals, report.target);
      assert.equal(JSON.stringify(batch.rows).includes("虚构顾客"), false);
      const audit = await admin.query(
        "SELECT count(*)::int AS count FROM audit_log WHERE org_id=$1 AND command='migration.v1.apply'",
        [tenant.orgId],
      );
      assert.equal(audit.rows[0].count, 1);
      const legacy = await admin.query(
        "SELECT metadata FROM v1_import_legacy_records WHERE org_id=$1 AND entity_type='order'",
        [tenant.orgId],
      );
      assert.equal(legacy.rows[0].metadata.staff_id, 7);
      assert.equal(legacy.rows[0].metadata.expected_pickup_at, null);
      const importedHistory = await admin.query(
        "SELECT entity_type,metadata FROM v1_import_legacy_records WHERE org_id=$1 AND entity_type LIKE 'legacy_%'",
        [tenant.orgId],
      );
      assert.equal(importedHistory.rows.length, 4);
      assert.equal(
        importedHistory.rows.filter((row) => row.entity_type === "legacy_sms").length,
        2,
      );
      assert.equal(JSON.stringify(importedHistory.rows).includes("password_hash"), false);
      const garments = await admin.query("SELECT note FROM garments WHERE org_id=$1", [
        tenant.orgId,
      ]);
      assert.ok(garments.rows.every((row) => row.note === "旧版衣物：虚构衬衫\n虚构袖口说明"));
      await withPoolClient(app, (client) =>
        withTenantTransaction(client, other, async () => {
          assert.equal((await client.query("SELECT id FROM v1_import_batches")).rows.length, 0);
        }),
      );
      await assert.rejects(
        withPoolClient(app, (client) =>
          withTenantTransaction(client, tenant, () =>
            client.query("UPDATE v1_import_batches SET mapping_version=1"),
          ),
        ),
        /permission denied/,
      );
      await withPoolClient(app, (client) =>
        withTenantTransaction(client, tenant, async () => {
          const erased = await client.query<{ anonymized: boolean }>(
            "SELECT * FROM customer_privacy_anonymize($1::uuid,$2,$3::uuid,$4)",
            [plan.customers[0]!.id, "customer_request", randomUUID(), new Date()],
          );
          assert.equal(erased.rows[0]?.anonymized, true);
        }),
      );
      const retained = await admin.query(
        "SELECT entity_type FROM v1_import_legacy_records WHERE org_id=$1",
        [tenant.orgId],
      );
      assert.deepEqual(retained.rows.map((row) => row.entity_type).sort(), [
        "legacy_staff",
        "setting",
      ]);
      await assert.rejects(
        loadV2Migration(loader, urls.app, plan, report),
        /DATABASE_RECONCILIATION_FAILED/,
      );
      // Fail at the audit boundary: no earlier business/receipt rows may commit.
      const failureTenant = await seedMigrationTenant(admin);
      const failedSnapshot = { ...snapshot, sourceBackupSha256: "b".repeat(64) };
      const failedPlan = transformV1Snapshot(failedSnapshot);
      const failedReport = reconcileMigration(failedSnapshot, failedPlan);
      const failedPhotos = await reviewMigrationPhotos(failedPlan, join(dir, "source"));
      const failureAuth = {
        ...auth,
        ...failureTenant,
        requestId: randomUUID(),
        sourceSha256: failedPlan.sourceBackupSha256,
        planSha256: validateMigrationPlan(failedPlan, failedReport).planSha256,
        photoManifestSha256: failedPhotos.sha256,
      };
      await seedMigrationTicket(admin, failureAuth);
      const failure = createPgV1MigrationLoader({
        ...options,
        authorize: async () => failureAuth,
        createBackupPoint: async () => ({
          id: randomUUID(),
          ...failureTenant,
          sourceSha256: failedPlan.sourceBackupSha256,
          verified: true as const,
        }),
      });
      await admin.query(`CREATE FUNCTION test_reject_v1_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.org_id='${failureTenant.orgId}'::uuid THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
      await admin.query(
        "CREATE TRIGGER test_reject_v1_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_reject_v1_audit()",
      );
      await assert.rejects(
        loadV2Migration(failure, urls.app, failedPlan, failedReport),
        /synthetic audit failure/,
      );
      const empty = await admin.query(
        "SELECT (SELECT count(*) FROM customers WHERE org_id=$1)+(SELECT count(*) FROM v1_import_batches WHERE org_id=$1) AS count",
        [failureTenant.orgId],
      );
      assert.equal(Number(empty.rows[0].count), 0);
    } finally {
      await app.end();
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { AuthorizedSession } from "../auth/session-view.js";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { createPhotoFileStore } from "../photo/file-store.js";
import { createDeliveryEvidenceFileStore } from "../delivery-evidence/file-store.js";
import { seedMigrationTenant } from "./import-test-fixture.js";
import { approveStoreExport } from "./store-export-requests.js";
import { exportPolicyHash, EXPORT_TABLES } from "./store-export-policy.js";
import { runApprovedStoreExport } from "./store-export-worker.js";
import { verifyStoreExport } from "./store-export-verify.js";
const urls = process.env.LAUNDRY_USE_LOCAL_PG === "1" ? resolvePgUrls() : null;
const signingSecret = "synthetic-export-authority-instance-secret-32-bytes";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
test(
  "whole-store export is app-role scoped, lossless, one-time and integrity checked",
  { skip: !urls },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin });
    const app = createPgPool({ connectionString: urls.app });
    const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-export-test-")));
    try {
      const grants = await admin.query<{ table_name: string; column_name: string }>(
        "SELECT table_name,column_name FROM information_schema.column_privileges WHERE grantee='laundry_store_exporter' AND privilege_type='SELECT' ORDER BY table_name,column_name",
      );
      assert.deepEqual(
        grants.rows.map((row) => `${row.table_name}.${row.column_name}`),
        EXPORT_TABLES.flatMap((table) =>
          table.columns.map((column) => `${table.name}.${column.name}`),
        ).sort(),
      );
      const tenant = await seedMigrationTenant(admin);
      const other = await seedMigrationTenant(admin);
      const sessionId = randomUUID();
      const deviceId = randomUUID();
      await admin.query(
        `INSERT INTO sessions(id,org_id,store_id,staff_id,device_id,session_version,permission_version,authentication_method,status,created_at)
      VALUES($1,$2,$3,$4,$5,1,1,'password','active',now())`,
        [sessionId, tenant.orgId, tenant.storeId, tenant.staffId, deviceId],
      );
      const authorized: AuthorizedSession = {
        session: {
          session_id: sessionId,
          org_id: tenant.orgId,
          store_id: tenant.storeId,
          staff_id: tenant.staffId,
          device_id: deviceId,
          session_version: 1,
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
      };
      for (const target of [tenant, other])
        await admin.query(
          `INSERT INTO customers(id,org_id,phone,name,note,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,now(),now())`,
          [
            randomUUID(),
            target.orgId,
            "13800000000",
            target === tenant ? "虚构本店顾客" : "外租户不可泄露",
            '换行\n"引号"与=SUM(1,2)',
          ],
        );
      await admin.query(
        `INSERT INTO ai_sessions(id,org_id,store_id,staff_id,auth_session_id,status,next_event_cursor,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'open',9007199254740993,now(),now())`,
        [randomUUID(), tenant.orgId, tenant.storeId, tenant.staffId, sessionId],
      );
      const garment = await createPhotoFileStore({ rootPath: join(root, "photos") });
      const delivery = await createDeliveryEvidenceFileStore(join(root, "photos"));
      const stored = await garment.write(png, "image/png");
      const deliveryStored = await delivery.write(png, "image/png");
      const orphan = await garment.write(png, "image/png");
      const order = randomUUID();
      const line = randomUUID();
      const item = randomUUID();
      await admin.query(
        `INSERT INTO orders(id,org_id,store_id,status,subtotal_cents,payable_cents,paid_cents,balance_cents,business_date,created_at,updated_at,created_by_staff_id)
      VALUES($1,$2,$3,'open',200,200,0,200,'2026-10-03',now(),now(),$4)`,
        [order, tenant.orgId, tenant.storeId, tenant.staffId],
      );
      await admin.query(
        `INSERT INTO order_lines(id,org_id,store_id,order_id,line_index,service_code,category_code,unit_price_cents,qty,line_total_cents)
      VALUES($1,$2,$3,$4,1,'wash','shirt',200,1,200)`,
        [line, tenant.orgId, tenant.storeId, order],
      );
      await admin.query(
        `INSERT INTO garments(id,org_id,store_id,order_id,order_line_id,seq,barcode,service_code,category_code,unit_price_cents)
      VALUES($1,$2,$3,$4,$5,1,'fixture','wash','shirt',200)`,
        [item, tenant.orgId, tenant.storeId, order, line],
      );
      await admin.query(
        `INSERT INTO garment_photos(id,org_id,store_id,garment_id,order_id,kind,storage_key,content_type,byte_size,taken_at,created_by_staff_id,content_sha256)
      VALUES($1,$2,$3,$4,$5,'receive',$6,$7,$8,now(),$9,$10)`,
        [
          randomUUID(),
          tenant.orgId,
          tenant.storeId,
          item,
          order,
          stored.storage_key,
          stored.content_type,
          stored.byte_size,
          tenant.staffId,
          stored.content_sha256,
        ],
      );
      // Synthetic export fixture only: seed an attachment directly, independent of
      // the separately-tested delivery workflow/assignee trigger chain.
      const fixtureClient = await admin.connect();
      try {
        await fixtureClient.query("BEGIN");
        await fixtureClient.query("SET LOCAL session_replication_role='replica'");
        await fixtureClient.query(
          `INSERT INTO delivery_evidence_attachments(id,org_id,store_id,delivery_order_id,delivery_task_id,leg,delivery_task_version,
        assignee_staff_id,kind,storage_key,content_type,content_sha256,byte_size,captured_at,expires_at,created_at,created_by_staff_id)
        VALUES($1,$2,$3,$4,$5,'pickup',1,$6,'photo',$7,$8,$9,$10,now(),now()+interval '1 day',now(),$6)`,
          [
            randomUUID(),
            tenant.orgId,
            tenant.storeId,
            randomUUID(),
            randomUUID(),
            tenant.staffId,
            deliveryStored.storage_key,
            deliveryStored.content_type,
            deliveryStored.content_sha256,
            deliveryStored.byte_size,
          ],
        );
        await fixtureClient.query("COMMIT");
      } finally {
        await fixtureClient.query("ROLLBACK");
        fixtureClient.release();
      }
      const base = {
        maintenancePool: admin,
        signingSecret,
        configuredTenant: tenant,
        photos: { garment, delivery },
      };
      const request = await approveStoreExport(app, authorized, exportPolicyHash(), signingSecret);
      // SQL-only app access cannot become the maintenance reader or read internal data,
      // even after copying a live admin session and manufacturing an approval row.
      for (const statement of [
        "SET LOCAL ROLE laundry_store_exporter",
        "SELECT id FROM ai_safety_events",
      ])
        await assert.rejects(
          withPoolClient(app, (client) =>
            withTenantTransaction(client, tenant, async () => {
              await client.query(statement);
            }),
          ),
          /permission denied/u,
        );
      const forged = randomUUID();
      await withPoolClient(app, (client) =>
        withTenantTransaction(client, tenant, async () => {
          await client.query(
            `INSERT INTO store_export_requests(id,org_id,store_id,actor_id,session_id,session_version,
          permission_version,policy_sha256,approved_at,expires_at,approval_signature)
          SELECT $1,org_id,store_id,actor_id,session_id,session_version,permission_version,
          policy_sha256,approved_at,expires_at,$2 FROM store_export_requests WHERE id=$3`,
            [forged, Buffer.alloc(64).toString("base64"), request.request_id],
          );
          await client.query("SELECT set_config('app.store_export_request_id',$1,true)", [forged]);
          assert.equal((await client.query("SELECT id FROM ai_sessions")).rows.length, 0);
        }),
      );
      await assert.rejects(
        runApprovedStoreExport({ ...base, destination: join(root, "forged"), requestId: forged }),
        /AUTHORIZATION_INVALID/u,
      );
      await assert.rejects(lstat(join(root, "forged")), { code: "ENOENT" });
      await assert.rejects(
        runApprovedStoreExport({
          ...base,
          signingSecret: "different-instance-secret-at-least-32-bytes",
          destination: join(root, "wrong-instance"),
          requestId: request.request_id,
        }),
        /AUTHORIZATION_INVALID/u,
      );
      await assert.rejects(lstat(join(root, "wrong-instance")), { code: "ENOENT" });
      const altered = await approveStoreExport(app, authorized, exportPolicyHash(), signingSecret);
      await admin.query(
        "UPDATE store_export_requests SET expires_at=expires_at-interval '1 second' WHERE id=$1",
        [altered.request_id],
      );
      await assert.rejects(
        runApprovedStoreExport({
          ...base,
          destination: join(root, "altered"),
          requestId: altered.request_id,
        }),
        /AUTHORIZATION_INVALID/u,
      );
      await assert.rejects(lstat(join(root, "altered")), { code: "ENOENT" });
      await assert.rejects(
        withPoolClient(app, (client) =>
          withTenantTransaction(client, tenant, async () => {
            await client.query(
              "UPDATE store_export_requests SET approval_signature=$2 WHERE id=$1",
              [request.request_id, Buffer.alloc(64).toString("base64")],
            );
          }),
        ),
        /permission denied/u,
      );
      await assert.rejects(
        withPoolClient(admin, (client) =>
          withTenantTransaction(client, tenant, async () => {
            await client.query("SET LOCAL ROLE laundry_store_exporter");
            await client.query("SELECT password_hash FROM staffs");
          }),
        ),
        /permission denied/u,
      );
      await withPoolClient(admin, (client) =>
        withTenantTransaction(client, tenant, async () => {
          await client.query("SET LOCAL ROLE laundry_store_exporter");
          assert.equal((await client.query("SELECT name FROM customers")).rows.length, 1);
        }),
      );
      const destination = join(root, "exported");
      const result = await runApprovedStoreExport({
        ...base,
        destination,
        requestId: request.request_id,
      });
      const manifest = await verifyStoreExport(join(destination, "data"), result.manifest_sha256);
      assert.equal(manifest.tables.length, EXPORT_TABLES.length);
      assert.equal(manifest.photos.length, 2);
      assert.ok(
        manifest.photos.some(
          (photo) =>
            photo.table === "delivery_evidence_attachments" &&
            photo.storage_key === deliveryStored.storage_key,
        ),
      );
      assert.equal(
        manifest.files.some((file) => file.path.includes(orphan.storage_key)),
        false,
      );
      const customers = await readFile(join(destination, "data/tables/customers.jsonl"), "utf8");
      assert.match(customers, /虚构本店顾客/u);
      assert.doesNotMatch(customers, /外租户不可泄露/u);
      const staff = await readFile(join(destination, "data/tables/staffs.jsonl"), "utf8");
      assert.doesNotMatch(staff, /password|pin_hash|permission_version|not-a-real-password/u);
      assert.match(
        await readFile(join(destination, "data/tables/ai_sessions.jsonl"), "utf8"),
        /"9007199254740993"/u,
      );
      assert.equal(
        manifest.files.some(
          (entry) => entry.path.includes("sessions.jsonl") && !entry.path.includes("ai_sessions"),
        ),
        false,
      );
      const rows = await admin.query(
        "SELECT consumed_at,manifest_sha256 FROM store_export_requests WHERE id=$1",
        [request.request_id],
      );
      assert.ok(rows.rows[0]?.consumed_at);
      assert.equal(rows.rows[0]?.manifest_sha256, result.manifest_sha256);
      for (const assignment of [
        "consumed_at=NULL,manifest_sha256=NULL",
        "manifest_sha256=repeat('a',64)",
        "consumed_at=now()+interval '1 second'",
      ])
        await assert.rejects(
          withPoolClient(app, (client) =>
            withTenantTransaction(client, tenant, async () => {
              await client.query(`UPDATE store_export_requests SET ${assignment} WHERE id=$1`, [
                request.request_id,
              ]);
            }),
          ),
          /receipt is immutable/u,
        );
      await assert.rejects(
        runApprovedStoreExport({ ...base, destination, requestId: request.request_id }),
        { code: "EEXIST" },
      );
      await admin.query("CREATE TABLE unexpected_export_fixture(id uuid)");
      await assert.rejects(
        approveStoreExport(app, authorized, exportPolicyHash(), signingSecret),
        /SCHEMA_UNREVIEWED/u,
      );
      await admin.query("DROP TABLE unexpected_export_fixture");
      const expired = await approveStoreExport(app, authorized, exportPolicyHash(), signingSecret);
      await admin.query(
        "UPDATE store_export_requests SET approved_at=now()-interval '20 minutes',expires_at=now()-interval '10 minutes' WHERE id=$1",
        [expired.request_id],
      );
      await assert.rejects(
        runApprovedStoreExport({
          ...base,
          destination: join(root, "expired"),
          requestId: expired.request_id,
        }),
        /AUTHORIZATION_INVALID/u,
      );
      const revokedRequest = await approveStoreExport(
        app,
        authorized,
        exportPolicyHash(),
        signingSecret,
      );
      await admin.query("UPDATE store_export_requests SET revoked_at=now() WHERE id=$1", [
        revokedRequest.request_id,
      ]);
      await assert.rejects(
        runApprovedStoreExport({
          ...base,
          destination: join(root, "revoked-ticket"),
          requestId: revokedRequest.request_id,
        }),
        /AUTHORIZATION_INVALID/u,
      );
      const guarded = await approveStoreExport(app, authorized, exportPolicyHash(), signingSecret);
      const secretSetting = randomUUID();
      await admin.query(
        "INSERT INTO settings(id,org_id,key,value_json,updated_at,updated_by_staff_id) VALUES($1,$2,'legacy.smtp.password',$3,now(),$4)",
        [
          secretSetting,
          tenant.orgId,
          JSON.stringify("synthetic-never-export-this-secret"),
          tenant.staffId,
        ],
      );
      await assert.rejects(
        runApprovedStoreExport({
          ...base,
          destination: join(root, "secret-blocked"),
          requestId: guarded.request_id,
        }),
        /SETTINGS_UNREVIEWED/u,
      );
      assert.equal(
        (
          await admin.query("SELECT consumed_at FROM store_export_requests WHERE id=$1", [
            guarded.request_id,
          ])
        ).rows[0]?.consumed_at,
        null,
      );
      await admin.query("DELETE FROM settings WHERE id=$1", [secretSetting]);
      const auditFailure = await approveStoreExport(
        app,
        authorized,
        exportPolicyHash(),
        signingSecret,
      );
      await admin.query(`CREATE FUNCTION test_reject_export_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.command='store.export.prepare' THEN RAISE EXCEPTION 'synthetic export audit failure'; END IF; RETURN NEW; END $$`);
      await admin.query(
        "CREATE TRIGGER test_reject_export_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_reject_export_audit()",
      );
      await assert.rejects(
        runApprovedStoreExport({
          ...base,
          destination: join(root, "audit-failed"),
          requestId: auditFailure.request_id,
        }),
        /synthetic export audit failure/u,
      );
      assert.equal(
        (
          await admin.query("SELECT consumed_at FROM store_export_requests WHERE id=$1", [
            auditFailure.request_id,
          ])
        ).rows[0]?.consumed_at,
        null,
      );
      await assert.rejects(lstat(join(root, "audit-failed")), { code: "ENOENT" });
      await admin.query("DROP TRIGGER test_reject_export_audit ON audit_log");
      await admin.query("DROP FUNCTION test_reject_export_audit()");
      await assert.rejects(
        runApprovedStoreExport({
          ...base,
          destination: join(root, "replayed"),
          requestId: request.request_id,
        }),
        /AUTHORIZATION_INVALID/u,
      );
      await assert.rejects(lstat(join(root, "replayed")), { code: "ENOENT" });
      await withPoolClient(app, (client) =>
        withTenantTransaction(client, other, async () => {
          assert.equal((await client.query("SELECT id FROM store_export_requests")).rows.length, 0);
        }),
      );
      await withPoolClient(app, (client) =>
        withTenantTransaction(client, tenant, async () => {
          assert.equal((await client.query("SELECT id FROM ai_sessions")).rows.length, 0);
        }),
      );
      await writeFile(join(destination, "data", manifest.photos[0]!.path), "damaged");
      await assert.rejects(
        verifyStoreExport(join(destination, "data"), result.manifest_sha256),
        /INTEGRITY_FAILED/u,
      );
      const missing = await approveStoreExport(app, authorized, exportPolicyHash(), signingSecret);
      await rm(join(root, "photos", stored.storage_key));
      await assert.rejects(
        runApprovedStoreExport({
          ...base,
          destination: join(root, "missing"),
          requestId: missing.request_id,
        }),
        /unavailable/u,
      );
      assert.equal(
        (
          await admin.query("SELECT consumed_at FROM store_export_requests WHERE id=$1", [
            missing.request_id,
          ])
        ).rows[0]?.consumed_at,
        null,
      );
      await admin.query("UPDATE sessions SET status='revoked',revoked_at=now() WHERE id=$1", [
        sessionId,
      ]);
      await assert.rejects(
        runApprovedStoreExport({
          ...base,
          destination: join(root, "revoked"),
          requestId: missing.request_id,
        }),
        /AUTHORIZATION_INVALID/u,
      );
    } finally {
      await app.end();
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);

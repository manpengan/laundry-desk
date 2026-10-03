import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runApprovedImport } from "./data-worker.mjs";
import { exportStore } from "./store-export.mjs";

const enabled = process.env.LAUNDRY_USE_LOCAL_PG === "1";

// Payload validation runs before the server build. Resolve compiled dependencies
// only inside explicitly enabled PG callbacks, never during test discovery.
async function serverContext() {
  const server = resolve("apps/server");
  const require = createRequire(join(server, "package.json"));
  const fromServer = (file) => import(pathToFileURL(join(server, "dist", file)).href);
  const { LOCAL_PROFILE } = await fromServer("local/profile.js");
  const { securePrivateDirectory, securePrivateFile } = await import(
    pathToFileURL(require.resolve("@laundry/platform-fs")).href
  );
  const writePrivate = async (path, value) => {
    await writeFile(path, value, { mode: 0o600, flag: "wx" });
    await securePrivateFile(path);
  };
  return {
    server,
    require,
    fromServer,
    LOCAL_PROFILE,
    securePrivateDirectory,
    writePrivate,
    scope: { orgId: LOCAL_PROFILE.orgId, storeId: LOCAL_PROFILE.storeId },
  };
}

test(
  "both data workers reject the old incomplete RLS scope before executing SQL",
  { skip: !enabled },
  async () => {
    const { fromServer, scope } = await serverContext();
    const { readApprovedMigrationRequest } = await fromServer("data-transfer/import-requests.js");
    const { runApprovedStoreExport } = await fromServer("data-transfer/store-export-worker.js");
    let queries = 0;
    let releases = 0;
    const pool = {
      connect: async () => ({
        query: async () => {
          queries += 1;
          assert.fail("incomplete scope must not execute SQL");
        },
        release: () => {
          releases += 1;
        },
      }),
    };
    const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-scope-reject-")));
    const missingStaff = (error) =>
      error.code === "TENANT_GUC_INVALID" && error.message === "TenantContext.staffId is required";
    try {
      await assert.rejects(readApprovedMigrationRequest(pool, scope, randomUUID()), missingStaff);
      await assert.rejects(
        runApprovedStoreExport({
          maintenancePool: pool,
          configuredTenant: scope,
          requestId: randomUUID(),
          signingSecret: "synthetic-only",
          destination: join(root, "export"),
          photos: {},
        }),
        missingStaff,
      );
      assert.equal(queries, 0);
      assert.equal(releases, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

/** Only the PG transport URL is mapped to this test's isolated database. The real
 * bridge, server workers, file stores, RLS, signatures and SQL are not replaced. */
async function payloadFixture(
  root,
  urls,
  { server, require, securePrivateDirectory, writePrivate },
) {
  const payload = join(root, "payload");
  const pg = join(payload, "server/node_modules/pg");
  await mkdir(pg, { recursive: true });
  await securePrivateDirectory(root);
  await symlink(join(server, "dist"), join(payload, "server/dist"), "junction");
  await writeFile(join(payload, "server/package.json"), '{"type":"module"}');
  await writeFile(join(pg, "package.json"), '{"main":"index.cjs"}');
  const bound = {
    app: "postgresql://laundry_app:synthetic@127.0.0.1:8543/laundry_v2",
    admin: "postgresql://postgres:synthetic@127.0.0.1:8543/laundry_v2",
  };
  await writePrivate(join(pg, "targets.json"), JSON.stringify({ urls, bound }));
  await writeFile(
    join(pg, "index.cjs"),
    `
    const assert = require('node:assert/strict');
    const { Pool } = require(${JSON.stringify(require.resolve("pg"))});
    const { urls, bound } = require('./targets.json');
    module.exports.Pool = class FixturePool extends Pool {
      constructor(options) {
        const role = Object.keys(bound).find(key => bound[key] === options.connectionString);
        assert.ok(role, 'test transport only accepts the fixed Runtime URL');
        super({ ...options, connectionString: urls[role] });
      }
    };
  `,
  );
  const runtime = join(root, "runtime");
  await mkdir(runtime, { mode: 0o700 });
  await securePrivateDirectory(runtime);
  const appSecret = join(root, "app-url");
  const adminSecret = join(root, "admin-url");
  const signingSecret = join(root, "signing-secret");
  await writePrivate(appSecret, bound.app);
  await writePrivate(adminSecret, bound.admin);
  await writePrivate(signingSecret, "synthetic-worker-export-authority-at-least-32-bytes");
  return {
    root: runtime,
    payload,
    io: { read: (path) => readFile(path, "utf8") },
    env: {
      DATABASE_URL_FILE: appSecret,
      DATABASE_ADMIN_URL_FILE: adminSecret,
      LAUNDRY_ACCESS_TOKEN_SECRET_FILE: signingSecret,
    },
  };
}

async function seedActor(admin, scope) {
  await admin.query(
    "INSERT INTO orgs(id,code,name,created_at,updated_at) VALUES($1,'worker','Synthetic',now(),now())",
    [scope.orgId],
  );
  await admin.query(
    "INSERT INTO stores(id,org_id,code,name,timezone,created_at,updated_at) VALUES($1,$2,'worker','Synthetic','Asia/Taipei',now(),now())",
    [scope.storeId, scope.orgId],
  );
  // The configured bootstrap identity is absent. Only the approved actor can authorize work.
  const actor = { ...scope, staffId: randomUUID() };
  await admin.query(
    "INSERT INTO staffs(id,org_id,username,password_hash,display_name,created_at,updated_at) VALUES($1,$2,$3,'synthetic-only','Synthetic',now(),now())",
    [actor.staffId, scope.orgId, actor.staffId],
  );
  await admin.query(
    "INSERT INTO staff_store_roles(id,org_id,store_id,staff_id,role,is_privacy_admin,created_at,updated_at) VALUES($1,$2,$3,$4,'admin',true,now(),now())",
    [randomUUID(), scope.orgId, scope.storeId, actor.staffId],
  );
  return actor;
}

function authorizedSession(actor, sessionId) {
  return {
    session: {
      session_id: sessionId,
      org_id: actor.orgId,
      store_id: actor.storeId,
      staff_id: actor.staffId,
      device_id: randomUUID(),
      session_version: 1,
      permission_version: 1,
      authentication_method: "password",
      status: "active",
      family_id: randomUUID(),
      created_at: Math.floor(Date.now() / 1000),
      revoked_at: null,
    },
    authority: {
      staff_id: actor.staffId,
      display_name: "Synthetic",
      role: "admin",
      permission_version: 1,
      is_privacy_admin: true,
    },
  };
}

test(
  "real PG Runtime bridges import and export with the approved actor, not the bootstrap scope",
  {
    skip: !enabled,
  },
  async () => {
    const modules = await serverContext();
    const { fromServer, require, LOCAL_PROFILE, scope } = modules;
    const { createPgPool, resolvePgUrls } = await fromServer("db/pg-pool.js");
    const { createIsolatedPgTestDatabase } = await fromServer("db/isolated-pg-test-database.js");
    const { createImportDraftStore } = await fromServer("data-transfer/import-drafts.js");
    const { seedMigrationTicket } = await fromServer("data-transfer/import-test-fixture.js");
    const { approveStoreExport } = await fromServer("data-transfer/store-export-requests.js");
    const { exportPolicyHash, EXPORT_TABLES } = await fromServer(
      "data-transfer/store-export-policy.js",
    );
    const { verifyStoreExport } = await fromServer("data-transfer/store-export-verify.js");
    const urls = resolvePgUrls();
    assert.ok(urls);
    const database = await createIsolatedPgTestDatabase(urls);
    const admin = createPgPool({ connectionString: database.urls.admin });
    const app = createPgPool({ connectionString: database.urls.app });
    const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-worker-pg-")));
    try {
      const context = await payloadFixture(root, database.urls, modules);
      const actor = await seedActor(admin, scope);
      const migrationRequire = createRequire(require.resolve("@laundry/migrate-v1"));
      const Database = migrationRequire("better-sqlite3");
      const sourcePath = join(root, "source.sqlite");
      const source = new Database(sourcePath);
      try {
        source.exec(
          await readFile(resolve("tools/migrate-v1/test/fixtures/v1-fixture.sql"), "utf8"),
        );
        source.exec("UPDATE order_photos SET file_path='2024/item.png'");
      } finally {
        source.close();
      }
      const bytes = await readFile(sourcePath);
      const drafts = await createImportDraftStore(join(context.root, "import-requests"));
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      );
      const draft = async () => {
        const session = randomUUID();
        const view = await drafts.create(session, bytes);
        await drafts.uploadPhoto(session, view.draft_id, view.photos[0].id, png);
        const review = await drafts.review(session, view.draft_id);
        // Use the DB clock inside the allowed TTL, avoiding host/container skew at 10 minutes.
        const expiry = await admin.query(
          "SELECT floor(extract(epoch FROM clock_timestamp()+interval '5 minutes')*1000)::bigint AS ms",
        );
        const ticket = await seedMigrationTicket(admin, {
          ...actor,
          requestId: view.draft_id,
          permissionVersion: 1,
          sourceSha256: review.source_sha256,
          planSha256: review.plan_sha256,
          photoManifestSha256: review.photos_sha256,
          expiresAt: Number(expiry.rows[0].ms),
          photoAssociationsReviewed: true,
        });
        return { ...view, ...ticket };
      };
      let backups = 0;
      const backup = async (scopeFromTicket, sourceSha256) => {
        assert.equal(scopeFromTicket.staffId, actor.staffId);
        assert.notEqual(scopeFromTicket.staffId, LOCAL_PROFILE.adminStaffId);
        backups += 1;
        return { id: "synthetic-verified-backup", ...scope, sourceSha256, verified: true };
      };
      const revoked = await draft();
      await admin.query("UPDATE sessions SET status='revoked',revoked_at=now() WHERE id=$1", [
        revoked.sessionId,
      ]);
      await assert.rejects(
        runApprovedImport(context, revoked.draft_id, backup),
        /V1_MIGRATION_AUTHORIZATION_INVALID/u,
      );
      assert.equal(backups, 0);
      const approved = await draft();
      const imported = await runApprovedImport(context, approved.draft_id, backup);
      assert.equal(imported.applied, true);
      assert.equal(imported.cleanup_pending, false);
      assert.equal(backups, 1);
      assert.deepEqual(imported.totals, approved.report.target);
      const receipt = (
        await admin.query(
          "SELECT consumed_at,materials_deleted_at FROM v1_import_requests WHERE id=$1",
          [approved.draft_id],
        )
      ).rows[0];
      assert.ok(receipt.consumed_at && receipt.materials_deleted_at);
      const importActor = (await admin.query("SELECT actor_id FROM v1_import_batches")).rows[0]
        .actor_id;
      assert.equal(importActor, actor.staffId);
      assert.deepEqual(
        (await admin.query("SELECT DISTINCT created_by_staff_id FROM orders")).rows,
        [{ created_by_staff_id: actor.staffId }],
      );
      const signingSecret = await context.io.read(context.env.LAUNDRY_ACCESS_TOKEN_SECRET_FILE);
      const authorized = authorizedSession(actor, approved.sessionId);
      const cancelled = await approveStoreExport(
        app,
        authorized,
        exportPolicyHash(),
        signingSecret,
      );
      await admin.query("UPDATE store_export_requests SET revoked_at=now() WHERE id=$1", [
        cancelled.request_id,
      ]);
      await assert.rejects(
        exportStore(context, {
          destination: join(root, "revoked-export"),
          requestId: cancelled.request_id,
        }),
        /STORE_EXPORT_AUTHORIZATION_INVALID/u,
      );
      const request = await approveStoreExport(app, authorized, exportPolicyHash(), signingSecret);
      const destination = join(root, "export");
      const exported = await exportStore(context, { destination, requestId: request.request_id });
      assert.equal(exported.tables, EXPORT_TABLES.length);
      assert.equal(exported.photos, 1);
      const manifest = await verifyStoreExport(join(destination, "data"), exported.manifest_sha256);
      assert.equal(manifest.actor_id, actor.staffId);
      assert.equal(manifest.org_id, scope.orgId);
      assert.equal(manifest.store_id, scope.storeId);
      assert.equal(manifest.tables.find((table) => table.name === "customers").rows, 2);
      const audit = await admin.query(
        "SELECT command,staff_id FROM audit_log WHERE command IN ('migration.v1.apply','store.export.prepare') ORDER BY command",
      );
      assert.deepEqual(audit.rows, [
        { command: "migration.v1.apply", staff_id: actor.staffId },
        { command: "store.export.prepare", staff_id: actor.staffId },
      ]);
      assert.ok(
        (
          await admin.query("SELECT consumed_at FROM store_export_requests WHERE id=$1", [
            request.request_id,
          ])
        ).rows[0].consumed_at,
      );
      await assert.rejects(
        exportStore(context, {
          destination: join(root, "replay-export"),
          requestId: request.request_id,
        }),
        /STORE_EXPORT_AUTHORIZATION_INVALID/u,
      );
    } finally {
      await app.end();
      await admin.end();
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

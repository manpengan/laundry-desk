import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext } from "../bus/types.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { createPgPool, resolvePgUrls, type PgPool, type PgPoolClient } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPhotoFileStore } from "./file-store.js";
import { createPgPhotoStore } from "./pg-photo-store.js";

const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GARMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PHOTO_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STORAGE_KEY = `${PHOTO_ID}.jpg`;
const CONTENT_SHA256 = "a".repeat(64);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

type AuditFailureTrigger = Readonly<{ triggerName: string; functionName: string }>;

async function rethrowWithCleanupFailure(
  primaryFailure: unknown,
  cleanup: () => Promise<unknown>,
  message: string,
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupFailure) {
    throw new AggregateError([primaryFailure, cleanupFailure], message);
  }
  throw primaryFailure;
}

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

const ACTOR: ActorContext = Object.freeze({
  staffId: DEMO_STAFF_A_ID,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze(["order_write"]),
});

async function installPhotoAuditFailureTrigger(
  pool: PgPool,
  command: "photo.register" | "photo.delete",
  photoId: string,
): Promise<AuditFailureTrigger> {
  const suffix = randomUUID().replaceAll("-", "");
  const trigger = Object.freeze({
    triggerName: `photo_audit_failure_${suffix}`,
    functionName: `photo_audit_failure_fn_${suffix}`,
  });
  await pool.query(`
    CREATE FUNCTION ${trigger.functionName}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.command = '${command}' AND NEW.entity_id = '${photoId}' THEN
        RAISE EXCEPTION 'forced photo audit failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  try {
    await pool.query(
      `CREATE TRIGGER ${trigger.triggerName}
       BEFORE INSERT ON audit_log
       FOR EACH ROW EXECUTE FUNCTION ${trigger.functionName}()`,
    );
  } catch (error) {
    await rethrowWithCleanupFailure(
      error,
      () => pool.query(`DROP FUNCTION IF EXISTS ${trigger.functionName}()`),
      "photo audit trigger install and cleanup failed",
    );
  }
  return trigger;
}

async function removePhotoAuditFailureTrigger(
  pool: PgPool,
  trigger: AuditFailureTrigger | null,
): Promise<void> {
  if (trigger === null) return;
  await pool.query(`DROP TRIGGER IF EXISTS ${trigger.triggerName} ON audit_log`);
  await pool.query(`DROP FUNCTION IF EXISTS ${trigger.functionName}()`);
}

async function cleanupPhotoFixture(pool: PgPool, orderId: string, photoId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(
        `DELETE FROM audit_log
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND entity_id = $3`,
        [DEMO_ORG_ID, DEMO_STORE_ID, photoId],
      );
      await client.query(
        `DELETE FROM garment_photos
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid`,
        [DEMO_ORG_ID, DEMO_STORE_ID, orderId],
      );
      await client.query(
        `DELETE FROM garments
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid`,
        [DEMO_ORG_ID, DEMO_STORE_ID, orderId],
      );
      await client.query(
        `DELETE FROM order_lines
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid`,
        [DEMO_ORG_ID, DEMO_STORE_ID, orderId],
      );
      await client.query(
        `DELETE FROM orders
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
        [DEMO_ORG_ID, DEMO_STORE_ID, orderId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await rethrowWithCleanupFailure(
        error,
        () => client.query("ROLLBACK"),
        "photo fixture mutation and rollback failed",
      );
    }
  } finally {
    client.release();
  }
}

async function settleTasks(
  tasks: readonly (() => Promise<unknown>)[],
): Promise<readonly unknown[]> {
  const results = await Promise.allSettled(tasks.map(async (task) => task()));
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

type RecordedQuery = Readonly<{ sql: string; params: readonly unknown[] | undefined }>;

function createCapturingPool(): Readonly<{ pool: PgPool; queries: RecordedQuery[] }> {
  const queries: RecordedQuery[] = [];
  const client = {
    async query<TRow>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<{ rows: TRow[]; rowCount: number }> {
      queries.push(Object.freeze({ sql, params }));
      if (
        sql.includes("INSERT INTO garment_photos") ||
        sql.includes("DELETE FROM garment_photos")
      ) {
        return {
          rows: [
            {
              id: PHOTO_ID,
              org_id: DEMO_ORG_ID,
              store_id: DEMO_STORE_ID,
              garment_id: GARMENT_ID,
              order_id: ORDER_ID,
              kind: "receive",
              storage_key: STORAGE_KEY,
              content_type: "image/jpeg",
              content_sha256: CONTENT_SHA256,
              byte_size: 42,
              taken_at: new Date("2026-07-23T00:00:00.000Z"),
              created_by_staff_id: DEMO_STAFF_A_ID,
            } as TRow,
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM garment_photos")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    release(): void {
      // Capturing test double.
    },
  } as unknown as PgPoolClient;
  return Object.freeze({
    pool: { connect: async () => client } as unknown as PgPool,
    queries,
  });
}

test("PG photo store writes append-only metadata under store GUC scope", async () => {
  const { pool, queries } = createCapturingPool();
  const store = createPgPhotoStore(pool, {
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
    newId: () => PHOTO_ID,
  });

  const photo = await store.register({
    org_id: DEMO_ORG_ID,
    store_id: DEMO_STORE_ID,
    garment_id: GARMENT_ID,
    order_id: ORDER_ID,
    kind: "receive",
    storage_key: STORAGE_KEY,
    content_type: "image/jpeg",
    content_sha256: CONTENT_SHA256,
    byte_size: 42,
    taken_at: 1_784_764_800,
    created_by_staff_id: DEMO_STAFF_A_ID,
  });

  assert.equal(photo.photo_id, PHOTO_ID);
  assert.equal(photo.taken_at, 1_784_764_800);
  const insert = queries.find((query) => query.sql.includes("INSERT INTO garment_photos"));
  assert.ok(insert);
  for (const expected of [PHOTO_ID, DEMO_ORG_ID, DEMO_STORE_ID, GARMENT_ID, ORDER_ID]) {
    assert.ok(insert.params?.includes(expected), `register must send ${expected}`);
  }
  // The tenant scope reaches the driver. That the GUCs actually confine the
  // write is a database behaviour, covered by the real-PG case below and by
  // __tests__/rls-pg-integration.test.ts.
  assert.ok(queries.some((query) => query.params?.includes(DEMO_ORG_ID)));
  assert.ok(queries.some((query) => query.params?.includes(DEMO_STORE_ID)));
});

test("PG photo store rejects a repository scope that differs from its server configuration", async () => {
  const { pool } = createCapturingPool();
  const store = createPgPhotoStore(pool, { orgId: DEMO_ORG_ID, storeId: DEMO_STORE_ID });
  await assert.rejects(
    () => store.listByOrder(DEMO_ORG_ID, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", ORDER_ID),
    /does not match authenticated tenant/u,
  );
});

test("PG photo store deletes by tenant-scoped id and returns private cleanup metadata", async () => {
  const { pool, queries } = createCapturingPool();
  const store = createPgPhotoStore(pool, { orgId: DEMO_ORG_ID, storeId: DEMO_STORE_ID });

  const deleted = await store.deleteById(DEMO_ORG_ID, DEMO_STORE_ID, PHOTO_ID);

  assert.equal(deleted?.storage_key, STORAGE_KEY);
  const query = queries.find((candidate) => candidate.sql.includes("DELETE FROM garment_photos"));
  assert.deepEqual(query?.params, [DEMO_ORG_ID, DEMO_STORE_ID, PHOTO_ID]);
});

maybe("PG photo command persists metadata and audit through the command transaction", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });
  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "laundry-pg-photo-")));
  const orderId = randomUUID();
  const lineId = randomUUID();
  const garmentId = randomUUID();
  const photoId = randomUUID();
  let auditFailureTrigger: AuditFailureTrigger | null = null;
  let exerciseFailed = false;
  let exerciseFailure: unknown;
  try {
    const files = await createPhotoFileStore({
      rootPath: join(tempRoot, "photos"),
      orphanGraceMs: 1,
    });
    const referenced = await files.write(JPEG, "image/jpeg");
    const orphan = await files.write(PNG, "image/png");
    const old = new Date(0);
    await Promise.all([
      utimes(join(files.rootPath, referenced.storage_key), old, old),
      utimes(join(files.rootPath, orphan.storage_key), old, old),
    ]);

    await seedPgTestIdentityFixture(adminPool);
    await adminPool.query(
      `INSERT INTO orders (
         id, org_id, store_id, ticket_no, status, customer_phone, customer_name, note,
         subtotal_cents, payable_cents, paid_cents, balance_cents,
         created_at, updated_at, created_by_staff_id, business_date
       ) VALUES ($1, $2, $3, $4, 'open', NULL, NULL, NULL, 1000, 1000, 0, 1000, now(), now(), $5,
         (SELECT to_char(now() AT TIME ZONE store.timezone, 'YYYY-MM-DD')
            FROM stores AS store
           WHERE store.org_id = $2 AND store.id = $3))`,
      [orderId, DEMO_ORG_ID, DEMO_STORE_ID, `photo-${orderId}`, DEMO_STAFF_A_ID],
    );
    await adminPool.query(
      `INSERT INTO order_lines (
         id, org_id, store_id, order_id, line_index, service_code, category_code,
         unit_price_cents, qty, line_total_cents, color, brand
       ) VALUES ($1, $2, $3, $4, 0, 'wash', 'shirt', 1000, 1, 1000, NULL, NULL)`,
      [lineId, DEMO_ORG_ID, DEMO_STORE_ID, orderId],
    );
    await adminPool.query(
      `INSERT INTO garments (
         id, org_id, store_id, order_id, order_line_id, seq, barcode,
         service_code, category_code, unit_price_cents, color, brand, status
       ) VALUES ($1, $2, $3, $4, $5, 1, $6, 'wash', 'shirt', 1000, NULL, NULL, 'received')`,
      [garmentId, DEMO_ORG_ID, DEMO_STORE_ID, orderId, lineId, randomUUID().replace(/-/gu, "")],
    );

    const store = createPgPhotoStore(appPool, {
      orgId: DEMO_ORG_ID,
      storeId: DEMO_STORE_ID,
      newId: () => photoId,
    });
    const { registry, chainHooks } = createRegisteredM1Bus({ photo: { store } });
    auditFailureTrigger = await installPhotoAuditFailureTrigger(
      adminPool,
      "photo.register",
      photoId,
    );
    const rolledBackRegistration = await withPoolClient(appPool, (sql) =>
      executeCommand(
        sql,
        TENANT,
        "photo.register",
        {
          order_id: orderId,
          garment_id: garmentId,
          kind: "receive",
          storage_key: referenced.storage_key,
          content_type: referenced.content_type,
          content_sha256: referenced.content_sha256,
          byte_size: referenced.byte_size,
          taken_at: 1_784_764_800,
        },
        { registry, actor: ACTOR, chainHooks },
      ),
    );
    assert.equal(rolledBackRegistration.ok, false);
    if (!rolledBackRegistration.ok) {
      assert.equal(rolledBackRegistration.error.code, "TRANSACTION_FAILED");
    }
    assert.equal(
      Number(
        (
          await adminPool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM garment_photos WHERE id = $1::uuid",
            [photoId],
          )
        ).rows[0]?.count,
      ),
      0,
    );
    await removePhotoAuditFailureTrigger(adminPool, auditFailureTrigger);
    auditFailureTrigger = null;

    const result = await withPoolClient(appPool, (sql) =>
      executeCommand(
        sql,
        TENANT,
        "photo.register",
        {
          order_id: orderId,
          garment_id: garmentId,
          kind: "receive",
          storage_key: referenced.storage_key,
          content_type: referenced.content_type,
          content_sha256: referenced.content_sha256,
          byte_size: referenced.byte_size,
          taken_at: 1_784_764_800,
        },
        { registry, actor: ACTOR, chainHooks },
      ),
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const registered = result.data.result as { photo_id: string };

    const counts = await withPoolClient(appPool, (sql) =>
      withTenantTransaction(sql, TENANT, async (tx) => {
        const photos = await tx.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM garment_photos WHERE storage_key = $1",
          [referenced.storage_key],
        );
        const audits = await tx.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM audit_log WHERE command = 'photo.register' AND entity_id = $1",
          [registered.photo_id],
        );
        return Object.freeze({ photos, audits });
      }),
    );
    assert.equal(Number(counts.photos.rows[0]?.count), 1);
    assert.equal(Number(counts.audits.rows[0]?.count), 1);
    const referencedKeys = await store.listStorageKeys(DEMO_ORG_ID, DEMO_STORE_ID);
    assert.equal(referencedKeys.has(referenced.storage_key), true);
    assert.equal(referencedKeys.has(orphan.storage_key), false);
    assert.deepEqual(await files.sweepOrphans(referencedKeys, 10_000), {
      removed: 1,
      removed_bytes: orphan.byte_size,
      retained: 1,
      retained_bytes: referenced.byte_size,
    });
    assert.equal((await lstat(join(files.rootPath, referenced.storage_key))).isFile(), true);
    await assert.rejects(() => lstat(join(files.rootPath, orphan.storage_key)), { code: "ENOENT" });
    assert.deepEqual(await store.listByOrder(DEMO_ORG_ID, DEMO_STORE_ID, orderId), [
      {
        photo_id: registered.photo_id,
        org_id: DEMO_ORG_ID,
        store_id: DEMO_STORE_ID,
        garment_id: garmentId,
        order_id: orderId,
        kind: "receive",
        storage_key: referenced.storage_key,
        content_type: referenced.content_type,
        content_sha256: referenced.content_sha256,
        byte_size: referenced.byte_size,
        taken_at: 1_784_764_800,
        created_by_staff_id: DEMO_STAFF_A_ID,
      },
    ]);

    auditFailureTrigger = await installPhotoAuditFailureTrigger(adminPool, "photo.delete", photoId);
    const rolledBackDelete = await withPoolClient(appPool, (sql) =>
      executeCommand(
        sql,
        TENANT,
        "photo.delete",
        { photo_id: registered.photo_id },
        { registry, actor: ACTOR, chainHooks },
      ),
    );
    assert.equal(rolledBackDelete.ok, false);
    if (!rolledBackDelete.ok) assert.equal(rolledBackDelete.error.code, "TRANSACTION_FAILED");
    assert.equal(
      Number(
        (
          await adminPool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM garment_photos WHERE id = $1::uuid",
            [registered.photo_id],
          )
        ).rows[0]?.count,
      ),
      1,
    );
    await removePhotoAuditFailureTrigger(adminPool, auditFailureTrigger);
    auditFailureTrigger = null;

    const deleted = await withPoolClient(appPool, (sql) =>
      executeCommand(
        sql,
        TENANT,
        "photo.delete",
        { photo_id: registered.photo_id },
        { registry, actor: ACTOR, chainHooks },
      ),
    );
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    const deletedCounts = await withPoolClient(appPool, (sql) =>
      withTenantTransaction(sql, TENANT, async (tx) => {
        const photos = await tx.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM garment_photos WHERE id = $1::uuid",
          [registered.photo_id],
        );
        const audits = await tx.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM audit_log WHERE command = 'photo.delete' AND entity_id = $1",
          [registered.photo_id],
        );
        return Object.freeze({ photos, audits });
      }),
    );
    assert.equal(Number(deletedCounts.photos.rows[0]?.count), 0);
    assert.equal(Number(deletedCounts.audits.rows[0]?.count), 1);
    const afterDeleteKeys = await store.listStorageKeys(DEMO_ORG_ID, DEMO_STORE_ID);
    assert.equal(afterDeleteKeys.has(referenced.storage_key), false);
    assert.deepEqual(await files.sweepOrphans(afterDeleteKeys, 10_000), {
      removed: 1,
      removed_bytes: referenced.byte_size,
      retained: 0,
      retained_bytes: 0,
    });
    await assert.rejects(() => lstat(join(files.rootPath, referenced.storage_key)), {
      code: "ENOENT",
    });
  } catch (error) {
    exerciseFailed = true;
    exerciseFailure = error;
  }

  const triggerFailures = await settleTasks([
    async () => removePhotoAuditFailureTrigger(adminPool, auditFailureTrigger),
  ]);
  const fixtureAndFileFailures = await settleTasks([
    async () => cleanupPhotoFixture(adminPool, orderId, photoId),
    async () => rm(tempRoot, { recursive: true, force: true }),
  ]);
  const poolFailures = await settleTasks([async () => appPool.end(), async () => adminPool.end()]);
  const failures = [
    ...(exerciseFailed ? [exerciseFailure] : []),
    ...triggerFailures,
    ...fixtureAndFileFailures,
    ...poolFailures,
  ];
  if (failures.length > 0) {
    throw new AggregateError(failures, "real PG photo fixture, exercise, or cleanup failed");
  }
});

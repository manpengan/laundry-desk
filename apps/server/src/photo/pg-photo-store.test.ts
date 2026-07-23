import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext } from "../bus/types.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { createPgPool, resolvePgUrls, type PgPool, type PgPoolClient } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { seedDemoIdentity } from "../local/pg-seed.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { createPgPhotoStore } from "./pg-photo-store.js";

const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GARMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PHOTO_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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

type RecordedQuery = Readonly<{ sql: string; params: readonly unknown[] | undefined }>;

function createCapturingPool(): Readonly<{ pool: PgPool; queries: RecordedQuery[] }> {
  const queries: RecordedQuery[] = [];
  const client = {
    async query<TRow>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<{ rows: TRow[]; rowCount: number }> {
      queries.push(Object.freeze({ sql, params }));
      if (sql.includes("INSERT INTO garment_photos")) {
        return {
          rows: [
            {
              id: PHOTO_ID,
              org_id: DEMO_ORG_ID,
              store_id: DEMO_STORE_ID,
              garment_id: GARMENT_ID,
              order_id: ORDER_ID,
              kind: "receive",
              storage_key: "photos/receive.jpg",
              content_type: "image/jpeg",
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
    storage_key: "photos/receive.jpg",
    content_type: "image/jpeg",
    byte_size: 42,
    taken_at: 1_784_764_800,
    created_by_staff_id: DEMO_STAFF_A_ID,
  });

  assert.equal(photo.photo_id, PHOTO_ID);
  assert.equal(photo.taken_at, 1_784_764_800);
  const insert = queries.find((query) => query.sql.includes("INSERT INTO garment_photos"));
  assert.ok(insert);
  assert.deepEqual(insert.params?.slice(0, 5), [
    PHOTO_ID,
    DEMO_ORG_ID,
    DEMO_STORE_ID,
    GARMENT_ID,
    ORDER_ID,
  ]);
  assert.ok(queries.some((query) => query.sql.includes("app.org_id")));
  assert.ok(queries.some((query) => query.sql.includes("app.store_id")));
});

test("PG photo store rejects a repository scope that differs from its server configuration", async () => {
  const { pool } = createCapturingPool();
  const store = createPgPhotoStore(pool, { orgId: DEMO_ORG_ID, storeId: DEMO_STORE_ID });
  await assert.rejects(
    () => store.listByOrder(DEMO_ORG_ID, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", ORDER_ID),
    /does not match authenticated tenant/u,
  );
});

maybe("PG photo command persists metadata and audit through the command transaction", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });
  const orderId = randomUUID();
  const lineId = randomUUID();
  const garmentId = randomUUID();
  const storageKey = `photos/${randomUUID()}.jpg`;
  try {
    await seedDemoIdentity(adminPool);
    await adminPool.query(
      `INSERT INTO orders (
         id, org_id, store_id, ticket_no, status, customer_phone, customer_name, note,
         subtotal_cents, payable_cents, paid_cents, balance_cents,
         created_at, updated_at, created_by_staff_id
       ) VALUES ($1, $2, $3, $4, 'open', NULL, NULL, NULL, 1000, 1000, 0, 1000, now(), now(), $5)`,
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

    const store = createPgPhotoStore(appPool, { orgId: DEMO_ORG_ID, storeId: DEMO_STORE_ID });
    const { registry, chainHooks } = createRegisteredM1Bus({ photo: { store } });
    const result = await withPoolClient(appPool, (sql) =>
      executeCommand(
        sql,
        TENANT,
        "photo.register",
        {
          order_id: orderId,
          garment_id: garmentId,
          kind: "receive",
          storage_key: storageKey,
          byte_size: 12,
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
          [storageKey],
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
  } finally {
    await appPool.end();
    await adminPool.end();
  }
});

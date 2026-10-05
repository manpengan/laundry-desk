import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPgPool, resolvePgUrls, withClient } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { seedMigrationTenant } from "../data-transfer/import-test-fixture.js";
import { listOrderPage } from "./pg-order-page.js";

const urls = resolvePgUrls();
test(
  "PG order paging: 51 debts, old settled order, literal search, ready state, empty page and RLS",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin });
    const app = createPgPool({ connectionString: urls.app });
    try {
      const tenant = await seedMigrationTenant(admin);
      const other = await seedMigrationTenant(admin);
      await withClient(app, async (client) =>
        withTenantTransaction(client, tenant, async () => {
          const customerId = randomUUID();
          await client.query(
            "INSERT INTO customers(id,org_id,phone,name,created_at,updated_at) VALUES($1,$2,'13800000001','合成%客户',now(),now())",
            [customerId, tenant.orgId],
          );
          const ids = Array.from({ length: 52 }, () => randomUUID());
          for (const [i, id] of ids.entries()) {
            await client.query(
              `INSERT INTO orders(id,org_id,store_id,ticket_no,pickup_code,status,customer_id,customer_phone,customer_name,
          subtotal_cents,original_cents,payable_cents,paid_cents,balance_cents,created_at,updated_at,created_by_staff_id,business_date)
          VALUES($1,$2,$3,$4,$5,$6,$7,'13800000001','合成%客户',3000,3000,3000,$8,$9,to_timestamp($10),now(),$11,$12)`,
              [
                id,
                tenant.orgId,
                tenant.storeId,
                `TEST-${i}`,
                String(100000 + i),
                i === 51 ? "closed" : "open",
                customerId,
                i === 51 ? 3000 : 1000,
                i === 51 ? 0 : 2000,
                1700000000 + i,
                tenant.staffId,
                i === 51 ? "2020-01-01" : "2026-10-01",
              ],
            );
          }
          const first = await listOrderPage(client, tenant.orgId, tenant.storeId, {
            minBalanceCents: 1,
            offset: 0,
            limit: 50,
          });
          const last = await listOrderPage(client, tenant.orgId, tenant.storeId, {
            minBalanceCents: 1,
            offset: 50,
            limit: 50,
          });
          assert.equal(first.total, 51);
          assert.equal(first.orders.length, 50);
          assert.equal(last.orders.length, 1);
          assert.equal(
            new Set([...first.orders, ...last.orders].map((row) => row.order_id)).size,
            51,
          );
          const old = await listOrderPage(client, tenant.orgId, tenant.storeId, {
            ticketNo: "TEST-51",
            customerQuery: "%",
            status: "closed",
            dateFrom: "2019-01-01",
            dateTo: "2020-12-31",
            offset: 0,
            limit: 20,
          });
          assert.equal(old.total, 1);
          assert.equal(old.orders[0]?.balance_cents, 0);
          const history = await listOrderPage(client, tenant.orgId, tenant.storeId, {
            customerId,
            offset: 20,
            limit: 20,
          });
          assert.equal(history.total, 52);
          assert.equal(history.orders.length, 20);
          const beyond = await listOrderPage(client, tenant.orgId, tenant.storeId, {
            offset: 100,
            limit: 50,
          });
          assert.equal(beyond.total, 52);
          assert.deepEqual(beyond.orders, []);
          const empty = await listOrderPage(client, tenant.orgId, tenant.storeId, {
            readyForPickup: true,
            offset: 0,
            limit: 50,
          });
          assert.equal(empty.total, 0);
          const lineId = randomUUID();
          await client.query(
            `INSERT INTO order_lines(id,org_id,store_id,order_id,line_index,service_code,category_code,unit_price_cents,qty,line_total_cents)
            VALUES($1,$2,$3,$4,0,'wash','shirt',3000,1,3000)`,
            [lineId, tenant.orgId, tenant.storeId, ids[0]],
          );
          await client.query(
            `INSERT INTO garments(id,org_id,store_id,order_id,order_line_id,seq,barcode,service_code,category_code,unit_price_cents,status,
              rack_zone,rack_slot,racked_at,racked_by_staff_id)
            VALUES($1,$2,$3,$4,$5,1,'SYNTHETIC-READY','wash','shirt',3000,'racked','TEST','001',now(),$6)`,
            [randomUUID(), tenant.orgId, tenant.storeId, ids[0], lineId, tenant.staffId],
          );
          const ready = await listOrderPage(client, tenant.orgId, tenant.storeId, {
            readyForPickup: true,
            offset: 0,
            limit: 50,
          });
          assert.equal(ready.total, 1);
          assert.equal(ready.orders[0]?.garment_count, 1);
          const cross = await listOrderPage(client, other.orgId, other.storeId, {
            offset: 0,
            limit: 50,
          });
          assert.equal(cross.total, 0);
        }),
      );
    } finally {
      await app.end();
      await admin.end();
    }
  },
);

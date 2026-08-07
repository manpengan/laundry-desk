import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext } from "../bus/types.js";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgNotificationStore } from "./pg-store.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_ADMIN_ID,
});
const ACTOR: ActorContext = Object.freeze({
  staffId: DEMO_ADMIN_ID,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze(["customer_read"]),
});
const NOW = new Date("2026-08-07T04:00:00.000Z");

type Fixture = Readonly<{ orderId: string; phone: string; ticket: string }>;

async function seedCandidate(appPool: ReturnType<typeof createPgPool>): Promise<Fixture> {
  const customerId = randomUUID();
  const orderId = randomUUID();
  const lineId = randomUUID();
  const garmentId = randomUUID();
  const phone = `131${String(Date.now()).slice(-8)}`;
  const ticket = `REM-${orderId.slice(0, 8)}`;
  await withPoolClient(appPool, (client) =>
    withTenantTransaction(client, TENANT, async (tx) => {
      await tx.query(
        `INSERT INTO customers (id, org_id, phone, name, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'PG reminder', now(), now())`,
        [customerId, TENANT.orgId, phone],
      );
      await tx.query(
        `INSERT INTO orders (
           id, org_id, store_id, ticket_no, status, customer_id, customer_phone,
           customer_name, subtotal_cents, payable_cents, paid_cents, balance_cents,
           created_at, updated_at, created_by_staff_id, business_date
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, 'open', $5::uuid, $6,
           'PG reminder', 500, 500, 0, 500,
           '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', $7::uuid, '2025-01-01'
         )`,
        [orderId, TENANT.orgId, TENANT.storeId, ticket, customerId, phone, TENANT.staffId],
      );
      await tx.query(
        `INSERT INTO order_lines (
           id, org_id, store_id, order_id, line_index, service_code, category_code,
           unit_price_cents, qty, line_total_cents
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 0, 'wash', 'coat', 500, 1, 500)`,
        [lineId, TENANT.orgId, TENANT.storeId, orderId],
      );
      await tx.query(
        `INSERT INTO garments (
           id, org_id, store_id, order_id, order_line_id, seq, barcode,
           service_code, category_code, unit_price_cents, status, rack_zone, rack_slot,
           racked_at, racked_by_staff_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1, $6,
                   'wash', 'coat', 500, 'racked', 'P', '1',
                   '2025-01-01T00:00:00.000Z', $7::uuid)`,
        [
          garmentId,
          TENANT.orgId,
          TENANT.storeId,
          orderId,
          lineId,
          `REM-${garmentId}`,
          TENANT.staffId,
        ],
      );
    }),
  );
  return Object.freeze({ orderId, phone, ticket });
}

maybe(
  "real PG reminder query, R3 confirmation, log and last-contact projection agree",
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app });
    try {
      await seedPgTestIdentityFixture(adminPool);
      const fixture = await seedCandidate(appPool);
      const { registry, queryRegistry, chainHooks } = createRegisteredM1Bus({
        notification: Object.freeze({ store: createPgNotificationStore(), now: () => NOW }),
      });
      const input = Object.freeze({
        min_age_days: 180,
        unpaid_only: true,
        garment_statuses: Object.freeze(["racked"]),
        limit: 50,
      });
      const queried = await withPoolClient(appPool, (sql) =>
        executeQuery(sql, TENANT, "notification.pickup_reminders.list", input, {
          registry: queryRegistry,
          actor: ACTOR,
        }),
      );
      assert.equal(queried.ok, true, JSON.stringify(queried));
      if (!queried.ok) return;
      const result = queried.data.result as {
        channels: { manual: boolean; sms: boolean; wechat: boolean };
        candidates: Array<{
          order_id: string;
          customer_phone: string;
          last_contact_at: string | null;
        }>;
      };
      assert.deepEqual(result.channels, { manual: true, sms: false, wechat: false });
      const candidate = result.candidates.find((row) => row.order_id === fixture.orderId);
      assert.equal(candidate?.customer_phone, fixture.phone);
      assert.equal(candidate?.last_contact_at, null);

      const commandInput = Object.freeze({
        order_ids: Object.freeze([fixture.orderId]),
        group_by: "order",
        message_template: "订单{{tickets}}欠{{balance_cents}}分",
        format: "csv",
        min_age_days: 180,
        unpaid_only: true,
        garment_statuses: Object.freeze(["racked"]),
      });
      const gated = await withPoolClient(appPool, (sql) =>
        executeCommand(sql, TENANT, "notification.manual_list.create", commandInput, {
          registry,
          actor: ACTOR,
          chainHooks,
        }),
      );
      assert.equal(gated.ok, false, JSON.stringify(gated));
      const detail = !gated.ok && "detail" in gated.error ? gated.error.detail : undefined;
      if (detail?.kind !== "confirmation") assert.fail("manual list must return R3 confirmation");
      const created = await withPoolClient(appPool, (sql) =>
        executeCommand(
          sql,
          TENANT,
          "notification.manual_list.create",
          {},
          {
            registry,
            actor: ACTOR,
            chainHooks,
            confirmRef: detail.confirm_ref,
          },
        ),
      );
      assert.equal(created.ok, true, JSON.stringify(created));
      if (created.ok) {
        const exported = created.data.result as { status: string; csv: string };
        assert.equal(exported.status, "list_generated");
        assert.match(exported.csv, new RegExp(fixture.phone, "u"));
        assert.match(exported.csv, new RegExp(fixture.ticket, "u"));
      }

      const evidence = await withPoolClient(appPool, (sql) =>
        withTenantTransaction(sql, TENANT, (tx) =>
          tx.query<{ status: string; channel: string; cost_cents: number }>(
            `SELECT status, channel, cost_cents
             FROM notification_log
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid`,
            [TENANT.orgId, TENANT.storeId, fixture.orderId],
          ),
        ),
      );
      assert.deepEqual(evidence.rows[0], {
        status: "list_generated",
        channel: "manual",
        cost_cents: 0,
      });
    } finally {
      await adminPool.end();
      await appPool.end();
    }
  },
);

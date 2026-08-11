import assert from "node:assert/strict";

import { createPgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import {
  CUSTOMER_PHONE,
  FIXED_BUSINESS_DATE,
  TARGET_CUSTOMER_PHONE,
  TENANT,
} from "./pg-workday-test-context.js";

type Pool = ReturnType<typeof createPgPool>;

export async function clearWorkdayFixture(pool: Pool): Promise<void> {
  const client = await pool.connect();
  const scope = [DEMO_ORG_ID, DEMO_STORE_ID, FIXED_BUSINESS_DATE];
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    await client.query(
      `DELETE FROM audit_log
        WHERE org_id = $1::uuid AND store_id = $2::uuid
          AND entity_id IN (
            SELECT id::text FROM orders
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3
            UNION SELECT id::text FROM garments
              WHERE org_id = $1::uuid AND store_id = $2::uuid
                AND order_id IN (
                  SELECT id FROM orders
                    WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3
                )
            UNION SELECT id::text FROM payments
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3
            UNION SELECT id::text FROM shift_closings
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3
            UNION SELECT id::text FROM customers
              WHERE org_id = $1::uuid AND phone IN ($4, $5)
            UNION SELECT id::text FROM member_accounts
              WHERE org_id = $1::uuid AND customer_id IN (
                SELECT id FROM customers WHERE org_id = $1::uuid AND phone IN ($4, $5)
              )
          )`,
      [...scope, CUSTOMER_PHONE, TARGET_CUSTOMER_PHONE],
    );
    const orderIds = `SELECT id FROM orders
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3`;
    await client.query(
      `DELETE FROM member_ledger
        WHERE org_id = $1::uuid AND account_id IN (
          SELECT id FROM member_accounts WHERE org_id = $1::uuid AND customer_id IN (
            SELECT id FROM customers WHERE org_id = $1::uuid AND phone IN ($2, $3)
          )
        )`,
      [DEMO_ORG_ID, CUSTOMER_PHONE, TARGET_CUSTOMER_PHONE],
    );
    for (const table of [
      "garment_rack_log",
      "garment_incidents",
      "garment_status_log",
      "payments",
      "garments",
      "order_lines",
    ]) {
      await client.query(
        `DELETE FROM ${table}
          WHERE org_id = $1::uuid AND store_id = $2::uuid
            AND order_id IN (${orderIds})`,
        scope,
      );
    }
    await client.query(
      "DELETE FROM orders WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3",
      scope,
    );
    await client.query(
      "DELETE FROM shift_closings WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3",
      scope,
    );
    await client.query(
      `DELETE FROM member_accounts
        WHERE org_id = $1::uuid AND customer_id IN (
          SELECT id FROM customers WHERE org_id = $1::uuid AND phone IN ($2, $3)
        )`,
      [DEMO_ORG_ID, CUSTOMER_PHONE, TARGET_CUSTOMER_PHONE],
    );
    await client.query("DELETE FROM customers WHERE org_id = $1::uuid AND phone IN ($2, $3)", [
      DEMO_ORG_ID,
      CUSTOMER_PHONE,
      TARGET_CUSTOMER_PHONE,
    ]);
    await client.query(
      `DELETE FROM catalog_items
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND code LIKE 'acc-shirt-%'`,
      [DEMO_ORG_ID, DEMO_STORE_ID],
    );
    await client.query(
      `DELETE FROM store_pricing_policies
        WHERE org_id = $1::uuid AND store_id = $2::uuid`,
      [DEMO_ORG_ID, DEMO_STORE_ID],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readClosedWriteCounts(pool: Pool): Promise<Readonly<Record<string, number>>> {
  return withPoolClient(pool, (sql) =>
    withTenantTransaction(sql, TENANT, async (tx) => {
      const result = await tx.query<{
        orders: string;
        payments: string;
        member_ledger: string;
        audit: string;
      }>(
        `SELECT
           (SELECT count(*) FROM orders WHERE business_date = $1)::text AS orders,
           (SELECT count(*) FROM payments WHERE business_date = $1)::text AS payments,
           (SELECT count(*) FROM member_ledger WHERE business_date = $1)::text AS member_ledger,
           (SELECT count(*) FROM audit_log)::text AS audit`,
        [FIXED_BUSINESS_DATE],
      );
      const row = result.rows[0];
      assert.ok(row);
      return Object.freeze({
        orders: Number(row.orders),
        payments: Number(row.payments),
        member_ledger: Number(row.member_ledger),
        audit: Number(row.audit),
      });
    }),
  );
}

type OrderSnapshot = Readonly<{
  business_date: string;
  original_cents: number;
  discount_cents: number;
  addon_cents: number;
  urgent_cents: number;
  freight_cents: number;
  pricing_policy_version: number;
  urgent_selected: boolean;
  freight_selected: boolean;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  garment_count: number;
  picked_up_count: number;
  payment_count: number;
}>;

export async function readGarmentRefs(
  pool: Pool,
  orderId: string,
): Promise<readonly Readonly<{ id: string; barcode: string }>[]> {
  return withPoolClient(pool, (sql) =>
    withTenantTransaction(sql, TENANT, async (tx) => {
      const result = await tx.query<{ id: string; barcode: string }>(
        "SELECT id::text, barcode FROM garments WHERE order_id = $1::uuid ORDER BY id",
        [orderId],
      );
      return Object.freeze(result.rows.map((row) => Object.freeze({ ...row })));
    }),
  );
}

export async function readFulfillment(
  pool: Pool,
  orderId: string,
): Promise<Readonly<{ statuses: readonly string[]; statusLogs: number; incidents: number }>> {
  return withPoolClient(pool, (sql) =>
    withTenantTransaction(sql, TENANT, async (tx) => {
      const garments = await tx.query<{ status: string }>(
        "SELECT status FROM garments WHERE order_id = $1::uuid ORDER BY id",
        [orderId],
      );
      const counts = await tx.query<{ status_logs: string; incidents: string }>(
        `SELECT
           (SELECT count(*) FROM garment_status_log WHERE order_id = $1::uuid)::text AS status_logs,
           (SELECT count(*) FROM garment_incidents WHERE order_id = $1::uuid)::text AS incidents`,
        [orderId],
      );
      return Object.freeze({
        statuses: Object.freeze(garments.rows.map((row) => row.status)),
        statusLogs: Number(counts.rows[0]?.status_logs ?? "0"),
        incidents: Number(counts.rows[0]?.incidents ?? "0"),
      });
    }),
  );
}

export async function readOrderCustomerLink(
  pool: Pool,
  orderId: string,
): Promise<Readonly<{ customer_id: string | null; customer_phone: string | null }>> {
  return withPoolClient(pool, (sql) =>
    withTenantTransaction(sql, TENANT, async (tx) => {
      const result = await tx.query<{
        customer_id: string | null;
        customer_phone: string | null;
      }>("SELECT customer_id::text, customer_phone FROM orders WHERE id = $1::uuid", [orderId]);
      return Object.freeze({
        customer_id: result.rows[0]?.customer_id ?? null,
        customer_phone: result.rows[0]?.customer_phone ?? null,
      });
    }),
  );
}

export async function readOrder(pool: Pool, orderId: string): Promise<OrderSnapshot> {
  return withPoolClient(pool, (sql) =>
    withTenantTransaction(sql, TENANT, async (tx) => {
      const order = await tx.query<{
        business_date: string;
        original_cents: number;
        discount_cents: number;
        addon_cents: number;
        urgent_cents: number;
        freight_cents: number;
        pricing_policy_version: number;
        urgent_selected: boolean;
        freight_selected: boolean;
        payable_cents: number;
        paid_cents: number;
        balance_cents: number;
      }>(
        `SELECT business_date, original_cents, discount_cents, addon_cents,
                urgent_cents, freight_cents, pricing_policy_version,
                urgent_selected, freight_selected,
                payable_cents, paid_cents, balance_cents
           FROM orders WHERE id = $1`,
        [orderId],
      );
      const garments = await tx.query<{ total: string; picked: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE status = 'picked_up')::text AS picked
           FROM garments WHERE order_id = $1`,
        [orderId],
      );
      const payments = await tx.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM payments WHERE order_id = $1",
        [orderId],
      );
      const row = order.rows[0];
      assert.ok(row, "order row must exist");
      return Object.freeze({
        business_date: row.business_date,
        original_cents: row.original_cents,
        discount_cents: row.discount_cents,
        addon_cents: row.addon_cents,
        urgent_cents: row.urgent_cents,
        freight_cents: row.freight_cents,
        pricing_policy_version: row.pricing_policy_version,
        urgent_selected: row.urgent_selected,
        freight_selected: row.freight_selected,
        payable_cents: row.payable_cents,
        paid_cents: row.paid_cents,
        balance_cents: row.balance_cents,
        garment_count: Number(garments.rows[0]?.total ?? "0"),
        picked_up_count: Number(garments.rows[0]?.picked ?? "0"),
        payment_count: Number(payments.rows[0]?.count ?? "0"),
      });
    }),
  );
}

import type { PaymentKind, PaymentMethod, PaymentRow } from "@laundry/domain";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import type { PaymentStore } from "./types.js";

type PaymentDbRow = Readonly<{
  id: string;
  org_id: string;
  store_id: string;
  order_id: string;
  method: string;
  amount_cents: number;
  kind: string;
  ref_payment_id: string | null;
  staff_id: string;
  at: Date | string;
  note: string | null;
}>;

const METHODS = new Set<PaymentMethod>(["cash", "wechat", "alipay", "other"]);
const KINDS = new Set<PaymentKind>(["pay", "repay", "refund", "storage_fee", "reversal"]);

function mapPayment(row: PaymentDbRow): PaymentRow {
  if (!METHODS.has(row.method as PaymentMethod) || !KINDS.has(row.kind as PaymentKind)) {
    throw new Error("Invalid payment enum from PostgreSQL");
  }
  const at = row.at instanceof Date ? row.at.getTime() : new Date(row.at).getTime();
  if (!Number.isSafeInteger(row.amount_cents) || row.amount_cents <= 0 || !Number.isFinite(at)) {
    throw new Error("Invalid payment cents or timestamp from PostgreSQL");
  }
  return Object.freeze({
    payment_id: row.id,
    org_id: row.org_id,
    store_id: row.store_id,
    order_id: row.order_id,
    method: row.method as PaymentMethod,
    amount_cents: row.amount_cents,
    kind: row.kind as PaymentKind,
    ref_payment_id: row.ref_payment_id,
    staff_id: row.staff_id,
    at: Math.floor(at / 1000),
    note: row.note,
  });
}

/**
 * `at` is business time (second precision), so it cannot be the sole ledger
 * ordering key. Preserve the SQL order for independent rows while ensuring a
 * correction is always evaluated after the payment it references.
 */
export function orderPaymentLedger(rows: readonly PaymentRow[]): readonly PaymentRow[] {
  const pending = [...rows];
  const ordered: PaymentRow[] = [];
  const appended = new Set<string>();

  while (pending.length > 0) {
    const index = pending.findIndex(
      (payment) => payment.ref_payment_id === null || appended.has(payment.ref_payment_id),
    );
    if (index === -1) return Object.freeze([...ordered, ...pending]);
    const [payment] = pending.splice(index, 1);
    if (payment === undefined) throw new Error("Missing pending payment");
    ordered.push(payment);
    appended.add(payment.payment_id);
  }
  return Object.freeze(ordered);
}

async function listPayments(
  client: SqlClient,
  orgId: string,
  storeId: string,
  orderId: string,
): Promise<readonly PaymentRow[]> {
  const result = await client.query<PaymentDbRow>(
    `SELECT id::text, org_id::text, store_id::text, order_id::text, method,
            amount_cents, kind, ref_payment_id::text, staff_id::text, at, note
     FROM payments
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid
     ORDER BY at ASC, id ASC`,
    [orgId, storeId, orderId],
  );
  return orderPaymentLedger(result.rows.map(mapPayment));
}

async function appendPayment(client: SqlClient, payment: PaymentRow): Promise<void> {
  await client.query(
    `INSERT INTO payments (
       id, org_id, store_id, order_id, method, amount_cents, kind,
       ref_payment_id, staff_id, at, note
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
               $8::uuid, $9::uuid, $10, $11)`,
    [
      payment.payment_id,
      payment.org_id,
      payment.store_id,
      payment.order_id,
      payment.method,
      payment.amount_cents,
      payment.kind,
      payment.ref_payment_id,
      payment.staff_id,
      new Date(payment.at * 1000),
      payment.note,
    ],
  );
}

/** PostgreSQL ledger repository; command calls reuse the active bus transaction. */
export function createPgPaymentStore(pool: PgPool): PaymentStore {
  return Object.freeze({
    listPayments: (orgId, storeId, orderId) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, (client) =>
        listPayments(client, orgId, storeId, orderId),
      ),
    appendPayment: (payment) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: payment.org_id, storeId: payment.store_id, staffId: payment.staff_id },
        (client) => appendPayment(client, payment),
      ),
  });
}

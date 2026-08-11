import type { PaymentKind, PaymentLedgerMethod } from "@laundry/domain";

import type { SqlClient } from "../db/types.js";
import { dateToEpoch } from "./pg-order-mappers.js";
import { orderPaymentsByReference } from "./payment-reference-order.js";
import type { LedgerPaymentRow } from "./types.js";

/** Read one store's append-only ledger in durable, dependency-first order. */
export async function listPaymentRows(
  client: SqlClient,
  orgId: string,
  storeId: string,
  orderId?: string,
  limit?: number,
): Promise<readonly LedgerPaymentRow[]> {
  type PaymentSqlRow = Readonly<{
    id: string;
    org_id: string;
    store_id: string;
    order_id: string;
    method: PaymentLedgerMethod;
    amount_cents: number;
    kind: PaymentKind;
    ref_payment_id: string | null;
    staff_id: string;
    at: Date | string;
    business_date: string;
    note: string | null;
  }>;
  const sql = `SELECT id::text, org_id::text, store_id::text, order_id::text, method,
            amount_cents, kind, ref_payment_id::text, staff_id::text, at, business_date, note
     FROM payments
     WHERE org_id = $1::uuid AND store_id = $2::uuid
       AND ($3::uuid IS NULL OR order_id = $3::uuid)
     ORDER BY ledger_seq ASC${limit === undefined ? "" : "\n     LIMIT $4"}`;
  const values =
    limit === undefined
      ? Object.freeze([orgId, storeId, orderId ?? null])
      : Object.freeze([orgId, storeId, orderId ?? null, limit]);
  const result = await client.query<PaymentSqlRow>(sql, values);
  return orderPaymentsByReference(
    Object.freeze(
      result.rows.map((row) =>
        Object.freeze({
          payment_id: row.id,
          org_id: row.org_id,
          store_id: row.store_id,
          order_id: row.order_id,
          method: row.method,
          amount_cents: row.amount_cents,
          kind: row.kind,
          ref_payment_id: row.ref_payment_id,
          staff_id: row.staff_id,
          at: dateToEpoch(row.at),
          business_date: row.business_date,
          note: row.note,
        }),
      ),
    ),
  );
}

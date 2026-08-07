import {
  ACCOUNTING_METHODS,
  aggregateAccountingReport,
  type AccountingMethod,
  type AccountingMovement,
} from "@laundry/domain";

import type { AccountingReadPort } from "./types.js";

type MovementRow = Readonly<{
  source: string;
  business_date: string;
  staff_id: string;
  staff_name: string;
  method: string;
  net_cents: number | string;
  ledger_row_count: number | string;
}>;

const REPORT_SQL = `
  WITH signed_payments AS (
    SELECT
      payment.business_date,
      payment.staff_id,
      staff.display_name AS staff_name,
      CASE
        WHEN payment.kind = 'reversal' THEN referenced.method
        ELSE payment.method
      END AS method,
      CASE
        WHEN payment.kind = 'refund' THEN -payment.amount_cents
        WHEN payment.kind = 'reversal' AND referenced.kind = 'refund'
          THEN payment.amount_cents
        WHEN payment.kind = 'reversal' THEN -payment.amount_cents
        ELSE payment.amount_cents
      END AS net_cents
    FROM payments AS payment
    LEFT JOIN payments AS referenced
      ON referenced.org_id = payment.org_id
     AND referenced.store_id = payment.store_id
     AND referenced.id = payment.ref_payment_id
    JOIN staffs AS staff
      ON staff.org_id = payment.org_id
     AND staff.id = payment.staff_id
    WHERE payment.org_id = $1::uuid
      AND payment.store_id = $2::uuid
      AND payment.business_date BETWEEN $3 AND $4
      AND ($5::uuid IS NULL OR payment.staff_id = $5::uuid)
  ),
  payment_movements AS (
    SELECT
      'order'::text AS source,
      signed.business_date,
      signed.staff_id,
      signed.staff_name,
      signed.method,
      SUM(signed.net_cents)::bigint AS net_cents,
      COUNT(*)::integer AS ledger_row_count
    FROM signed_payments AS signed
    GROUP BY signed.business_date, signed.staff_id, signed.staff_name, signed.method
  ),
  stored_value_movements AS (
    SELECT
      'stored_value'::text AS source,
      ledger.business_date,
      ledger.staff_id,
      staff.display_name AS staff_name,
      ledger.tender AS method,
      SUM(ledger.principal_delta_cents)::bigint AS net_cents,
      COUNT(*)::integer AS ledger_row_count
    FROM member_ledger AS ledger
    JOIN staffs AS staff
      ON staff.org_id = ledger.org_id
     AND staff.id = ledger.staff_id
    WHERE ledger.org_id = $1::uuid
      AND ledger.store_id = $2::uuid
      AND ledger.business_date BETWEEN $3 AND $4
      AND ledger.tender IS NOT NULL
      AND ($5::uuid IS NULL OR ledger.staff_id = $5::uuid)
    GROUP BY ledger.business_date, ledger.staff_id, staff.display_name, ledger.tender
  )
  SELECT * FROM payment_movements
  UNION ALL
  SELECT * FROM stored_value_movements
  ORDER BY business_date, staff_name, staff_id, method, source
`;

function requireSafeInteger(value: number | string, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`invalid PostgreSQL ${field}`);
  return parsed;
}

function isMethod(value: string): value is AccountingMethod {
  return (ACCOUNTING_METHODS as readonly string[]).includes(value);
}

function toMovement(row: MovementRow): AccountingMovement {
  if (row.source !== "order" && row.source !== "stored_value") {
    throw new TypeError("invalid PostgreSQL accounting source");
  }
  if (!isMethod(row.method)) throw new TypeError("invalid PostgreSQL accounting method");
  return Object.freeze({
    source: row.source,
    business_date: row.business_date,
    staff_id: row.staff_id,
    staff_name: row.staff_name,
    method: row.method,
    net_cents: requireSafeInteger(row.net_cents, "net_cents"),
    ledger_row_count: requireSafeInteger(row.ledger_row_count, "ledger_row_count"),
  });
}

export function createPgAccountingSource(): AccountingReadPort {
  return Object.freeze({
    readReport: async (request) => {
      const result = await request.client.query<MovementRow>(REPORT_SQL, [
        request.tenant.orgId,
        request.tenant.storeId,
        request.dateFrom,
        request.dateTo,
        request.staffId,
      ]);
      return aggregateAccountingReport(result.rows.map(toMovement), request.groupBy);
    },
  });
}

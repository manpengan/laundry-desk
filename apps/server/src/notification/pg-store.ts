import { PickupReminderCandidateSchema, type PickupReminderCandidate } from "@laundry/contracts";

import type { QueryResult, SqlClient } from "../db/types.js";
import type {
  NotificationLogWrite,
  NotificationStore,
  PickupReminderListRequest,
} from "./types.js";

type CandidateRow = Readonly<{
  order_id: string;
  ticket_no: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string;
  garment_count: string | number;
  balance_cents: number;
  received_at: Date | string;
  garment_statuses: readonly string[];
  last_contact_at: Date | string | null;
}>;

const LIST_SQL = `
  WITH eligible AS (
    SELECT
      o.id AS order_id,
      o.ticket_no,
      o.customer_id,
      o.customer_name,
      o.customer_phone,
      COUNT(g.id)::text AS garment_count,
      o.balance_cents,
      o.created_at AS received_at,
      ARRAY_AGG(DISTINCT g.status ORDER BY g.status) AS garment_statuses
    FROM orders AS o
    JOIN garments AS g
      ON g.org_id = o.org_id
     AND g.store_id = o.store_id
     AND g.order_id = o.id
    WHERE o.org_id = $1::uuid
      AND o.store_id = $2::uuid
      AND o.status = 'open'
      AND o.ticket_no IS NOT NULL
      AND o.customer_pii_purged_at IS NULL
      AND o.customer_phone ~ '^1[3-9][0-9]{9}$'
      AND o.created_at <= $3::timestamptz
      AND ($4::boolean = false OR o.balance_cents > 0)
      AND g.status = ANY($5::text[])
      AND ($7::uuid[] IS NULL OR o.id = ANY($7::uuid[]))
    GROUP BY o.id, o.ticket_no, o.customer_id, o.customer_name,
      o.customer_phone, o.balance_cents, o.created_at
  )
  SELECT
    eligible.*,
    contact.last_contact_at
  FROM eligible
  LEFT JOIN LATERAL (
    SELECT MAX(log.created_at) AS last_contact_at
    FROM notification_log AS log
    WHERE log.org_id = $1::uuid
      AND log.store_id = $2::uuid
      AND log.order_id = eligible.order_id
      AND log.channel = 'manual'
      AND log.status = 'list_generated'
  ) AS contact ON true
  ORDER BY eligible.received_at ASC, eligible.ticket_no ASC
  LIMIT $6::integer
`;

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid notification timestamp");
  return date.toISOString();
}

function toPositiveInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError("Invalid reminder garment count");
  }
  return parsed;
}

function toCandidate(row: CandidateRow, now: Date): PickupReminderCandidate {
  const receivedAt = new Date(toIso(row.received_at));
  const overdueDays = Math.max(0, Math.floor((now.getTime() - receivedAt.getTime()) / 86_400_000));
  return PickupReminderCandidateSchema.parse({
    order_id: row.order_id,
    ticket_no: row.ticket_no,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    garment_count: toPositiveInteger(row.garment_count),
    balance_cents: row.balance_cents,
    received_at: receivedAt.toISOString(),
    overdue_days: overdueDays,
    garment_statuses: row.garment_statuses,
    last_contact_at: row.last_contact_at === null ? null : toIso(row.last_contact_at),
  });
}

async function listPickupReminders(
  request: PickupReminderListRequest,
): Promise<readonly PickupReminderCandidate[]> {
  const cutoff = new Date(request.now.getTime() - request.filters.minAgeDays * 86_400_000);
  const result = await request.client.query<CandidateRow>(LIST_SQL, [
    request.tenant.orgId,
    request.tenant.storeId,
    cutoff.toISOString(),
    request.filters.unpaidOnly,
    request.filters.garmentStatuses,
    request.filters.limit,
    request.orderIds ?? null,
  ]);
  return Object.freeze(result.rows.map((row) => toCandidate(row, request.now)));
}

async function lockOrders(
  client: SqlClient,
  tenant: Parameters<NotificationStore["lockOrders"]>[1],
  orderIds: readonly string[],
): Promise<number> {
  const result: QueryResult<Readonly<{ id: string }>> = await client.query(
    `SELECT id
       FROM orders
      WHERE org_id = $1::uuid
        AND store_id = $2::uuid
        AND id = ANY($3::uuid[])
      ORDER BY id
      FOR SHARE`,
    [tenant.orgId, tenant.storeId, orderIds],
  );
  return result.rows.length;
}

async function appendManualList(
  client: SqlClient,
  tenant: Parameters<NotificationStore["appendManualList"]>[1],
  rows: readonly NotificationLogWrite[],
): Promise<void> {
  for (const row of rows) {
    await client.query(
      `INSERT INTO notification_log (
         id, org_id, store_id, batch_id, order_id, customer_id,
         channel, status, grouping, message_sha256, export_sha256,
         cost_cents, created_by_staff_id, created_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         'manual', 'list_generated', $7, $8, $9, 0, $10::uuid, $11::timestamptz
       )`,
      [
        row.id,
        tenant.orgId,
        tenant.storeId,
        row.batchId,
        row.orderId,
        row.customerId,
        row.grouping,
        row.messageSha256,
        row.exportSha256,
        row.staffId,
        row.createdAt.toISOString(),
      ],
    );
  }
}

export function createPgNotificationStore(): NotificationStore {
  return Object.freeze({ listPickupReminders, lockOrders, appendManualList });
}

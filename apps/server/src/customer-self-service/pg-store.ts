import { randomUUID } from "node:crypto";

import type {
  CustomerPortalGarmentProgressResult,
  CustomerPortalGarmentsListResult,
  CustomerPortalLoginInput,
  CustomerPortalOrderGetResult,
  CustomerPortalOrderSummary,
  CustomerPortalReceiptResult,
} from "@laundry/contracts";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import {
  CustomerPortalSessionInvalidError,
  type CustomerPortalQueryResult,
  type CustomerPortalSessionIdentity,
  type CustomerPortalSessionSecrets,
  type CustomerPortalStore,
} from "./types.js";

type SessionRow = Readonly<{
  session_id: string;
  org_id: string;
  store_id: string;
  customer_id: string;
  csrf_hash: string;
  authority_hash: string;
  expires_at: Date;
}>;
type OrderRow = CustomerPortalOrderSummary &
  Readonly<{
    original_cents: number;
    discount_cents: number;
    addon_cents: number;
    urgent_cents: number;
    freight_cents: number;
    business_date: string;
  }>;

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function sessionFrom(row: SessionRow): CustomerPortalSessionIdentity {
  return Object.freeze({
    sessionId: row.session_id,
    orgId: row.org_id,
    storeId: row.store_id,
    customerId: row.customer_id,
    csrfHash: row.csrf_hash,
    authorityHash: row.authority_hash,
    expiresAt: row.expires_at,
  });
}

function summaryFrom(row: OrderRow): CustomerPortalOrderSummary {
  return Object.freeze({
    order_id: row.order_id,
    ticket_no: row.ticket_no,
    status: row.status,
    payable_cents: row.payable_cents,
    paid_cents: row.paid_cents,
    balance_cents: row.balance_cents,
    garment_count: row.garment_count,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  });
}

async function setCustomerContext(
  client: PgPoolClient,
  identity: CustomerPortalSessionIdentity,
): Promise<void> {
  await client.query("SELECT set_config('app.org_id', $1, true)", [identity.orgId]);
  await client.query("SELECT set_config('app.store_id', $1, true)", [identity.storeId]);
  await client.query("SELECT set_config('app.customer_id', $1, true)", [identity.customerId]);
}

async function withPortalTransaction<T>(
  pool: PgPool,
  identity: CustomerPortalSessionIdentity,
  sessionHash: string,
  operation: string,
  resourceId: string | null,
  run: (client: PgPoolClient) => Promise<T | null>,
): Promise<T | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setCustomerContext(client, identity);
    const valid = await client.query<{ valid: boolean }>(
      "SELECT customer_portal_session_validate($1::uuid, $2::text, $3::text) AS valid",
      [identity.sessionId, sessionHash, identity.authorityHash],
    );
    if (valid.rows[0]?.valid !== true) throw new CustomerPortalSessionInvalidError();
    const result = await run(client);
    if (result !== null) {
      await client.query(
        `INSERT INTO customer_portal_access_log (
           id, org_id, store_id, customer_id, session_id, operation, resource_id, at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::uuid,
                   statement_timestamp())`,
        [
          randomUUID(),
          identity.orgId,
          identity.storeId,
          identity.customerId,
          identity.sessionId,
          operation,
          resourceId,
        ],
      );
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the query/authentication failure; rollback failure is secondary.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function orderById(client: PgPoolClient, orderId: string): Promise<OrderRow | null> {
  const result = await client.query<OrderRow>(
    `SELECT order_id::text, ticket_no, status, original_cents, discount_cents,
            addon_cents, urgent_cents, freight_cents, payable_cents, paid_cents,
            balance_cents, business_date, garment_count, created_at, updated_at
       FROM customer_portal_orders WHERE order_id = $1::uuid LIMIT 1`,
    [orderId],
  );
  return result.rows[0] ?? null;
}

async function orderLines(client: PgPoolClient, orderId: string) {
  const result = await client.query<CustomerPortalOrderGetResult["lines"][number]>(
    `SELECT line_index, service_code, category_code, unit_price_cents, qty,
            line_total_cents, color, brand
       FROM customer_portal_order_lines
      WHERE order_id = $1::uuid ORDER BY line_index LIMIT 200`,
    [orderId],
  );
  return Object.freeze(result.rows.map((row) => Object.freeze({ ...row })));
}

async function listOrders(client: PgPoolClient, limit: number) {
  const result = await client.query<OrderRow>(
    `SELECT order_id::text, ticket_no, status, payable_cents, paid_cents,
            balance_cents, garment_count, created_at, updated_at,
            original_cents, discount_cents, addon_cents, urgent_cents,
            freight_cents, business_date
       FROM customer_portal_orders
      ORDER BY created_at DESC, order_id DESC LIMIT $1`,
    [limit],
  );
  return Object.freeze({ orders: Object.freeze(result.rows.map(summaryFrom)) });
}

async function getOrder(client: PgPoolClient, orderId: string) {
  const order = await orderById(client, orderId);
  if (order === null) return null;
  return Object.freeze({ order: summaryFrom(order), lines: await orderLines(client, orderId) });
}

async function getReceipt(
  client: PgPoolClient,
  orderId: string,
): Promise<CustomerPortalReceiptResult | null> {
  const order = await orderById(client, orderId);
  if (order === null) return null;
  const [lines, payments] = await Promise.all([
    orderLines(client, orderId),
    client.query<CustomerPortalReceiptResult["receipt"]["payments"][number]>(
      `SELECT payment_id::text, method, kind, amount_cents, at
         FROM customer_portal_payments
        WHERE order_id = $1::uuid ORDER BY at, payment_id LIMIT 200`,
      [orderId],
    ),
  ]);
  return Object.freeze({
    receipt: Object.freeze({
      order_id: order.order_id,
      ticket_no: order.ticket_no,
      business_date: order.business_date,
      original_cents: order.original_cents,
      discount_cents: order.discount_cents,
      addon_cents: order.addon_cents,
      urgent_cents: order.urgent_cents,
      freight_cents: order.freight_cents,
      payable_cents: order.payable_cents,
      paid_cents: order.paid_cents,
      balance_cents: order.balance_cents,
      created_at: iso(order.created_at),
      lines,
      payments: Object.freeze(
        payments.rows.map((row) => Object.freeze({ ...row, at: iso(row.at) })),
      ),
    }),
  });
}

async function listGarments(
  client: PgPoolClient,
  orderId: string,
): Promise<CustomerPortalGarmentsListResult | null> {
  if ((await orderById(client, orderId)) === null) return null;
  const result = await client.query<CustomerPortalGarmentsListResult["garments"][number]>(
    `SELECT garment_id::text, order_id::text, seq, service_code, category_code,
            color, brand, status
       FROM customer_portal_garments
      WHERE order_id = $1::uuid ORDER BY seq, garment_id LIMIT 200`,
    [orderId],
  );
  return Object.freeze({
    garments: Object.freeze(result.rows.map((row) => Object.freeze({ ...row }))),
  });
}

async function garmentProgress(
  client: PgPoolClient,
  orderId: string,
  garmentId: string,
): Promise<CustomerPortalGarmentProgressResult | null> {
  const garment = await client.query<CustomerPortalGarmentProgressResult["garment"]>(
    `SELECT garment_id::text, order_id::text, seq, service_code, category_code,
            color, brand, status FROM customer_portal_garments
      WHERE order_id = $1::uuid AND garment_id = $2::uuid LIMIT 1`,
    [orderId, garmentId],
  );
  if (garment.rows[0] === undefined) return null;
  const progress = await client.query<CustomerPortalGarmentProgressResult["progress"][number]>(
    `SELECT from_status, to_status, at FROM customer_portal_garment_progress
      WHERE order_id = $1::uuid AND garment_id = $2::uuid ORDER BY at LIMIT 200`,
    [orderId, garmentId],
  );
  return Object.freeze({
    garment: Object.freeze({ ...garment.rows[0] }),
    progress: Object.freeze(progress.rows.map((row) => Object.freeze({ ...row, at: iso(row.at) }))),
  });
}

export function createPgCustomerPortalStore(pool: PgPool): CustomerPortalStore {
  return Object.freeze({
    async createSession(input: CustomerPortalLoginInput, secrets: CustomerPortalSessionSecrets) {
      const result = await pool.query<SessionRow>(
        `SELECT session_id::text, org_id::text, store_id::text, customer_id::text,
                csrf_hash, authority_hash, expires_at
           FROM customer_portal_session_create($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.org_code,
          input.store_code,
          input.phone,
          input.pickup_code,
          secrets.sessionHash,
          secrets.csrfHash,
          secrets.authorityHash,
        ],
      );
      return result.rows[0] === undefined ? null : sessionFrom(result.rows[0]);
    },
    async resolveSession(sessionHash) {
      const result = await pool.query<SessionRow>(
        `SELECT session_id::text, org_id::text, store_id::text, customer_id::text,
                csrf_hash, authority_hash, expires_at FROM customer_portal_session_resolve($1)`,
        [sessionHash],
      );
      return result.rows[0] === undefined ? null : sessionFrom(result.rows[0]);
    },
    async revokeSession(sessionHash, csrfHash, authorityHash) {
      const result = await pool.query<{ revoked: boolean }>(
        "SELECT customer_portal_session_revoke($1, $2, $3) AS revoked",
        [sessionHash, csrfHash, authorityHash],
      );
      return result.rows[0]?.revoked === true;
    },
    async executeQuery(
      identity,
      sessionHash,
      name,
      input,
    ): Promise<CustomerPortalQueryResult | null> {
      const orderId = typeof input.order_id === "string" ? input.order_id : null;
      const resourceId =
        name === "customer.self_service.orders.list"
          ? null
          : name === "customer.self_service.garment.progress" &&
              typeof input.garment_id === "string"
            ? input.garment_id
            : orderId;
      return withPortalTransaction(
        pool,
        identity,
        sessionHash,
        name.slice("customer.self_service.".length),
        resourceId,
        async (client) => {
          if (name === "customer.self_service.orders.list") {
            return listOrders(client, typeof input.limit === "number" ? input.limit : 20);
          }
          if (orderId === null) return null;
          if (name === "customer.self_service.order.get") return getOrder(client, orderId);
          if (name === "customer.self_service.receipt.get") return getReceipt(client, orderId);
          if (name === "customer.self_service.garments.list") return listGarments(client, orderId);
          const garmentId = typeof input.garment_id === "string" ? input.garment_id : null;
          return garmentId === null ? null : garmentProgress(client, orderId, garmentId);
        },
      );
    },
  });
}

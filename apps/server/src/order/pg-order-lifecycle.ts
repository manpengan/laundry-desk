import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import type { ApplyPaymentSummaryInput, CancelOrderInput, HoldOrderInput } from "./types.js";

const affected = (rowCount: number | null): boolean => rowCount === 1;

async function applyPaymentSummary(
  client: SqlClient,
  input: ApplyPaymentSummaryInput,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE orders
     SET paid_cents = $4, balance_cents = $5, status = $6, updated_at = $7
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
       AND status = 'open' AND paid_cents = $8 AND balance_cents = $9`,
    [
      input.orgId,
      input.storeId,
      input.orderId,
      input.paidCents,
      input.balanceCents,
      input.nextStatus,
      new Date(input.nowEpoch * 1000),
      input.expectedPaidCents,
      input.expectedBalanceCents,
    ],
  );
  return affected(result.rowCount);
}

async function holdOrder(client: SqlClient, input: HoldOrderInput): Promise<boolean> {
  const result = await client.query(
    `UPDATE orders
     SET hold_reason = $4, held_at = $5, held_by_staff_id = $6::uuid, updated_at = $5
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid AND status = 'open'`,
    [
      input.orgId,
      input.storeId,
      input.orderId,
      input.reason,
      new Date(input.nowEpoch * 1000),
      input.staffId,
    ],
  );
  return affected(result.rowCount);
}

async function cancelOrder(client: SqlClient, input: CancelOrderInput): Promise<boolean> {
  const result = await client.query(
    `UPDATE orders
     SET status = 'cancelled', paid_cents = $4, balance_cents = $5,
         hold_reason = NULL, held_at = NULL, held_by_staff_id = NULL, updated_at = $6
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
       AND status = 'open' AND paid_cents = $7 AND balance_cents = $8`,
    [
      input.orgId,
      input.storeId,
      input.orderId,
      input.paidCents,
      input.balanceCents,
      new Date(input.nowEpoch * 1000),
      input.expectedPaidCents,
      input.expectedBalanceCents,
    ],
  );
  return affected(result.rowCount);
}

export function createPgOrderLifecycle(pool: PgPool) {
  return Object.freeze({
    applyPaymentSummary: (input: ApplyPaymentSummaryInput) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: input.orgId, storeId: input.storeId, staffId: input.staffId },
        (client) => applyPaymentSummary(client, input),
      ),
    holdOrder: (input: HoldOrderInput) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: input.orgId, storeId: input.storeId, staffId: input.staffId },
        (client) => holdOrder(client, input),
      ),
    cancelOrder: (input: CancelOrderInput) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: input.orgId, storeId: input.storeId, staffId: input.staffId },
        (client) => cancelOrder(client, input),
      ),
  });
}

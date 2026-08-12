import type { SqlClient } from "../db/types.js";
import type { CustomerMergeInput, CustomerMergeResult } from "./types.js";

type CanonicalMergeRow = Readonly<{
  source_customer_id: string;
  target_customer_id: string;
  relinked_order_count: number | string;
}>;

function count(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("customer merge returned an invalid order count");
  }
  return parsed;
}

/**
 * Run the owner-defined canonical merge primitive inside the caller's bus
 * transaction. The function derives org/store/staff from transaction GUCs,
 * locks both recursive groups and relinks every org store atomically.
 */
export async function mergeCustomerRows(
  client: SqlClient,
  _orgId: string,
  input: CustomerMergeInput,
): Promise<CustomerMergeResult | null> {
  const result = await client.query<CanonicalMergeRow>(
    `SELECT source_customer_id::text, target_customer_id::text, relinked_order_count
       FROM customer_merge_canonical($1::uuid, $2::uuid, $3)`,
    [input.source_customer_id, input.target_customer_id, new Date(input.now * 1000)],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    source_customer_id: row.source_customer_id,
    target_customer_id: row.target_customer_id,
    relinked_order_count: count(row.relinked_order_count),
  });
}

import type { SqlClient } from "../db/types.js";
import type { CustomerMergeInput, CustomerMergeResult } from "./types.js";

type MergeCustomerRow = Readonly<{
  id: string;
  phone: string;
  name: string | null;
  merged_into_id: string | null;
  anonymized_at: Date | string | null;
}>;

type MemberAccountOwnerRow = Readonly<{
  id: string;
  customer_id: string;
}>;

function epochToDate(epoch: number): Date {
  return new Date(epoch * 1000);
}

/**
 * Merge two customers and apply ADR-17 §9 to their member accounts.
 *
 * The caller owns one transaction. Customer rows are the first lock anchor:
 * member.account.open takes FOR KEY SHARE on the same active row before an
 * insert, so an open either commits before these FOR UPDATE locks or observes
 * the merged source afterwards. Account locks then freeze the one-vs-two
 * decision until the relink and customer merge commit together.
 */
export async function mergeCustomerRows(
  client: SqlClient,
  orgId: string,
  input: CustomerMergeInput,
): Promise<CustomerMergeResult | null> {
  const result = await client.query<MergeCustomerRow>(
    `SELECT id, phone, name, merged_into_id, anonymized_at
       FROM customers
      WHERE org_id = $1::uuid AND id = ANY($2::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [orgId, [input.source_customer_id, input.target_customer_id]],
  );
  const source = result.rows.find((row) => row.id === input.source_customer_id);
  const target = result.rows.find((row) => row.id === input.target_customer_id);
  if (
    source === undefined ||
    target === undefined ||
    source.id === target.id ||
    source.merged_into_id !== null ||
    target.merged_into_id !== null ||
    source.anonymized_at != null ||
    target.anonymized_at != null
  ) {
    return null;
  }

  const memberAccounts = await client.query<MemberAccountOwnerRow>(
    `SELECT id, customer_id
       FROM member_accounts
      WHERE org_id = $1::uuid AND customer_id = ANY($2::uuid[])
      ORDER BY customer_id
      FOR UPDATE`,
    [orgId, [source.id, target.id]],
  );
  const sourceAccount = memberAccounts.rows.find((row) => row.customer_id === source.id);
  const targetAccount = memberAccounts.rows.find((row) => row.customer_id === target.id);
  if (sourceAccount !== undefined && targetAccount !== undefined) return null;

  if (sourceAccount !== undefined) {
    const moved = await client.query(
      `UPDATE member_accounts
          SET customer_id = $4::uuid
        WHERE org_id = $1::uuid AND id = $2::uuid
          AND customer_id = $3::uuid`,
      [orgId, sourceAccount.id, source.id, target.id],
    );
    if (moved.rowCount !== 1) throw new Error("member account customer relink lost its row lock");
  }

  const relinked = await client.query(
    `UPDATE orders
        SET customer_id = $4::uuid, customer_phone = $5,
            customer_name = COALESCE($6, customer_name), updated_at = $7
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND customer_id = $3::uuid
        AND customer_id <> $4::uuid`,
    [
      orgId,
      input.store_id,
      source.id,
      target.id,
      target.phone,
      target.name,
      epochToDate(input.now),
    ],
  );
  const merged = await client.query(
    `UPDATE customers
        SET merged_into_id = $3::uuid, merged_at = $4, updated_at = $4
      WHERE org_id = $1::uuid AND id = $2::uuid
        AND merged_into_id IS NULL AND anonymized_at IS NULL`,
    [orgId, source.id, target.id, epochToDate(input.now)],
  );
  if (merged.rowCount !== 1) throw new Error("customer merge lost its source row lock");

  return Object.freeze({
    source_customer_id: source.id,
    target_customer_id: target.id,
    relinked_order_count: relinked.rowCount ?? 0,
  });
}

import { cancellationInvariant } from "./cancellation-errors.js";
import { randomUUID } from "node:crypto";

import type { SqlClient, TenantContext } from "../db/types.js";
import type { MemberCancellationInput, MemberPaymentLinkInput } from "./cancellation-types.js";
import { insertMemberLedger, requireMemberInt } from "./pg-store-support.js";

/** Balance payment and cancellation acquire this before account -> order locks. */
export async function lockMemberOrder(
  client: SqlClient,
  tenant: TenantContext,
  orderId: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 83))", [
    `${tenant.orgId}:${tenant.storeId}:${orderId}`,
  ]);
}

/** Match customer.merge's account ordering; never acquire these after the order. */
export async function lockCancellationAccounts(
  client: SqlClient,
  tenant: TenantContext,
  orderId: string,
): Promise<void> {
  await lockMemberOrder(client, tenant, orderId);
  await client.query(
    `SELECT account.id FROM member_accounts account
     WHERE account.org_id = $1::uuid AND (
       account.customer_id IN (
         SELECT customer_id FROM orders
         WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
       ) OR account.id IN (
         SELECT account_id FROM member_ledger
         WHERE org_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid
       )
     ) ORDER BY account.customer_id, account.id FOR UPDATE`,
    [tenant.orgId, tenant.storeId, orderId],
  );
}

export async function linkPgMemberPayment(
  client: SqlClient,
  tenant: TenantContext,
  input: MemberPaymentLinkInput,
): Promise<void> {
  await client
    .query(
      `INSERT INTO member_payment_links (org_id, store_id, payment_id, ledger_id)
     SELECT $1::uuid, $2::uuid, $3::uuid, ledger.id FROM member_ledger ledger
     WHERE ledger.org_id = $1::uuid AND ledger.store_id = $2::uuid
       AND ledger.id = $4::uuid AND ledger.account_id = $5::uuid
       AND ledger.order_id = $6::uuid
       AND -(ledger.principal_delta_cents + ledger.bonus_delta_cents) = $7::bigint
     RETURNING ledger_id`,
      [
        tenant.orgId,
        input.store_id,
        input.payment_id,
        input.ledger_id,
        input.account_id,
        input.order_id,
        input.amount_cents,
      ],
    )
    .then((result) => {
      if (result.rows.length !== 1) cancellationInvariant("member_payment_unlinked");
    });
}

type SourceRow = Readonly<{
  ledger_id: string;
  account_id: string;
  status: string;
  principal: number | string;
  bonus: number | string;
  reversed: boolean;
}>;

export async function reversePgMemberOrderPayments(
  client: SqlClient,
  tenant: TenantContext,
  input: MemberCancellationInput,
  newId: () => string = randomUUID,
): Promise<void> {
  for (const payment of input.reversals.filter((row) => row.method === "balance")) {
    const found = await client.query<SourceRow>(
      `SELECT source.id AS ledger_id, source.account_id, account.status,
         source.principal_delta_cents AS principal, source.bonus_delta_cents AS bonus,
         EXISTS(SELECT 1 FROM member_ledger reversed
           WHERE reversed.org_id = source.org_id AND reversed.ref_ledger_id = source.id
             AND reversed.kind = 'reversal') AS reversed
       FROM member_payment_links link
       JOIN member_ledger source ON source.org_id = link.org_id AND source.id = link.ledger_id
       JOIN member_accounts account ON account.org_id = source.org_id AND account.id = source.account_id
       WHERE link.org_id = $1::uuid AND link.store_id = $2::uuid AND link.payment_id = $3::uuid
         AND source.order_id = $4::uuid AND source.kind = 'pay'`,
      [tenant.orgId, input.store_id, payment.ref_payment_id, input.order_id],
    );
    const source = found.rows[0];
    if (source === undefined || source.reversed) {
      cancellationInvariant("member_payment_unlinked");
    }
    if (source.status === "closed") {
      cancellationInvariant("member_account_closed");
    }
    const principal = -requireMemberInt(source.principal, "cancel principal");
    const bonus = -requireMemberInt(source.bonus, "cancel bonus");
    if (principal < 0 || bonus < 0 || principal + bonus !== payment.amount_cents) {
      cancellationInvariant("member_payment_unlinked");
    }
    // Frozen accounts receive their own funds without being unfrozen. A merge
    // retains the account ID, so its current canonical owner receives the credit.
    await insertMemberLedger(client, tenant, newId, source.account_id, {
      kind: "reversal",
      principal,
      bonus,
      orderId: input.order_id,
      refLedgerId: source.ledger_id,
      storeId: input.store_id,
      tender: null,
      bonusRuleId: null,
      staffId: input.staff_id,
      at: input.at,
      businessDate: input.business_date,
      note: input.reason,
    });
  }
}

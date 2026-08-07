import { planMemberLifecycle } from "@laundry/domain";

import type { SqlClient, TenantContext } from "../db/types.js";
import {
  ACCOUNT_SELECT,
  insertMemberLedger,
  lockMemberAccount,
  readMemberBalance,
  toAccount,
  type AccountRow,
} from "./pg-store-support.js";
import type {
  MemberAccountRecord,
  MemberCloseInput,
  MemberLifecycleResult,
  MemberOutcome,
  MemberRejectReason,
  MemberStatusTransitionInput,
  MemberStore,
} from "./types.js";

const reject = <T>(reason: MemberRejectReason): MemberOutcome<T> =>
  Object.freeze({ ok: false as const, reason });

function checkExpected(
  account: MemberAccountRecord,
  expectedCustomerId: string,
  expectedVersion: number,
): MemberRejectReason | null {
  if (account.customer_id !== expectedCustomerId) return "account_customer_mismatch";
  if (account.status_version !== expectedVersion) return "account_version_conflict";
  return null;
}

async function persistStatus(
  client: SqlClient,
  tenant: TenantContext,
  account: MemberAccountRecord,
  status: MemberAccountRecord["status"],
  input: Pick<
    MemberStatusTransitionInput,
    "expected_customer_id" | "expected_status_version" | "staff_id" | "store_id" | "at" | "reason"
  >,
): Promise<MemberAccountRecord> {
  const result = await client.query<AccountRow>(
    `UPDATE member_accounts
        SET status = $5,
            status_version = status_version + 1,
            status_changed_at = to_timestamp($6),
            status_reason = $7,
            status_changed_by_staff_id = $8::uuid,
            status_changed_store_id = $9::uuid
      WHERE org_id = $1::uuid AND id = $2::uuid
        AND customer_id = $3::uuid AND status_version = $4::integer
        AND status = $10
      RETURNING ${ACCOUNT_SELECT}`,
    [
      tenant.orgId,
      account.account_id,
      input.expected_customer_id,
      input.expected_status_version,
      status,
      input.at,
      input.reason,
      input.staff_id,
      input.store_id,
      account.status,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("member account status CAS failed under row lock");
  return toAccount(row);
}

export function createPgMemberLifecycleOperations(
  client: SqlClient,
  tenant: TenantContext,
  newId: () => string,
): Pick<MemberStore, "transitionStatus" | "close"> {
  return Object.freeze({
    transitionStatus: async (
      input: MemberStatusTransitionInput,
    ): Promise<MemberOutcome<MemberLifecycleResult>> => {
      const locked = await lockMemberAccount(client, tenant, input.account_id);
      if (!locked.ok) return locked;
      const mismatch = checkExpected(
        locked.value,
        input.expected_customer_id,
        input.expected_status_version,
      );
      if (mismatch !== null) return reject(mismatch);
      const balance = await readMemberBalance(client, tenant, input.account_id);
      const planned = planMemberLifecycle({
        action: input.action,
        current_status: locked.value.status,
        principal_cents: balance.principal_cents,
        bonus_cents: balance.bonus_cents,
      });
      if (!planned.ok) return reject(planned.reason);
      const account = await persistStatus(client, tenant, locked.value, planned.plan.status, input);
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({
          account,
          previous_status: planned.plan.previous_status,
          balance,
          refunded_principal_cents: 0,
          forfeited_bonus_cents: 0,
          refund_ledger_id: null,
          bonus_forfeit_ledger_id: null,
        }),
      });
    },

    close: async (input: MemberCloseInput): Promise<MemberOutcome<MemberLifecycleResult>> => {
      if (
        (input.expected_principal_cents === 0 && input.refund_tender !== null) ||
        (input.expected_principal_cents > 0 && input.refund_tender === null)
      ) {
        return reject("invalid_amount");
      }
      const locked = await lockMemberAccount(client, tenant, input.account_id);
      if (!locked.ok) return locked;
      const mismatch = checkExpected(
        locked.value,
        input.expected_customer_id,
        input.expected_status_version,
      );
      if (mismatch !== null) return reject(mismatch);
      const balance = await readMemberBalance(client, tenant, input.account_id);
      const planned = planMemberLifecycle({
        action: "close",
        current_status: locked.value.status,
        principal_cents: balance.principal_cents,
        bonus_cents: balance.bonus_cents,
        expected_status: input.expected_status,
        expected_principal_cents: input.expected_principal_cents,
        expected_bonus_cents: input.expected_bonus_cents,
      });
      if (!planned.ok) return reject(planned.reason);

      let refundLedgerId: string | null = null;
      let forfeitLedgerId: string | null = null;
      if (planned.plan.refunded_principal_cents > 0) {
        if (input.refund_tender === null) {
          throw new Error("member close principal refund requires a tender");
        }
        const refund = await insertMemberLedger(client, tenant, newId, input.account_id, {
          kind: "refund",
          principal: -planned.plan.refunded_principal_cents,
          bonus: 0,
          orderId: null,
          storeId: input.store_id,
          tender: input.refund_tender,
          bonusRuleId: null,
          staffId: input.staff_id,
          at: input.at,
          businessDate: input.business_date,
          note: input.reason,
        });
        refundLedgerId = refund.ledger_id;
      }
      if (planned.plan.forfeited_bonus_cents > 0) {
        const forfeiture = await insertMemberLedger(client, tenant, newId, input.account_id, {
          kind: "bonus_forfeit",
          principal: 0,
          bonus: -planned.plan.forfeited_bonus_cents,
          orderId: null,
          storeId: input.store_id,
          tender: null,
          bonusRuleId: null,
          staffId: input.staff_id,
          at: input.at,
          businessDate: input.business_date,
          note: input.reason,
        });
        forfeitLedgerId = forfeiture.ledger_id;
      }
      const finalBalance = await readMemberBalance(client, tenant, input.account_id);
      if (
        finalBalance.principal_cents !== 0 ||
        finalBalance.bonus_cents !== 0 ||
        finalBalance.total_cents !== 0
      ) {
        throw new Error("member close did not settle the balance to zero");
      }
      const account = await persistStatus(client, tenant, locked.value, "closed", input);
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({
          account,
          previous_status: planned.plan.previous_status,
          balance: finalBalance,
          refunded_principal_cents: planned.plan.refunded_principal_cents,
          forfeited_bonus_cents: planned.plan.forfeited_bonus_cents,
          refund_ledger_id: refundLedgerId,
          bonus_forfeit_ledger_id: forfeitLedgerId,
        }),
      });
    },
  });
}

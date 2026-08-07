import { planMemberLifecycle } from "@laundry/domain";

import type { MemberBalance } from "./balance.js";
import type {
  MemberAccountRecord,
  MemberCloseInput,
  MemberLedgerRow,
  MemberLifecycleResult,
  MemberOutcome,
  MemberRejectReason,
  MemberStatusTransitionInput,
  MemberStore,
} from "./types.js";

type MemoryLifecycleState = Readonly<{
  accounts: Map<string, MemberAccountRecord>;
  ledger: Map<string, MemberLedgerRow[]>;
  newId: () => string;
  balanceOf: (accountId: string) => MemberBalance;
}>;

const reject = <T>(reason: MemberRejectReason): MemberOutcome<T> =>
  Object.freeze({ ok: false as const, reason });

function expectedAccount(
  state: MemoryLifecycleState,
  accountId: string,
  expectedCustomerId: string,
  expectedVersion: number,
): MemberOutcome<MemberAccountRecord> {
  const account = state.accounts.get(accountId);
  if (account === undefined) return reject("account_not_found");
  if (account.customer_id !== expectedCustomerId) return reject("account_customer_mismatch");
  if (account.status_version !== expectedVersion) return reject("account_version_conflict");
  return Object.freeze({ ok: true as const, value: account });
}

function changeAccount(
  state: MemoryLifecycleState,
  account: MemberAccountRecord,
  status: MemberAccountRecord["status"],
  input: Pick<MemberStatusTransitionInput, "at" | "reason">,
): MemberAccountRecord {
  const nextVersion = account.status_version + 1;
  if (!Number.isSafeInteger(nextVersion) || nextVersion > 2_147_483_647) {
    throw new RangeError("member account status version overflowed");
  }
  const changed = Object.freeze({
    ...account,
    status,
    status_version: nextVersion,
    status_changed_at: input.at,
    status_reason: input.reason,
  });
  state.accounts.set(account.account_id, changed);
  return changed;
}

function closeRows(
  state: MemoryLifecycleState,
  input: MemberCloseInput,
  refundedPrincipal: number,
  forfeitedBonus: number,
): Readonly<{ refundId: string | null; forfeitId: string | null }> {
  const rows = state.ledger.get(input.account_id) ?? [];
  let refundId: string | null = null;
  let forfeitId: string | null = null;
  if (refundedPrincipal > 0) {
    if (input.refund_tender === null) {
      throw new Error("member close principal refund requires a tender");
    }
    refundId = state.newId();
    rows.push(
      Object.freeze({
        ledger_id: refundId,
        kind: "refund" as const,
        principal_delta_cents: -refundedPrincipal,
        bonus_delta_cents: 0,
        bonus_rule_id: null,
        order_id: null,
        store_id: input.store_id,
        tender: input.refund_tender,
        at: input.at,
        business_date: input.business_date,
        note: input.reason,
      }),
    );
  }
  if (forfeitedBonus > 0) {
    forfeitId = state.newId();
    rows.push(
      Object.freeze({
        ledger_id: forfeitId,
        kind: "bonus_forfeit" as const,
        principal_delta_cents: 0,
        bonus_delta_cents: -forfeitedBonus,
        bonus_rule_id: null,
        order_id: null,
        store_id: input.store_id,
        tender: null,
        at: input.at,
        business_date: input.business_date,
        note: input.reason,
      }),
    );
  }
  state.ledger.set(input.account_id, rows);
  return Object.freeze({ refundId, forfeitId });
}

export function createMemoryMemberLifecycleOperations(
  state: MemoryLifecycleState,
): Pick<MemberStore, "transitionStatus" | "close"> {
  return Object.freeze({
    transitionStatus: async (
      input: MemberStatusTransitionInput,
    ): Promise<MemberOutcome<MemberLifecycleResult>> => {
      const found = expectedAccount(
        state,
        input.account_id,
        input.expected_customer_id,
        input.expected_status_version,
      );
      if (!found.ok) return found;
      const balance = state.balanceOf(input.account_id);
      const planned = planMemberLifecycle({
        action: input.action,
        current_status: found.value.status,
        principal_cents: balance.principal_cents,
        bonus_cents: balance.bonus_cents,
      });
      if (!planned.ok) return reject(planned.reason);
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({
          account: changeAccount(state, found.value, planned.plan.status, input),
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
      const found = expectedAccount(
        state,
        input.account_id,
        input.expected_customer_id,
        input.expected_status_version,
      );
      if (!found.ok) return found;
      const balance = state.balanceOf(input.account_id);
      const planned = planMemberLifecycle({
        action: "close",
        current_status: found.value.status,
        principal_cents: balance.principal_cents,
        bonus_cents: balance.bonus_cents,
        expected_status: input.expected_status,
        expected_principal_cents: input.expected_principal_cents,
        expected_bonus_cents: input.expected_bonus_cents,
      });
      if (!planned.ok) return reject(planned.reason);
      const ids = closeRows(
        state,
        input,
        planned.plan.refunded_principal_cents,
        planned.plan.forfeited_bonus_cents,
      );
      const finalBalance = state.balanceOf(input.account_id);
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({
          account: changeAccount(state, found.value, "closed", input),
          previous_status: planned.plan.previous_status,
          balance: finalBalance,
          refunded_principal_cents: planned.plan.refunded_principal_cents,
          forfeited_bonus_cents: planned.plan.forfeited_bonus_cents,
          refund_ledger_id: ids.refundId,
          bonus_forfeit_ledger_id: ids.forfeitId,
        }),
      });
    },
  });
}

import { randomUUID } from "node:crypto";

import type {
  CustomerMemberAccountMergeOutcome,
  CustomerMemberAccountMergePort,
} from "../customer/types.js";
import { allocateSpend, projectBalance, type MemberBalance } from "./balance.js";
import { matchBonusRule, type BonusRule } from "./bonus.js";
import { createMemoryMemberLifecycleOperations } from "./memory-lifecycle.js";
import type {
  MemberAccountRecord,
  MemberAccountView,
  MemberBonusRuleRecord,
  MemberBonusRuleUpsertInput,
  MemberLedgerAppendResult,
  MemberLedgerRow,
  MemberOpenInput,
  MemberOpenResult,
  MemberOutcome,
  MemberRefundInput,
  MemberRejectReason,
  MemberSpendInput,
  MemberStore,
  MemberTopupInput,
} from "./types.js";

export type MemoryMemberSeed = Readonly<{
  /** Customers that exist; opening an account for anything else is refused. */
  customerIds: readonly string[];
  newId?: () => string;
}>;

export type MemoryMemberStore = MemberStore & CustomerMemberAccountMergePort;

const reject = <T>(reason: MemberRejectReason): MemberOutcome<T> =>
  Object.freeze({ ok: false as const, reason });

/**
 * In-memory member store for unit tests and the memory runtime.
 *
 * It mirrors the PostgreSQL store's *decisions* (idempotent open, no overdraw,
 * append-only ledger) but not its locking: a single-threaded map needs none.
 */
export function createMemoryMemberStore(seed: MemoryMemberSeed): MemoryMemberStore {
  const newId = seed.newId ?? randomUUID;
  const customers = new Set(seed.customerIds);
  const accounts = new Map<string, MemberAccountRecord>();
  const byCustomer = new Map<string, string>();
  const ledger = new Map<string, MemberLedgerRow[]>();
  const bonusRules = new Map<string, MemberBonusRuleRecord>();

  const activeBonusRules = (): readonly BonusRule[] =>
    [...bonusRules.values()]
      .filter((rule) => rule.status === "active")
      .map((rule) =>
        Object.freeze({
          rule_id: rule.rule_id,
          min_topup_cents: rule.min_topup_cents,
          bonus_cents: rule.bonus_cents,
        }),
      );

  const balanceOf = (accountId: string): MemberBalance =>
    projectBalance(ledger.get(accountId) ?? []);

  const append = (
    accountId: string,
    row: MemberLedgerRow,
  ): MemberOutcome<MemberLedgerAppendResult> => {
    const rows = ledger.get(accountId) ?? [];
    rows.push(row);
    ledger.set(accountId, rows);
    return Object.freeze({
      ok: true as const,
      value: Object.freeze({
        account_id: accountId,
        ledger_id: row.ledger_id,
        balance: balanceOf(accountId),
        principal_delta_cents: row.principal_delta_cents,
        bonus_delta_cents: row.bonus_delta_cents,
      }),
    });
  };

  const activeAccount = (accountId: string): MemberOutcome<MemberAccountRecord> => {
    const account = accounts.get(accountId);
    if (account === undefined) return reject("account_not_found");
    if (account.status === "frozen") return reject("account_frozen");
    if (account.status === "closed") return reject("account_closed");
    return Object.freeze({ ok: true as const, value: account });
  };

  const mergeCustomerMemberAccount = (
    sourceCustomerId: string,
    targetCustomerId: string,
  ): CustomerMemberAccountMergeOutcome => {
    const sourceAccountId = byCustomer.get(sourceCustomerId);
    const targetAccountId = byCustomer.get(targetCustomerId);
    if (sourceAccountId !== undefined && targetAccountId !== undefined) return "conflict";

    if (sourceAccountId !== undefined) {
      const sourceAccount = accounts.get(sourceAccountId);
      if (sourceAccount === undefined) {
        throw new Error("member customer index points to a missing account");
      }
      accounts.set(
        sourceAccountId,
        Object.freeze({ ...sourceAccount, customer_id: targetCustomerId }),
      );
      byCustomer.delete(sourceCustomerId);
      byCustomer.set(targetCustomerId, sourceAccountId);
    }
    customers.delete(sourceCustomerId);
    customers.add(targetCustomerId);
    return sourceAccountId === undefined ? "no_account" : "relinked";
  };

  return Object.freeze({
    mergeCustomerMemberAccount,
    openAccount: async (input: MemberOpenInput): Promise<MemberOutcome<MemberOpenResult>> => {
      if (!customers.has(input.customer_id)) return reject("customer_not_found");
      const existingId = byCustomer.get(input.customer_id);
      if (existingId !== undefined) {
        const existing = accounts.get(existingId);
        if (existing !== undefined) {
          return Object.freeze({
            ok: true as const,
            value: Object.freeze({ account: existing, created: false }),
          });
        }
      }
      const account: MemberAccountRecord = Object.freeze({
        account_id: newId(),
        customer_id: input.customer_id,
        status: "active" as const,
        status_version: 1,
        status_changed_at: null,
        status_reason: null,
        opened_at: input.at,
      });
      accounts.set(account.account_id, account);
      byCustomer.set(input.customer_id, account.account_id);
      ledger.set(account.account_id, []);
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({ account, created: true }),
      });
    },

    getByCustomer: async (customerId: string, limit: number): Promise<MemberAccountView | null> => {
      const accountId = byCustomer.get(customerId);
      if (accountId === undefined) return null;
      const account = accounts.get(accountId);
      if (account === undefined) return null;
      const rows = ledger.get(accountId) ?? [];
      const recent = rows.slice(Math.max(0, rows.length - limit)).reverse();
      return Object.freeze({
        account,
        balance: balanceOf(accountId),
        recent: Object.freeze(recent),
      });
    },

    getById: async (accountId: string, limit: number): Promise<MemberAccountView | null> => {
      const account = accounts.get(accountId);
      if (account === undefined) return null;
      const rows = ledger.get(accountId) ?? [];
      const recent = rows.slice(Math.max(0, rows.length - limit)).reverse();
      return Object.freeze({
        account,
        balance: balanceOf(accountId),
        recent: Object.freeze(recent),
      });
    },

    topup: async (input: MemberTopupInput): Promise<MemberOutcome<MemberLedgerAppendResult>> => {
      const found = activeAccount(input.account_id);
      if (!found.ok) return found as MemberOutcome<MemberLedgerAppendResult>;
      if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
        return reject("invalid_amount");
      }
      const bonus = input.frozen_bonus ?? matchBonusRule(activeBonusRules(), input.amount_cents);
      return append(
        input.account_id,
        Object.freeze({
          ledger_id: newId(),
          kind: "topup" as const,
          principal_delta_cents: input.amount_cents,
          // Server-side, never from the caller: a client-supplied bonus would
          // let a clerk pair any top-up with any grant (ADR-22 §3.1).
          bonus_delta_cents: bonus.bonus_cents,
          bonus_rule_id: bonus.rule_id,
          order_id: null,
          store_id: input.store_id,
          tender: input.tender,
          at: input.at,
          business_date: input.business_date,
          note: input.note,
        }),
      );
    },

    spend: async (input: MemberSpendInput): Promise<MemberOutcome<MemberLedgerAppendResult>> => {
      const found = activeAccount(input.account_id);
      if (!found.ok) return found as MemberOutcome<MemberLedgerAppendResult>;
      if (found.value.customer_id !== input.order_customer_id) {
        return reject("account_customer_mismatch");
      }
      const outcome = allocateSpend(balanceOf(input.account_id), input.amount_cents);
      if (!outcome.ok) return reject(outcome.reason);
      return append(
        input.account_id,
        Object.freeze({
          ledger_id: newId(),
          kind: "pay" as const,
          principal_delta_cents: outcome.allocation.principal_delta_cents,
          bonus_delta_cents: outcome.allocation.bonus_delta_cents,
          bonus_rule_id: null,
          order_id: input.order_id,
          store_id: input.store_id,
          // Spending stored value moves no cash (ADR-18 §1).
          tender: null,
          at: input.at,
          business_date: input.business_date,
          note: input.note,
        }),
      );
    },

    refund: async (input: MemberRefundInput): Promise<MemberOutcome<MemberLedgerAppendResult>> => {
      const found = activeAccount(input.account_id);
      if (!found.ok) return found as MemberOutcome<MemberLedgerAppendResult>;
      if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
        return reject("invalid_amount");
      }
      // Principal only, and only what is left of it: the bonus is not the
      // customer's money to withdraw (ADR-22 §4.1).
      if (input.amount_cents > balanceOf(input.account_id).principal_cents) {
        return reject("insufficient_balance");
      }
      return append(
        input.account_id,
        Object.freeze({
          ledger_id: newId(),
          kind: "refund" as const,
          principal_delta_cents: -input.amount_cents,
          bonus_delta_cents: 0,
          bonus_rule_id: null,
          order_id: null,
          store_id: input.store_id,
          tender: input.tender,
          at: input.at,
          business_date: input.business_date,
          note: input.note,
        }),
      );
    },

    ...createMemoryMemberLifecycleOperations({ accounts, ledger, newId, balanceOf }),

    upsertBonusRule: async (
      input: MemberBonusRuleUpsertInput,
    ): Promise<MemberOutcome<MemberBonusRuleRecord>> => {
      if (!Number.isSafeInteger(input.min_topup_cents) || input.min_topup_cents <= 0) {
        return reject("invalid_amount");
      }
      if (!Number.isSafeInteger(input.bonus_cents) || input.bonus_cents < 0) {
        return reject("invalid_amount");
      }
      if (input.rule_id !== null && !bonusRules.has(input.rule_id)) {
        return reject("bonus_rule_not_found");
      }
      const ruleId = input.rule_id ?? newId();
      const record = Object.freeze({
        rule_id: ruleId,
        min_topup_cents: input.min_topup_cents,
        bonus_cents: input.bonus_cents,
        status: input.status,
        updated_at: input.at,
        note: input.note,
      });
      bonusRules.set(ruleId, record);
      return Object.freeze({ ok: true as const, value: record });
    },

    listBonusRules: async (includeRetired: boolean): Promise<readonly MemberBonusRuleRecord[]> =>
      Object.freeze(
        [...bonusRules.values()]
          .filter((rule) => includeRetired || rule.status === "active")
          .sort((left, right) => right.min_topup_cents - left.min_topup_cents),
      ),

    sumCashPrincipal: async (storeId: string, businessDate: string): Promise<number> => {
      let total = 0;
      for (const rows of ledger.values()) {
        for (const row of rows) {
          if (row.tender !== "cash") continue;
          if (row.store_id !== storeId || row.business_date !== businessDate) continue;
          total += row.principal_delta_cents;
        }
      }
      return total;
    },
  });
}

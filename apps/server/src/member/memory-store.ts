import { randomUUID } from "node:crypto";

import { allocateSpend, projectBalance, type MemberBalance } from "./balance.js";
import type {
  MemberAccountRecord,
  MemberAccountView,
  MemberLedgerAppendResult,
  MemberLedgerRow,
  MemberOpenInput,
  MemberOpenResult,
  MemberOutcome,
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

const reject = <T>(reason: MemberRejectReason): MemberOutcome<T> =>
  Object.freeze({ ok: false as const, reason });

/**
 * In-memory member store for unit tests and the memory runtime.
 *
 * It mirrors the PostgreSQL store's *decisions* (idempotent open, no overdraw,
 * append-only ledger) but not its locking: a single-threaded map needs none.
 */
export function createMemoryMemberStore(seed: MemoryMemberSeed): MemberStore {
  const newId = seed.newId ?? randomUUID;
  const customers = new Set(seed.customerIds);
  const accounts = new Map<string, MemberAccountRecord>();
  const byCustomer = new Map<string, string>();
  const ledger = new Map<string, MemberLedgerRow[]>();

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
    if (account.status !== "active") return reject("account_frozen");
    return Object.freeze({ ok: true as const, value: account });
  };

  return Object.freeze({
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

    topup: async (input: MemberTopupInput): Promise<MemberOutcome<MemberLedgerAppendResult>> => {
      const found = activeAccount(input.account_id);
      if (!found.ok) return found as MemberOutcome<MemberLedgerAppendResult>;
      if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
        return reject("invalid_amount");
      }
      return append(
        input.account_id,
        Object.freeze({
          ledger_id: newId(),
          kind: "topup" as const,
          // First slice grants no bonus; the column exists so the split is
          // already correct when bonuses arrive (ADR-17 §5).
          principal_delta_cents: input.amount_cents,
          bonus_delta_cents: 0,
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
      const outcome = allocateSpend(balanceOf(input.account_id), input.amount_cents);
      if (!outcome.ok) return reject(outcome.reason);
      return append(
        input.account_id,
        Object.freeze({
          ledger_id: newId(),
          kind: "pay" as const,
          principal_delta_cents: outcome.allocation.principal_delta_cents,
          bonus_delta_cents: outcome.allocation.bonus_delta_cents,
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

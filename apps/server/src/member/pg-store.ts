import { randomUUID } from "node:crypto";

import { allocateSpend } from "./balance.js";
import { matchBonusRule } from "./bonus.js";
import { listBonusRules, readActiveBonusRules, upsertBonusRule } from "./pg-bonus-rules.js";
import { createPgMemberLifecycleOperations } from "./pg-lifecycle.js";
import {
  ACCOUNT_SELECT,
  insertMemberLedger,
  lockMemberAccount,
  readMemberBalance,
  requireMemberInt,
  toAccount,
  toLedgerRow,
  type AccountRow,
  type LedgerDbRow,
} from "./pg-store-support.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type {
  MemberAccountRecord,
  MemberAccountView,
  MemberBonusRuleUpsertInput,
  MemberLedgerAppendResult,
  MemberOpenInput,
  MemberOpenResult,
  MemberOutcome,
  MemberRefundInput,
  MemberRejectReason,
  MemberSpendInput,
  MemberStore,
  MemberTopupInput,
} from "./types.js";

export type CreatePgMemberStoreOptions = Readonly<{ newId?: () => string }>;

const reject = <T>(reason: MemberRejectReason): MemberOutcome<T> =>
  Object.freeze({ ok: false as const, reason });

/**
 * PostgreSQL member store.
 *
 * Every mutation runs inside the caller's transaction. The account row is the
 * lock anchor for the whole money path: `SELECT ... FOR UPDATE` first, re-sum
 * the ledger *under that lock*, then insert. Reading the balance before taking
 * the lock would let two concurrent spends both see enough money and overdraw.
 */
export function createPgMemberStore(
  client: SqlClient,
  tenant: TenantContext,
  options: CreatePgMemberStoreOptions = {},
): MemberStore {
  const newId = options.newId ?? randomUUID;

  const lockAccount = async (accountId: string): Promise<MemberOutcome<MemberAccountRecord>> => {
    const locked = await lockMemberAccount(client, tenant, accountId);
    if (!locked.ok) return locked;
    if (locked.value.status === "frozen") return reject("account_frozen");
    if (locked.value.status === "closed") return reject("account_closed");
    return locked;
  };

  return Object.freeze({
    openAccount: async (input: MemberOpenInput): Promise<MemberOutcome<MemberOpenResult>> => {
      // Stabilise the customer identity before looking for or inserting an
      // account. customer.merge takes FOR UPDATE on this row, so either the
      // open commits first (and merge sees its account) or the open observes a
      // merged/anonymized source and refuses it after waiting.
      const customer = await client.query(
        `SELECT 1
           FROM customers
          WHERE org_id = $1::uuid AND id = $2::uuid
            AND merged_into_id IS NULL AND anonymized_at IS NULL
          FOR KEY SHARE`,
        [tenant.orgId, input.customer_id],
      );
      if (customer.rows.length === 0) return reject("customer_not_found");

      const existing = await client.query<AccountRow>(
        `SELECT ${ACCOUNT_SELECT}
           FROM member_accounts
          WHERE org_id = $1::uuid AND customer_id = $2::uuid`,
        [tenant.orgId, input.customer_id],
      );
      const found = existing.rows[0];
      if (found !== undefined) {
        return Object.freeze({
          ok: true as const,
          value: Object.freeze({ account: toAccount(found), created: false }),
        });
      }

      const accountId = newId();
      // ON CONFLICT keeps open idempotent under a concurrent duplicate call;
      // the unique index on (org_id, customer_id) is what makes it safe.
      const inserted = await client.query<AccountRow>(
        `INSERT INTO member_accounts (id, org_id, customer_id, status, opened_at, opened_store_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', to_timestamp($4), $5::uuid)
         ON CONFLICT (org_id, customer_id) DO NOTHING
         RETURNING ${ACCOUNT_SELECT}`,
        [accountId, tenant.orgId, input.customer_id, input.at, input.store_id],
      );
      const row = inserted.rows[0];
      if (row !== undefined) {
        return Object.freeze({
          ok: true as const,
          value: Object.freeze({ account: toAccount(row), created: true }),
        });
      }
      const raced = await client.query<AccountRow>(
        `SELECT ${ACCOUNT_SELECT}
           FROM member_accounts
          WHERE org_id = $1::uuid AND customer_id = $2::uuid`,
        [tenant.orgId, input.customer_id],
      );
      const rowAfterRace = raced.rows[0];
      if (rowAfterRace === undefined) return reject("account_not_found");
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({ account: toAccount(rowAfterRace), created: false }),
      });
    },

    getByCustomer: async (customerId: string, limit: number): Promise<MemberAccountView | null> => {
      const accountResult = await client.query<AccountRow>(
        `SELECT ${ACCOUNT_SELECT}
           FROM member_accounts
          WHERE org_id = $1::uuid AND customer_id = $2::uuid`,
        [tenant.orgId, customerId],
      );
      const accountRow = accountResult.rows[0];
      if (accountRow === undefined) return null;
      const account = toAccount(accountRow);
      const rows = await client.query<LedgerDbRow>(
        `SELECT id, kind, principal_delta_cents, bonus_delta_cents, order_id,
                store_id, tender, bonus_rule_id, at, business_date, note
           FROM member_ledger
          WHERE org_id = $1::uuid AND account_id = $2::uuid
          ORDER BY ledger_seq DESC
          LIMIT $3`,
        [tenant.orgId, account.account_id, limit],
      );
      return Object.freeze({
        account,
        balance: await readMemberBalance(client, tenant, account.account_id),
        recent: Object.freeze(rows.rows.map(toLedgerRow)),
      });
    },

    topup: async (input: MemberTopupInput): Promise<MemberOutcome<MemberLedgerAppendResult>> => {
      if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
        return reject("invalid_amount");
      }
      const locked = await lockAccount(input.account_id);
      if (!locked.ok) return locked as MemberOutcome<MemberLedgerAppendResult>;
      // A normal direct store call resolves the current tier under the account
      // lock. A confirmed command instead supplies the hash-bound first-hop
      // snapshot so the ledger exactly matches what the operator approved.
      const bonus =
        input.frozen_bonus ??
        matchBonusRule(await readActiveBonusRules(client, tenant), input.amount_cents);
      const appended = await insertMemberLedger(client, tenant, newId, input.account_id, {
        kind: "topup",
        principal: input.amount_cents,
        bonus: bonus.bonus_cents,
        orderId: null,
        storeId: input.store_id,
        tender: input.tender,
        bonusRuleId: bonus.rule_id,
        staffId: input.staff_id,
        at: input.at,
        businessDate: input.business_date,
        note: input.note,
      });
      return Object.freeze({ ok: true as const, value: appended });
    },

    spend: async (input: MemberSpendInput): Promise<MemberOutcome<MemberLedgerAppendResult>> => {
      const locked = await lockAccount(input.account_id);
      if (!locked.ok) return locked as MemberOutcome<MemberLedgerAppendResult>;
      // Re-read under the lock: a balance fetched before FOR UPDATE would let
      // two concurrent spends both pass the sufficiency check.
      const balance = await readMemberBalance(client, tenant, input.account_id);
      const outcome = allocateSpend(balance, input.amount_cents);
      if (!outcome.ok) return reject(outcome.reason);
      const appended = await insertMemberLedger(client, tenant, newId, input.account_id, {
        kind: "pay",
        principal: outcome.allocation.principal_delta_cents,
        bonus: outcome.allocation.bonus_delta_cents,
        orderId: input.order_id,
        storeId: input.store_id,
        // Spending stored value moves no cash (ADR-18 §1).
        tender: null,
        bonusRuleId: null,
        staffId: input.staff_id,
        at: input.at,
        businessDate: input.business_date,
        note: input.note,
      });
      return Object.freeze({ ok: true as const, value: appended });
    },

    refund: async (input: MemberRefundInput): Promise<MemberOutcome<MemberLedgerAppendResult>> => {
      if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
        return reject("invalid_amount");
      }
      const locked = await lockAccount(input.account_id);
      if (!locked.ok) return locked as MemberOutcome<MemberLedgerAppendResult>;
      // Re-read under the lock, exactly as spend does: a principal read before
      // FOR UPDATE would let two concurrent refunds both pass the check.
      const balance = await readMemberBalance(client, tenant, input.account_id);
      // Principal only — the bonus is not the customer's money (ADR-22 §4.1).
      if (input.amount_cents > balance.principal_cents) return reject("insufficient_balance");
      const appended = await insertMemberLedger(client, tenant, newId, input.account_id, {
        kind: "refund",
        principal: -input.amount_cents,
        bonus: 0,
        orderId: null,
        storeId: input.store_id,
        tender: input.tender,
        bonusRuleId: null,
        staffId: input.staff_id,
        at: input.at,
        businessDate: input.business_date,
        note: input.note,
      });
      return Object.freeze({ ok: true as const, value: appended });
    },

    ...createPgMemberLifecycleOperations(client, tenant, newId),

    upsertBonusRule: async (input: MemberBonusRuleUpsertInput) =>
      upsertBonusRule(client, tenant, newId, input),

    listBonusRules: async (includeRetired: boolean) =>
      listBonusRules(client, tenant, includeRetired),

    sumCashPrincipal: async (storeId: string, businessDate: string): Promise<number> => {
      const rows = await client.query<Readonly<{ cash_cents: number | string }>>(
        `SELECT COALESCE(SUM(principal_delta_cents), 0)::bigint AS cash_cents
           FROM member_ledger
          WHERE org_id = $1::uuid AND store_id = $2::uuid
            AND business_date = $3 AND tender = 'cash'`,
        [tenant.orgId, storeId, businessDate],
      );
      return requireMemberInt(rows.rows[0]?.cash_cents ?? 0, "cash principal sum");
    },
  });
}

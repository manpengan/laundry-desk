import { randomUUID } from "node:crypto";

import { allocateSpend, projectBalance, type LedgerDelta } from "./balance.js";
import { matchBonusRule } from "./bonus.js";
import { listBonusRules, readActiveBonusRules, upsertBonusRule } from "./pg-bonus-rules.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type {
  MemberAccountRecord,
  MemberAccountView,
  MemberBonusRuleUpsertInput,
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

export type CreatePgMemberStoreOptions = Readonly<{ newId?: () => string }>;

type AccountRow = Readonly<{
  id: string;
  customer_id: string;
  status: string;
  opened_at: Date | string;
}>;

type LedgerDbRow = Readonly<{
  id: string;
  kind: string;
  principal_delta_cents: number | string;
  bonus_delta_cents: number | string;
  order_id: string | null;
  store_id: string;
  tender: string | null;
  bonus_rule_id: string | null;
  at: Date | string;
  business_date: string;
  note: string | null;
}>;

const reject = <T>(reason: MemberRejectReason): MemberOutcome<T> =>
  Object.freeze({ ok: false as const, reason });

const toEpoch = (value: Date | string): number =>
  Math.floor((value instanceof Date ? value.getTime() : new Date(value).getTime()) / 1000);

function requireInt(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`member ledger ${label} is not a safe integer`);
  }
  return parsed;
}

const TENDERS: ReadonlySet<string> = new Set(["cash", "wechat", "alipay", "other"]);

/**
 * Refuse an unknown tender rather than coercing it to null.
 *
 * Null means "no cash moved"; silently mapping an unrecognised value to it would
 * drop real money out of the day's cash instead of failing loudly.
 */
function toTender(value: string | null): MemberLedgerRow["tender"] {
  if (value === null) return null;
  if (!TENDERS.has(value)) throw new Error(`member ledger tender is not recognised: ${value}`);
  return value as MemberLedgerRow["tender"];
}

function toLedgerRow(row: LedgerDbRow): MemberLedgerRow {
  return Object.freeze({
    ledger_id: row.id,
    kind: row.kind as MemberLedgerRow["kind"],
    principal_delta_cents: requireInt(row.principal_delta_cents, "principal_delta_cents"),
    bonus_delta_cents: requireInt(row.bonus_delta_cents, "bonus_delta_cents"),
    order_id: row.order_id,
    store_id: row.store_id,
    tender: toTender(row.tender),
    bonus_rule_id: row.bonus_rule_id,
    at: toEpoch(row.at),
    business_date: row.business_date,
    note: row.note,
  });
}

function toAccount(row: AccountRow): MemberAccountRecord {
  return Object.freeze({
    account_id: row.id,
    customer_id: row.customer_id,
    status: row.status === "frozen" ? ("frozen" as const) : ("active" as const),
    opened_at: toEpoch(row.opened_at),
  });
}

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
    const locked = await client.query<AccountRow>(
      `SELECT id, customer_id, status, opened_at
         FROM member_accounts
        WHERE org_id = $1::uuid AND id = $2::uuid
        FOR UPDATE`,
      [tenant.orgId, accountId],
    );
    const row = locked.rows[0];
    if (row === undefined) return reject("account_not_found");
    const account = toAccount(row);
    if (account.status !== "active") return reject("account_frozen");
    return Object.freeze({ ok: true as const, value: account });
  };

  /** Must run while the account row is locked. */
  const sumLedger = async (accountId: string): Promise<readonly LedgerDelta[]> => {
    const rows = await client.query<Readonly<{ p: number | string; b: number | string }>>(
      `SELECT principal_delta_cents AS p, bonus_delta_cents AS b
         FROM member_ledger
        WHERE org_id = $1::uuid AND account_id = $2::uuid`,
      [tenant.orgId, accountId],
    );
    return rows.rows.map((row) =>
      Object.freeze({
        principal_delta_cents: requireInt(row.p, "principal_delta_cents"),
        bonus_delta_cents: requireInt(row.b, "bonus_delta_cents"),
      }),
    );
  };

  const insertLedger = async (
    accountId: string,
    values: Readonly<{
      kind: "topup" | "pay";
      principal: number;
      bonus: number;
      orderId: string | null;
      storeId: string;
      tender: MemberLedgerRow["tender"];
      bonusRuleId: string | null;
      staffId: string;
      at: number;
      businessDate: string;
      note: string | null;
    }>,
  ): Promise<MemberLedgerAppendResult> => {
    const ledgerId = newId();
    await client.query(
      `INSERT INTO member_ledger (
         id, org_id, store_id, account_id, kind,
         principal_delta_cents, bonus_delta_cents, order_id, tender, bonus_rule_id,
         staff_id, at, business_date, note
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
         $6::integer, $7::integer, $8::uuid, $9, $10::uuid,
         $11::uuid, to_timestamp($12), $13, $14
       )`,
      [
        ledgerId,
        tenant.orgId,
        values.storeId,
        accountId,
        values.kind,
        values.principal,
        values.bonus,
        values.orderId,
        values.tender,
        values.bonusRuleId,
        values.staffId,
        values.at,
        values.businessDate,
        values.note,
      ],
    );
    return Object.freeze({
      account_id: accountId,
      ledger_id: ledgerId,
      balance: projectBalance(await sumLedger(accountId)),
      principal_delta_cents: values.principal,
      bonus_delta_cents: values.bonus,
    });
  };

  return Object.freeze({
    openAccount: async (input: MemberOpenInput): Promise<MemberOutcome<MemberOpenResult>> => {
      const existing = await client.query<AccountRow>(
        `SELECT id, customer_id, status, opened_at
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
      const customer = await client.query(
        `SELECT 1 FROM customers WHERE org_id = $1::uuid AND id = $2::uuid`,
        [tenant.orgId, input.customer_id],
      );
      if (customer.rows.length === 0) return reject("customer_not_found");

      const accountId = newId();
      // ON CONFLICT keeps open idempotent under a concurrent duplicate call;
      // the unique index on (org_id, customer_id) is what makes it safe.
      const inserted = await client.query<AccountRow>(
        `INSERT INTO member_accounts (id, org_id, customer_id, status, opened_at, opened_store_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', to_timestamp($4), $5::uuid)
         ON CONFLICT (org_id, customer_id) DO NOTHING
         RETURNING id, customer_id, status, opened_at`,
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
        `SELECT id, customer_id, status, opened_at
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
        `SELECT id, customer_id, status, opened_at
           FROM member_accounts
          WHERE org_id = $1::uuid AND customer_id = $2::uuid`,
        [tenant.orgId, customerId],
      );
      const accountRow = accountResult.rows[0];
      if (accountRow === undefined) return null;
      const account = toAccount(accountRow);
      const rows = await client.query<LedgerDbRow>(
        `SELECT id, kind, principal_delta_cents, bonus_delta_cents, order_id,
                store_id, at, business_date, note
           FROM member_ledger
          WHERE org_id = $1::uuid AND account_id = $2::uuid
          ORDER BY ledger_seq DESC
          LIMIT $3`,
        [tenant.orgId, account.account_id, limit],
      );
      return Object.freeze({
        account,
        balance: projectBalance(await sumLedger(account.account_id)),
        recent: Object.freeze(rows.rows.map(toLedgerRow)),
      });
    },

    topup: async (input: MemberTopupInput): Promise<MemberOutcome<MemberLedgerAppendResult>> => {
      if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
        return reject("invalid_amount");
      }
      const locked = await lockAccount(input.account_id);
      if (!locked.ok) return locked as MemberOutcome<MemberLedgerAppendResult>;
      // Read the tiers inside the same transaction, after the account lock: a
      // rule edited between an earlier read and this insert would otherwise be
      // snapshotted stale, granting a bonus nobody had configured (ADR-22 §3.3).
      const bonus = matchBonusRule(await readActiveBonusRules(client, tenant), input.amount_cents);
      const appended = await insertLedger(input.account_id, {
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
      const balance = projectBalance(await sumLedger(input.account_id));
      const outcome = allocateSpend(balance, input.amount_cents);
      if (!outcome.ok) return reject(outcome.reason);
      const appended = await insertLedger(input.account_id, {
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
      return requireInt(rows.rows[0]?.cash_cents ?? 0, "cash_cents");
    },
  });
}

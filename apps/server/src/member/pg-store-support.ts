import { projectBalance, type LedgerDelta, type MemberBalance } from "./balance.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type {
  MemberAccountRecord,
  MemberLedgerAppendResult,
  MemberLedgerKind,
  MemberLedgerRow,
  MemberOutcome,
  MemberRejectReason,
} from "./types.js";

export type AccountRow = Readonly<{
  id: string;
  customer_id: string;
  status: string;
  status_version: number | string;
  status_changed_at: Date | string | null;
  status_reason: string | null;
  opened_at: Date | string;
}>;

export type LedgerDbRow = Readonly<{
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

export type InsertLedgerValues = Readonly<{
  kind: "topup" | "pay" | "refund" | "bonus_forfeit";
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
}>;

export const ACCOUNT_SELECT =
  "id, customer_id, status, status_version, status_changed_at, status_reason, opened_at";

const reject = <T>(reason: MemberRejectReason): MemberOutcome<T> =>
  Object.freeze({ ok: false as const, reason });

export function requireMemberInt(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`member ${label} is not a safe integer`);
  return parsed;
}

function toEpoch(value: Date | string, label: string): number {
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error(`member ${label} is not a timestamp`);
  return Math.floor(milliseconds / 1000);
}

const LEDGER_KINDS: ReadonlySet<string> = new Set([
  "topup",
  "pay",
  "reversal",
  "refund",
  "bonus_forfeit",
]);
const TENDERS: ReadonlySet<string> = new Set(["cash", "wechat", "alipay", "other"]);

function toLedgerKind(value: string): MemberLedgerKind {
  if (!LEDGER_KINDS.has(value)) throw new Error(`member ledger kind is not recognised: ${value}`);
  return value as MemberLedgerKind;
}

function toTender(value: string | null): MemberLedgerRow["tender"] {
  if (value === null) return null;
  if (!TENDERS.has(value)) throw new Error(`member ledger tender is not recognised: ${value}`);
  return value as MemberLedgerRow["tender"];
}

export function toLedgerRow(row: LedgerDbRow): MemberLedgerRow {
  return Object.freeze({
    ledger_id: row.id,
    kind: toLedgerKind(row.kind),
    principal_delta_cents: requireMemberInt(row.principal_delta_cents, "principal delta"),
    bonus_delta_cents: requireMemberInt(row.bonus_delta_cents, "bonus delta"),
    order_id: row.order_id,
    store_id: row.store_id,
    tender: toTender(row.tender),
    bonus_rule_id: row.bonus_rule_id,
    at: toEpoch(row.at, "ledger timestamp"),
    business_date: row.business_date,
    note: row.note,
  });
}

export function toAccount(row: AccountRow): MemberAccountRecord {
  if (row.status !== "active" && row.status !== "frozen" && row.status !== "closed") {
    throw new Error(`member account status is not recognised: ${row.status}`);
  }
  const version = requireMemberInt(row.status_version, "account status version");
  if (version <= 0) throw new Error("member account status version is not positive");
  if ((row.status_changed_at === null) !== (row.status_reason === null)) {
    throw new Error("member account status evidence is incomplete");
  }
  return Object.freeze({
    account_id: row.id,
    customer_id: row.customer_id,
    status: row.status,
    status_version: version,
    status_changed_at:
      row.status_changed_at === null
        ? null
        : toEpoch(row.status_changed_at, "status changed timestamp"),
    status_reason: row.status_reason,
    opened_at: toEpoch(row.opened_at, "opened timestamp"),
  });
}

export async function lockMemberAccount(
  client: SqlClient,
  tenant: TenantContext,
  accountId: string,
): Promise<MemberOutcome<MemberAccountRecord>> {
  const result = await client.query<AccountRow>(
    `SELECT ${ACCOUNT_SELECT}
       FROM member_accounts
      WHERE org_id = $1::uuid AND id = $2::uuid
      FOR UPDATE`,
    [tenant.orgId, accountId],
  );
  const row = result.rows[0];
  return row === undefined
    ? reject("account_not_found")
    : Object.freeze({ ok: true as const, value: toAccount(row) });
}

export async function readMemberLedgerDeltas(
  client: SqlClient,
  tenant: TenantContext,
  accountId: string,
): Promise<readonly LedgerDelta[]> {
  const rows = await client.query<Readonly<{ p: number | string; b: number | string }>>(
    `SELECT principal_delta_cents AS p, bonus_delta_cents AS b
       FROM member_ledger
      WHERE org_id = $1::uuid AND account_id = $2::uuid`,
    [tenant.orgId, accountId],
  );
  return rows.rows.map((row) =>
    Object.freeze({
      principal_delta_cents: requireMemberInt(row.p, "ledger principal delta"),
      bonus_delta_cents: requireMemberInt(row.b, "ledger bonus delta"),
    }),
  );
}

export async function readMemberBalance(
  client: SqlClient,
  tenant: TenantContext,
  accountId: string,
): Promise<MemberBalance> {
  return projectBalance(await readMemberLedgerDeltas(client, tenant, accountId));
}

export async function insertMemberLedger(
  client: SqlClient,
  tenant: TenantContext,
  newId: () => string,
  accountId: string,
  values: InsertLedgerValues,
): Promise<MemberLedgerAppendResult> {
  const ledgerId = newId();
  await client.query(
    `INSERT INTO member_ledger (
       id, org_id, store_id, account_id, kind,
       principal_delta_cents, bonus_delta_cents, order_id, tender, bonus_rule_id,
       staff_id, at, business_date, note
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
       $6::bigint, $7::bigint, $8::uuid, $9, $10::uuid,
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
    balance: await readMemberBalance(client, tenant, accountId),
    principal_delta_cents: values.principal,
    bonus_delta_cents: values.bonus,
  });
}

import type { SqlClient, TenantContext } from "../db/types.js";
import type { MemberAccountStatus } from "../member/types.js";
import type { MemberBenefitOutcome, MemberBenefitRejectReason } from "./types.js";

export type BenefitAccount = Readonly<{
  account_id: string;
  customer_id: string;
  status: MemberAccountStatus;
}>;

type AccountRow = Readonly<{ id: string; customer_id: string; status: string }>;

export const rejectPgBenefit = <TValue>(
  reason: MemberBenefitRejectReason,
): MemberBenefitOutcome<TValue> => Object.freeze({ ok: false as const, reason });

function toBenefitAccount(row: AccountRow): BenefitAccount {
  if (row.status !== "active" && row.status !== "frozen" && row.status !== "closed") {
    throw new Error(`Unknown member account status: ${row.status}`);
  }
  return Object.freeze({
    account_id: row.id,
    customer_id: row.customer_id,
    status: row.status,
  });
}

export async function readBenefitAccountByCustomer(
  client: SqlClient,
  tenant: TenantContext,
  customerId: string,
): Promise<BenefitAccount | null> {
  const result = await client.query<AccountRow>(
    `SELECT id::text, customer_id::text, status
       FROM member_accounts
      WHERE org_id = $1::uuid AND customer_id = $2::uuid`,
    [tenant.orgId, customerId],
  );
  return result.rows[0] === undefined ? null : toBenefitAccount(result.rows[0]);
}

export async function lockActiveBenefitAccount(
  client: SqlClient,
  tenant: TenantContext,
  accountId: string,
): Promise<MemberBenefitOutcome<BenefitAccount>> {
  const result = await client.query<AccountRow>(
    `SELECT id::text, customer_id::text, status
       FROM member_accounts
      WHERE org_id = $1::uuid AND id = $2::uuid
      FOR UPDATE`,
    [tenant.orgId, accountId],
  );
  const row = result.rows[0];
  if (row === undefined) return rejectPgBenefit("account_not_found");
  const account = toBenefitAccount(row);
  if (account.status === "frozen") return rejectPgBenefit("account_frozen");
  if (account.status === "closed") return rejectPgBenefit("account_closed");
  return Object.freeze({ ok: true as const, value: account });
}

export function benefitInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is not a safe integer`);
  return parsed;
}

export function benefitDate(value: Date | string, label: string): string {
  const rendered = value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(rendered)) throw new Error(`${label} is not a date`);
  return rendered;
}

export function benefitEpoch(value: Date | string, label: string): number {
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is not a timestamp`);
  return Math.floor(milliseconds / 1000);
}

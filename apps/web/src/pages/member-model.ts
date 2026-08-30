/** View models for the member stored-value panel. All money is integer fen. */

import { formatFenToYuan, parseYuanToFen } from "@laundry/ui";

export const MEMBER_ACCOUNT_STATUSES = Object.freeze(["active", "frozen", "closed"] as const);
export type MemberAccountStatusView = (typeof MEMBER_ACCOUNT_STATUSES)[number];

export const MEMBER_LEDGER_KINDS = Object.freeze([
  "topup",
  "pay",
  "reversal",
  "refund",
  "bonus_forfeit",
] as const);
export type MemberLedgerKindView = (typeof MEMBER_LEDGER_KINDS)[number];

export const MEMBER_TENDERS = Object.freeze(["cash", "wechat", "alipay", "other"] as const);
export type MemberTenderView = (typeof MEMBER_TENDERS)[number];

export type MemberLedgerRowView = Readonly<{
  ledger_id: string;
  kind: MemberLedgerKindView;
  principal_delta_cents: number;
  bonus_delta_cents: number;
  order_id: string | null;
  store_id: string;
  tender: MemberTenderView | null;
  bonus_rule_id: string | null;
  at: number;
  business_date: string;
  note: string | null;
}>;

export type MemberAccountSummary = Readonly<{
  account_id: string;
  customer_id: string;
  status: MemberAccountStatusView;
  status_version: number;
  status_changed_at: number | null;
  status_reason: string | null;
  principal_cents: number;
  bonus_cents: number;
  balance_cents: number;
}>;

export type MemberAccountView = Readonly<{
  account: MemberAccountSummary | null;
  recent: readonly MemberLedgerRowView[];
}>;

export type MemberBonusRuleView = Readonly<{
  rule_id: string;
  min_topup_cents: number;
  bonus_cents: number;
  status: "active" | "retired";
  note: string | null;
}>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

const intOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);

function isBusinessDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function nullableUuid(value: unknown): value is string | null {
  return value === null || isUuid(value);
}

function hasValidLedgerShape(
  input: Readonly<{
    kind: MemberLedgerKindView;
    principal: number;
    bonus: number;
    orderId: string | null;
    tender: MemberTenderView | null;
    bonusRuleId: string | null;
  }>,
): boolean {
  if (input.kind === "topup") {
    return (
      input.principal >= 0 &&
      input.bonus >= 0 &&
      input.principal + input.bonus > 0 &&
      input.orderId === null &&
      input.tender !== null
    );
  }
  if (input.kind === "pay") {
    return (
      input.principal <= 0 &&
      input.bonus <= 0 &&
      input.principal + input.bonus < 0 &&
      input.orderId !== null &&
      input.tender === null &&
      input.bonusRuleId === null
    );
  }
  if (input.kind === "refund") {
    return (
      input.principal < 0 &&
      input.bonus === 0 &&
      input.orderId === null &&
      input.tender !== null &&
      input.bonusRuleId === null
    );
  }
  if (input.kind === "bonus_forfeit") {
    return (
      input.principal === 0 &&
      input.bonus < 0 &&
      input.orderId === null &&
      input.tender === null &&
      input.bonusRuleId === null
    );
  }
  return input.bonusRuleId === null;
}

function parseRow(value: unknown): MemberLedgerRowView | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "ledger_id",
      "kind",
      "principal_delta_cents",
      "bonus_delta_cents",
      "order_id",
      "store_id",
      "tender",
      "bonus_rule_id",
      "at",
      "business_date",
      "note",
    ])
  ) {
    return null;
  }
  const principal = intOrNull(value.principal_delta_cents);
  const bonus = intOrNull(value.bonus_delta_cents);
  const at = intOrNull(value.at);
  if (
    !isUuid(value.ledger_id) ||
    typeof value.kind !== "string" ||
    !MEMBER_LEDGER_KINDS.includes(value.kind as MemberLedgerKindView) ||
    !nullableUuid(value.order_id) ||
    !isUuid(value.store_id) ||
    (value.tender !== null &&
      (typeof value.tender !== "string" ||
        !MEMBER_TENDERS.includes(value.tender as MemberTenderView))) ||
    !nullableUuid(value.bonus_rule_id) ||
    at === null ||
    at <= 0 ||
    !isBusinessDate(value.business_date) ||
    (value.note !== null && (typeof value.note !== "string" || value.note.length > 256)) ||
    principal === null ||
    bonus === null
  ) {
    return null;
  }
  const kind = value.kind as MemberLedgerKindView;
  const tender = value.tender as MemberTenderView | null;
  if (!Number.isSafeInteger(principal + bonus)) return null;
  if (
    !hasValidLedgerShape({
      kind,
      principal,
      bonus,
      orderId: value.order_id,
      tender,
      bonusRuleId: value.bonus_rule_id,
    })
  ) {
    return null;
  }
  return Object.freeze({
    ledger_id: value.ledger_id,
    kind,
    principal_delta_cents: principal,
    bonus_delta_cents: bonus,
    order_id: value.order_id,
    store_id: value.store_id,
    tender,
    bonus_rule_id: value.bonus_rule_id,
    at,
    business_date: value.business_date,
    note: value.note,
  });
}

/**
 * Parse the `member.account.get` payload.
 *
 * Returns null on anything unexpected rather than a half-filled view: showing a
 * plausible-but-wrong balance is worse than showing nothing.
 */
export function parseMemberAccountView(
  value: unknown,
  expectedCustomerId: string,
): MemberAccountView | null {
  if (
    !isUuid(expectedCustomerId) ||
    !isRecord(value) ||
    !hasExactKeys(value, ["account", "recent"]) ||
    !Array.isArray(value.recent) ||
    value.recent.length > 50
  ) {
    return null;
  }
  const rawRows = value.recent;
  const rows = rawRows.map(parseRow);
  if (
    rows.some((row) => row === null) ||
    new Set(rows.map((row) => row?.ledger_id)).size !== rows.length
  ) {
    return null;
  }
  const recent = Object.freeze(rows as readonly MemberLedgerRowView[]);

  if (value.account === null) {
    if (recent.length !== 0) return null;
    return Object.freeze({ account: null, recent });
  }
  const account = value.account;
  if (
    !isRecord(account) ||
    !hasExactKeys(account, [
      "account_id",
      "customer_id",
      "status",
      "status_version",
      "status_changed_at",
      "status_reason",
      "principal_cents",
      "bonus_cents",
      "balance_cents",
    ])
  ) {
    return null;
  }
  const principal = intOrNull(account.principal_cents);
  const bonus = intOrNull(account.bonus_cents);
  const balance = intOrNull(account.balance_cents);
  const statusVersion = intOrNull(account.status_version);
  const statusChangedAt =
    account.status_changed_at === null ? null : intOrNull(account.status_changed_at);
  if (
    !isUuid(account.account_id) ||
    !isUuid(account.customer_id) ||
    account.customer_id !== expectedCustomerId ||
    typeof account.status !== "string" ||
    !MEMBER_ACCOUNT_STATUSES.includes(account.status as MemberAccountStatusView) ||
    statusVersion === null ||
    statusVersion <= 0 ||
    (account.status_changed_at !== null && statusChangedAt === null) ||
    (statusChangedAt !== null && statusChangedAt <= 0) ||
    (statusChangedAt === null) !== (account.status_reason === null) ||
    (account.status_reason !== null &&
      (typeof account.status_reason !== "string" ||
        account.status_reason.trim().length === 0 ||
        account.status_reason.length > 256)) ||
    principal === null ||
    principal < 0 ||
    bonus === null ||
    bonus < 0 ||
    balance === null ||
    balance < 0
  ) {
    return null;
  }
  // The server sums the ledger; if the parts do not add up, the payload is not
  // one this panel should render.
  const projectedBalance = principal + bonus;
  if (!Number.isSafeInteger(projectedBalance) || projectedBalance !== balance) return null;
  if (account.status === "closed" && balance !== 0) return null;
  return Object.freeze({
    account: Object.freeze({
      account_id: account.account_id,
      customer_id: account.customer_id,
      status: account.status as MemberAccountStatusView,
      status_version: statusVersion,
      status_changed_at: statusChangedAt,
      status_reason: account.status_reason,
      principal_cents: principal,
      bonus_cents: bonus,
      balance_cents: balance,
    }),
    recent,
  });
}

/**
 * Convert a yuan string to integer fen.
 *
 * Parsed digit-wise instead of `Number(text) * 100`: the multiply turns 8.29
 * into 828.9999… and the store would be short a fen every time. Returns null for
 * anything that is not a positive amount with at most two decimals.
 */
export function topupAmountToCents(text: string): number | null {
  const cents = yuanAmountToCents(text);
  return cents !== null && cents > 0 ? cents : null;
}

/**
 * Parse a non-negative yuan input without ever multiplying a float.
 *
 * The digit-wise arithmetic lives once, in @laundry/ui; this keeps the member
 * module's stricter input contract (non-negative, at most nine yuan digits).
 */
export function yuanAmountToCents(text: string): number | null {
  if (!/^\d{1,9}(\.\d{1,2})?$/u.test(text.trim())) return null;
  const parsed = parseYuanToFen(text);
  return parsed.ok ? parsed.fen : null;
}

export function centsToYuanInput(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) return "";
  return formatFenToYuan(cents);
}

export function parseMemberBonusRules(value: unknown): readonly MemberBonusRuleView[] | null {
  if (!isRecord(value) || !Array.isArray(value.rules)) return null;
  const rules: MemberBonusRuleView[] = [];
  for (const item of value.rules) {
    if (!isRecord(item)) return null;
    const threshold = intOrNull(item.min_topup_cents);
    const bonus = intOrNull(item.bonus_cents);
    if (
      typeof item.rule_id !== "string" ||
      threshold === null ||
      threshold <= 0 ||
      bonus === null ||
      bonus < 0 ||
      (item.status !== "active" && item.status !== "retired") ||
      (item.note !== null && typeof item.note !== "string")
    ) {
      return null;
    }
    rules.push(
      Object.freeze({
        rule_id: item.rule_id,
        min_topup_cents: threshold,
        bonus_cents: bonus,
        status: item.status,
        note: typeof item.note === "string" ? item.note : null,
      }),
    );
  }
  return Object.freeze(rules);
}

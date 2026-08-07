/** View models for the member stored-value panel. All money is integer fen. */

export type MemberLedgerRowView = Readonly<{
  ledger_id: string;
  kind: string;
  principal_delta_cents: number;
  bonus_delta_cents: number;
  order_id: string | null;
  business_date: string;
}>;

export type MemberAccountSummary = Readonly<{
  account_id: string;
  status: string;
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

const intOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

function parseRow(value: unknown): MemberLedgerRowView | null {
  if (!isRecord(value)) return null;
  const principal = intOrNull(value.principal_delta_cents);
  const bonus = intOrNull(value.bonus_delta_cents);
  if (
    typeof value.ledger_id !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.business_date !== "string" ||
    principal === null ||
    bonus === null
  ) {
    return null;
  }
  return Object.freeze({
    ledger_id: value.ledger_id,
    kind: value.kind,
    principal_delta_cents: principal,
    bonus_delta_cents: bonus,
    order_id: typeof value.order_id === "string" ? value.order_id : null,
    business_date: value.business_date,
  });
}

/**
 * Parse the `member.account.get` payload.
 *
 * Returns null on anything unexpected rather than a half-filled view: showing a
 * plausible-but-wrong balance is worse than showing nothing.
 */
export function parseMemberAccountView(value: unknown): MemberAccountView | null {
  if (!isRecord(value)) return null;
  const rawRows = Array.isArray(value.recent) ? value.recent : [];
  const rows = rawRows.map(parseRow);
  if (rows.some((row) => row === null)) return null;
  const recent = Object.freeze(rows as readonly MemberLedgerRowView[]);

  if (value.account === null || value.account === undefined) {
    return Object.freeze({ account: null, recent });
  }
  const account = value.account;
  if (!isRecord(account)) return null;
  const principal = intOrNull(account.principal_cents);
  const bonus = intOrNull(account.bonus_cents);
  const balance = intOrNull(account.balance_cents);
  if (
    typeof account.account_id !== "string" ||
    typeof account.status !== "string" ||
    principal === null ||
    bonus === null ||
    balance === null
  ) {
    return null;
  }
  // The server sums the ledger; if the parts do not add up, the payload is not
  // one this panel should render.
  if (principal + bonus !== balance) return null;
  return Object.freeze({
    account: Object.freeze({
      account_id: account.account_id,
      status: account.status,
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

/** Parse a non-negative yuan input without ever multiplying a float. */
export function yuanAmountToCents(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/u.test(trimmed)) return null;
  const [yuanPart, fenPart = ""] = trimmed.split(".");
  const yuan = Number(yuanPart);
  const fen = Number(fenPart.padEnd(2, "0"));
  if (!Number.isSafeInteger(yuan) || !Number.isSafeInteger(fen)) return null;
  const cents = yuan * 100 + fen;
  if (!Number.isSafeInteger(cents) || cents < 0) return null;
  return cents;
}

export function centsToYuanInput(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) return "";
  const yuan = Math.floor(cents / 100);
  const fen = String(cents % 100).padStart(2, "0");
  return `${yuan}.${fen}`;
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

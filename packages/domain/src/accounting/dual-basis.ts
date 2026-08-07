export const ACCOUNTING_METHODS = Object.freeze([
  "cash",
  "wechat",
  "alipay",
  "other",
  "balance",
] as const);

export type AccountingMethod = (typeof ACCOUNTING_METHODS)[number];
export type AccountingGroupBy = "day" | "staff";
export type AccountingMovement = Readonly<{
  source: "order" | "stored_value";
  business_date: string;
  staff_id: string;
  staff_name: string;
  method: AccountingMethod;
  net_cents: number;
  ledger_row_count: number;
}>;

export type AccountingBasisTotals = Readonly<{
  real_income_cents: number;
  performance_income_cents: number;
  order_cashflow_cents: number;
  stored_value_cashflow_cents: number;
  stored_value_consumption_cents: number;
  ledger_row_count: number;
}>;

export type AccountingChannel = Readonly<{
  method: AccountingMethod;
  order_income_cents: number;
  stored_value_cashflow_cents: number;
  real_income_cents: number;
  performance_income_cents: number;
  ledger_row_count: number;
}>;

export type AccountingReportRow = AccountingBasisTotals & Readonly<{ key: string; label: string }>;

export type AccountingAggregation = Readonly<{
  totals: AccountingBasisTotals;
  channels: readonly AccountingChannel[];
  rows: readonly AccountingReportRow[];
}>;

type MutableBasis = {
  real_income_cents: number;
  performance_income_cents: number;
  order_cashflow_cents: number;
  stored_value_cashflow_cents: number;
  stored_value_consumption_cents: number;
  ledger_row_count: number;
};

type MutableChannel = MutableBasis & {
  method: AccountingMethod;
  order_income_cents: number;
};

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function emptyBasis(): MutableBasis {
  return {
    real_income_cents: 0,
    performance_income_cents: 0,
    order_cashflow_cents: 0,
    stored_value_cashflow_cents: 0,
    stored_value_consumption_cents: 0,
    ledger_row_count: 0,
  };
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new RangeError("accounting total exceeds safe integer");
  return value;
}

function validateMovement(movement: AccountingMovement): void {
  if (!BUSINESS_DATE.test(movement.business_date)) {
    throw new TypeError("accounting business_date must be YYYY-MM-DD");
  }
  if (movement.staff_id.length === 0 || movement.staff_name.trim().length === 0) {
    throw new TypeError("accounting staff identity is required");
  }
  if (!(ACCOUNTING_METHODS as readonly string[]).includes(movement.method)) {
    throw new TypeError("unsupported accounting method");
  }
  if (movement.source === "stored_value" && movement.method === "balance") {
    throw new TypeError("stored-value cashflow cannot use balance tender");
  }
  if (!Number.isSafeInteger(movement.net_cents)) {
    throw new TypeError("accounting money must be a safe integer");
  }
  if (!Number.isSafeInteger(movement.ledger_row_count) || movement.ledger_row_count <= 0) {
    throw new TypeError("accounting ledger row count must be a positive safe integer");
  }
}

function applyMovement(target: MutableBasis, movement: AccountingMovement): void {
  target.ledger_row_count = safeAdd(target.ledger_row_count, movement.ledger_row_count);
  if (movement.source === "stored_value") {
    target.stored_value_cashflow_cents = safeAdd(
      target.stored_value_cashflow_cents,
      movement.net_cents,
    );
    target.real_income_cents = safeAdd(target.real_income_cents, movement.net_cents);
    return;
  }
  target.performance_income_cents = safeAdd(target.performance_income_cents, movement.net_cents);
  if (movement.method === "balance") {
    target.stored_value_consumption_cents = safeAdd(
      target.stored_value_consumption_cents,
      movement.net_cents,
    );
    return;
  }
  target.order_cashflow_cents = safeAdd(target.order_cashflow_cents, movement.net_cents);
  target.real_income_cents = safeAdd(target.real_income_cents, movement.net_cents);
}

function freezeBasis(value: MutableBasis): AccountingBasisTotals {
  return Object.freeze({ ...value });
}

function groupIdentity(
  movement: AccountingMovement,
  groupBy: AccountingGroupBy,
): Readonly<{ key: string; label: string }> {
  return groupBy === "day"
    ? Object.freeze({ key: movement.business_date, label: movement.business_date })
    : Object.freeze({ key: movement.staff_id, label: movement.staff_name });
}

export function aggregateAccountingReport(
  movements: readonly AccountingMovement[],
  groupBy: AccountingGroupBy,
): AccountingAggregation {
  const totals = emptyBasis();
  const groups = new Map<string, MutableBasis & { label: string }>();
  const channels = new Map<AccountingMethod, MutableChannel>();
  const staffNames = new Map<string, string>();

  for (const movement of movements) {
    validateMovement(movement);
    const knownName = staffNames.get(movement.staff_id);
    if (knownName !== undefined && knownName !== movement.staff_name) {
      throw new TypeError("one staff id cannot have multiple staff names");
    }
    staffNames.set(movement.staff_id, movement.staff_name);
    applyMovement(totals, movement);

    const identity = groupIdentity(movement, groupBy);
    const group = groups.get(identity.key) ?? { ...emptyBasis(), label: identity.label };
    applyMovement(group, movement);
    groups.set(identity.key, group);

    const channel = channels.get(movement.method) ?? {
      ...emptyBasis(),
      method: movement.method,
      order_income_cents: 0,
    };
    applyMovement(channel, movement);
    if (movement.source === "order") {
      channel.order_income_cents = safeAdd(channel.order_income_cents, movement.net_cents);
    }
    channels.set(movement.method, channel);
  }

  const reportRows = [...groups.entries()]
    .map(([key, value]) => Object.freeze({ key, label: value.label, ...freezeBasis(value) }))
    .sort((left, right) =>
      groupBy === "day"
        ? left.key.localeCompare(right.key)
        : left.label.localeCompare(right.label, "zh-CN") || left.key.localeCompare(right.key),
    );
  const channelRows = ACCOUNTING_METHODS.map((method) => {
    const value = channels.get(method) ?? {
      ...emptyBasis(),
      method,
      order_income_cents: 0,
    };
    return Object.freeze({
      method,
      order_income_cents: value.order_income_cents,
      stored_value_cashflow_cents: value.stored_value_cashflow_cents,
      real_income_cents: value.real_income_cents,
      performance_income_cents: value.performance_income_cents,
      ledger_row_count: value.ledger_row_count,
    });
  });

  return Object.freeze({
    totals: freezeBasis(totals),
    channels: Object.freeze(channelRows),
    rows: Object.freeze(reportRows),
  });
}

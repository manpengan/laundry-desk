import type { QueryPort } from "../commands/types.js";
import { parseOwnerDrilldown, parseOwnerPortfolio } from "./owner-operations-parser.js";

export const OWNER_DRILLDOWN_QUERY_NAME = "reporting.owner_dashboard.drilldown";
export const OWNER_PORTFOLIO_QUERY_NAME = "reporting.owner_portfolio.get";

export type OwnerDrilldownKind = "today_pickups" | "new_receivables" | "stagnant_garments";

type DrilldownCommon = Readonly<{
  business_date: string;
  generated_at: string;
  total_row_count: number;
  truncated: boolean;
}>;

export type OwnerPickupDrilldown = DrilldownCommon &
  Readonly<{
    kind: "today_pickups";
    totals: Readonly<{ picked_up_garment_count: number; picked_up_order_count: number }>;
    rows: readonly Readonly<{
      ticket_no: string;
      picked_at: string;
      garment_count: number;
    }>[];
  }>;

export type OwnerReceivableDrilldown = DrilldownCommon &
  Readonly<{
    kind: "new_receivables";
    totals: Readonly<{ new_receivable_cents: number; new_receivable_order_count: number }>;
    rows: readonly Readonly<{
      ticket_no: string;
      received_at: string;
      balance_cents: number;
    }>[];
  }>;

export type OwnerStagnantDrilldown = DrilldownCommon &
  Readonly<{
    kind: "stagnant_garments";
    overdue_min_age_days: 30;
    totals: Readonly<{ overdue_garment_count: number; overdue_order_count: number }>;
    rows: readonly Readonly<{
      ticket_no: string;
      received_at: string;
      age_days: number;
      garment_count: number;
      balance_cents: number;
    }>[];
  }>;

export type OwnerDrilldownData =
  OwnerPickupDrilldown | OwnerReceivableDrilldown | OwnerStagnantDrilldown;

export type OwnerPortfolioMetrics = Readonly<{
  performance_income_cents: number;
  real_income_cents: number;
  picked_up_garment_count: number;
  new_receivable_cents: number;
  new_receivable_order_count: number;
  overdue_garment_count: number;
  overdue_order_count: number;
}>;

export type OwnerPortfolioStore = OwnerPortfolioMetrics &
  Readonly<{
    store_code: string;
    store_name: string;
    timezone: string;
    business_date: string;
  }>;

export type OwnerPortfolioData = Readonly<{
  generated_at: string;
  returned_store_count: number;
  truncated: boolean;
  totals: OwnerPortfolioMetrics;
  stores: readonly OwnerPortfolioStore[];
}>;

export type OwnerOperationLoadResult<T> =
  Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: string }>;

const EMPTY_INPUT: Readonly<Record<string, never>> = Object.freeze({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrap(value: unknown): unknown | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(value, "execution") ||
    !Object.hasOwn(value, "result") ||
    value.execution !== "executed"
  ) {
    return null;
  }
  return value.result;
}

async function load<T>(
  queryClient: QueryPort,
  name: string,
  input: Readonly<Record<string, unknown>>,
  parse: (value: unknown) => T | null,
): Promise<OwnerOperationLoadResult<T>> {
  try {
    const response = await queryClient.execute<unknown>(name, input);
    if (!response.ok) {
      return Object.freeze({
        ok: false as const,
        error: response.error.message ?? response.error.code,
      });
    }
    const parsed = parse(unwrap(response.data));
    return parsed === null
      ? Object.freeze({ ok: false as const, error: "经营数据格式无效" })
      : Object.freeze({ ok: true as const, data: parsed });
  } catch {
    return Object.freeze({ ok: false as const, error: "本地服务暂时不可用" });
  }
}

export function loadOwnerDrilldown(
  queryClient: QueryPort,
  kind: OwnerDrilldownKind,
): Promise<OwnerOperationLoadResult<OwnerDrilldownData>> {
  return load(
    queryClient,
    OWNER_DRILLDOWN_QUERY_NAME,
    Object.freeze({ kind }),
    parseOwnerDrilldown,
  );
}

export function loadOwnerPortfolio(
  queryClient: QueryPort,
): Promise<OwnerOperationLoadResult<OwnerPortfolioData>> {
  return load(queryClient, OWNER_PORTFOLIO_QUERY_NAME, EMPTY_INPUT, parseOwnerPortfolio);
}

export { parseOwnerDrilldown, parseOwnerPortfolio } from "./owner-operations-parser.js";

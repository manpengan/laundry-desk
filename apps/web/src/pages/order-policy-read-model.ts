export type OrderDiscountSource = "none" | "manual" | "customer" | "tier";
export type OrderTierSnapshotView = Readonly<{
  tier_id: string;
  definition_version: number;
  code: string;
  name: string;
  level: number;
  discount_bps: number;
}>;
export type OrderPolicySnapshotView = Readonly<{
  customer_profile_version: number;
  discount_source: OrderDiscountSource;
  discount_bps: number;
  membership_version: number | null;
  tier: OrderTierSnapshotView | null;
  waivers: Readonly<{
    skip_ticket_print: boolean;
    skip_label_print: boolean;
    skip_rack_assignment: boolean;
  }>;
}>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SOURCES = new Set<OrderDiscountSource>(["none", "manual", "customer", "tier"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : null;
}

function parseTier(value: unknown): OrderTierSnapshotView | null | undefined {
  if (value === null || value === undefined) return null;
  const row = record(value);
  const version = integer(row?.definition_version, 1);
  const level = integer(row?.level, 0);
  const discountBps = integer(row?.discount_bps, 0, 10_000);
  if (
    row === null ||
    typeof row.tier_id !== "string" ||
    !UUID_RE.test(row.tier_id) ||
    typeof row.code !== "string" ||
    row.code.length < 1 ||
    row.code.length > 32 ||
    typeof row.name !== "string" ||
    row.name.length < 1 ||
    row.name.length > 64 ||
    version === null ||
    level === null ||
    discountBps === null
  ) {
    return undefined;
  }
  return Object.freeze({
    tier_id: row.tier_id,
    definition_version: version,
    code: row.code,
    name: row.name,
    level,
    discount_bps: discountBps,
  });
}

export function parseOrderPolicySnapshot(
  row: Record<string, unknown>,
  discountCents: number,
): OrderPolicySnapshotView | null {
  const profileVersion = integer(row.customer_profile_version ?? 0, 0);
  const source = row.discount_source ?? (discountCents > 0 ? "manual" : "none");
  const discountBps = integer(row.discount_bps ?? 0, 0, 10_000);
  const membershipVersion =
    row.membership_version === null || row.membership_version === undefined
      ? null
      : integer(row.membership_version, 1);
  const tier = parseTier(row.tier);
  const waiverRow = record(
    row.waivers ?? {
      skip_ticket_print: false,
      skip_label_print: false,
      skip_rack_assignment: false,
    },
  );
  if (
    profileVersion === null ||
    typeof source !== "string" ||
    !SOURCES.has(source as OrderDiscountSource) ||
    discountBps === null ||
    (membershipVersion === null &&
      row.membership_version !== null &&
      row.membership_version !== undefined) ||
    tier === undefined ||
    waiverRow === null ||
    typeof waiverRow.skip_ticket_print !== "boolean" ||
    typeof waiverRow.skip_label_print !== "boolean" ||
    typeof waiverRow.skip_rack_assignment !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({
    customer_profile_version: profileVersion,
    discount_source: source as OrderDiscountSource,
    discount_bps: discountBps,
    membership_version: membershipVersion,
    tier,
    waivers: Object.freeze({
      skip_ticket_print: waiverRow.skip_ticket_print,
      skip_label_print: waiverRow.skip_label_print,
      skip_rack_assignment: waiverRow.skip_rack_assignment,
    }),
  });
}

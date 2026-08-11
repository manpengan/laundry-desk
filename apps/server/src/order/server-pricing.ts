import { businessDayAt, type OrderPricingAdjustments } from "@laundry/domain";

import type { CatalogStore } from "../catalog/memory-catalog.js";
import { HandlerCommandError } from "../bus/types.js";
import { createCommandError } from "@laundry/contracts";
import { EMPTY_PRICING_POLICY, type StorePricingPolicy } from "../pricing/types.js";
import type { GarmentDetailRecord, PricingAddonSnapshot } from "./types.js";

type ParsedGarmentDetail = Readonly<{
  color: string | null;
  brand: string | null;
  defects: readonly string[];
  accessories: readonly string[];
  note: string | null;
  addon_codes: readonly string[];
}>;

export type ParsedCounterLine = Readonly<{
  service_code: string;
  category_code: string;
  qty: number;
  color?: string;
  brand?: string;
  garments: readonly ParsedGarmentDetail[];
}>;

export type ServerPricedLine = ParsedCounterLine &
  Readonly<{
    unit_price_cents: number;
  }>;

export type InitialPaymentInput = Readonly<{
  amount_cents: number;
  method: "cash" | "wechat" | "alipay" | "other";
  note?: string;
}>;

export type TrustedPricingPlan = Readonly<{
  lines: readonly (ServerPricedLine &
    Readonly<{ garment_details: readonly GarmentDetailRecord[] }>)[];
  adjustments: OrderPricingAdjustments;
  pricing_policy_version: number;
  urgent_selected: boolean;
  freight_selected: boolean;
}>;

const paymentMethods = new Set(["cash", "wechat", "alipay", "other"]);

export function asRecord(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid();
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw invalid();
  return value;
}

export function requireNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}

export function requireLines(value: unknown): readonly ParsedCounterLine[] {
  if (!Array.isArray(value) || value.length === 0) throw invalid();
  return Object.freeze(
    value.map((row) => {
      const line = asRecord(row);
      const qty = requireNonNegativeInteger(line.qty);
      if (qty < 1) throw invalid();
      const color = optionalText(line.color);
      const brand = optionalText(line.brand);
      const garments =
        line.garments === undefined
          ? Array.from({ length: qty }, () => emptyGarmentDetail(color, brand))
          : requireGarmentDetails(line.garments, qty);
      return Object.freeze({
        service_code: requireString(line.service_code),
        category_code: requireString(line.category_code),
        qty,
        ...(color === null ? {} : { color }),
        ...(brand === null ? {} : { brand }),
        garments,
      });
    }),
  );
}

function discountFromInput(
  input: Readonly<Record<string, unknown>>,
  permissions: readonly string[] | undefined,
): number {
  const discountCents = optionalCents(input.discount_cents);
  if (
    discountCents !== undefined &&
    discountCents > 0 &&
    !permissions?.includes("order_discount")
  ) {
    throw new HandlerCommandError(createCommandError("PERMISSION_DENIED"));
  }
  return discountCents ?? 0;
}

export function initialPayment(
  input: Readonly<Record<string, unknown>>,
): InitialPaymentInput | null {
  if (input.initial_payment !== undefined) {
    const payment = asRecord(input.initial_payment);
    const method = requireString(payment.method);
    if (!paymentMethods.has(method)) throw invalid();
    return Object.freeze({
      amount_cents: requireNonNegativeInteger(payment.amount_cents),
      method: method as InitialPaymentInput["method"],
      ...(typeof payment.note === "string" ? { note: payment.note } : {}),
    });
  }

  if (input.paid_cents === undefined) return null;
  return Object.freeze({
    amount_cents: requireNonNegativeInteger(input.paid_cents),
    method: "cash",
  });
}

export async function resolveServerPrices(
  store: CatalogStore | undefined,
  lines: readonly ParsedCounterLine[],
): Promise<readonly ServerPricedLine[]> {
  if (store === undefined) throw unavailable();
  const catalog = await store.listAll();
  return Object.freeze(
    lines.map((line) => {
      const matches = catalog.filter(
        (item) =>
          item.service_code === line.service_code && item.category_code === line.category_code,
      );
      if (matches.length !== 1) throw unavailable();
      const item = matches[0];
      if (item === undefined) throw unavailable();
      return Object.freeze({ ...line, unit_price_cents: item.unit_price_cents });
    }),
  );
}

function resolveGarmentDetails(
  lines: readonly ServerPricedLine[],
  policy: StorePricingPolicy,
): Readonly<{ lines: TrustedPricingPlan["lines"]; addonCents: number }> {
  const active = new Map(
    policy.addons.filter((addon) => addon.is_active).map((addon) => [addon.code, addon]),
  );
  let addonCents = 0;
  const resolvedLines = lines.map((line) => {
    const garmentDetails = line.garments.map((garment): GarmentDetailRecord => {
      const addons = garment.addon_codes.map((code): PricingAddonSnapshot => {
        const addon = active.get(code);
        if (addon === undefined) throw invalid();
        addonCents = safeAdd(addonCents, addon.unit_price_cents);
        return Object.freeze({
          code: addon.code,
          name: addon.name,
          unit_price_cents: addon.unit_price_cents,
        });
      });
      return Object.freeze({
        color: garment.color,
        brand: garment.brand,
        defects: garment.defects,
        accessories: garment.accessories,
        note: garment.note,
        addons: Object.freeze(addons),
      });
    });
    return Object.freeze({ ...line, garment_details: Object.freeze(garmentDetails) });
  });
  return Object.freeze({ lines: Object.freeze(resolvedLines), addonCents });
}

export function resolveTrustedPricing(
  input: Readonly<Record<string, unknown>>,
  lines: readonly ServerPricedLine[],
  policy: StorePricingPolicy | undefined,
  permissions: readonly string[] | undefined,
): TrustedPricingPlan {
  const resolvedPolicy = policy ?? EMPTY_PRICING_POLICY;
  const details = resolveGarmentDetails(lines, resolvedPolicy);
  const urgentSelected = input.urgent === true;
  const freightSelected = input.freight === true;
  return Object.freeze({
    lines: details.lines,
    adjustments: Object.freeze({
      discount_cents: discountFromInput(input, permissions),
      addon_cents: details.addonCents,
      urgent_cents: urgentSelected ? resolvedPolicy.urgent_cents : 0,
      freight_cents: freightSelected ? resolvedPolicy.freight_cents : 0,
    }),
    pricing_policy_version: resolvedPolicy.version,
    urgent_selected: urgentSelected,
    freight_selected: freightSelected,
  });
}

export function deriveBusinessDate(
  epochSeconds: number,
  timeZone: string | undefined,
  rolloverHour: number | undefined,
): string {
  return businessDayAt(new Date(epochSeconds * 1000), timeZone ?? "UTC", rolloverHour ?? 0)
    .business_date;
}

export async function assertBusinessDayOpen(
  check: ((businessDate: string) => Promise<boolean>) | undefined,
  businessDate: string,
): Promise<void> {
  if (check !== undefined && (await check(businessDate))) {
    throw new HandlerCommandError(createCommandError("SHIFT_CLOSED"));
  }
}

function optionalCents(value: unknown): number | undefined {
  return value === undefined ? undefined : requireNonNegativeInteger(value);
}

function optionalText(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw invalid();
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function requireTextList(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw invalid();
  return Object.freeze(value.map((item) => item.trim()));
}

function requireAddonCodes(value: unknown): readonly string[] {
  const codes = requireTextList(value);
  if (new Set(codes).size !== codes.length) throw invalid();
  return codes;
}

function parseGarmentDetail(value: unknown): ParsedGarmentDetail {
  const garment = asRecord(value);
  return Object.freeze({
    color: optionalText(garment.color),
    brand: optionalText(garment.brand),
    defects: requireTextList(garment.defects),
    accessories: requireTextList(garment.accessories),
    note: optionalText(garment.note),
    addon_codes: requireAddonCodes(garment.addon_codes),
  });
}

function requireGarmentDetails(value: unknown, qty: number): readonly ParsedGarmentDetail[] {
  if (!Array.isArray(value) || value.length !== qty) throw invalid();
  return Object.freeze(value.map(parseGarmentDetail));
}

function emptyGarmentDetail(color: string | null, brand: string | null): ParsedGarmentDetail {
  return Object.freeze({
    color,
    brand,
    defects: Object.freeze([]),
    accessories: Object.freeze([]),
    note: null,
    addon_codes: Object.freeze([]),
  });
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw invalid();
  return total;
}

function invalid(): HandlerCommandError {
  return new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
}

function unavailable(): HandlerCommandError {
  return new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
}

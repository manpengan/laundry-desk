import { businessDayAt, type OrderPricingAdjustments } from "@laundry/domain";

import type { CatalogStore } from "../catalog/memory-catalog.js";
import { HandlerCommandError } from "../bus/types.js";
import { createCommandError } from "@laundry/contracts";

export type ParsedCounterLine = Readonly<{
  service_code: string;
  category_code: string;
  qty: number;
  color?: string;
  brand?: string;
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
      return Object.freeze({
        service_code: requireString(line.service_code),
        category_code: requireString(line.category_code),
        qty,
        ...(typeof line.color === "string" ? { color: line.color } : {}),
        ...(typeof line.brand === "string" ? { brand: line.brand } : {}),
      });
    }),
  );
}

export function pricingAdjustments(
  input: Readonly<Record<string, unknown>>,
): OrderPricingAdjustments {
  const discountCents = optionalCents(input.discount_cents);
  const addonCents = optionalCents(input.addon_cents);
  const urgentCents = optionalCents(input.urgent_cents);
  const freightCents = optionalCents(input.freight_cents);
  return Object.freeze({
    ...(discountCents === undefined ? {} : { discount_cents: discountCents }),
    ...(addonCents === undefined ? {} : { addon_cents: addonCents }),
    ...(urgentCents === undefined ? {} : { urgent_cents: urgentCents }),
    ...(freightCents === undefined ? {} : { freight_cents: freightCents }),
  });
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

function invalid(): HandlerCommandError {
  return new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
}

function unavailable(): HandlerCommandError {
  return new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
}

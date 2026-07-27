import { parseNonNegCents } from "./order-form.js";

export type PricingAdjustments = Readonly<{
  discount_cents: number;
  addon_cents: number;
  urgent_cents: number;
  freight_cents: number;
}>;

export function parsePricingAdjustments(input: {
  discount_cents: string;
  addon_cents: string;
  urgent_cents: string;
  freight_cents: string;
}): Readonly<{ ok: true; values: PricingAdjustments }> | Readonly<{ ok: false; message: string }> {
  const values = {
    discount_cents: parseNonNegCents(input.discount_cents),
    addon_cents: parseNonNegCents(input.addon_cents),
    urgent_cents: parseNonNegCents(input.urgent_cents),
    freight_cents: parseNonNegCents(input.freight_cents),
  };
  if (Object.values(values).some((value) => value === null)) {
    return Object.freeze({ ok: false as const, message: "金额调整须为非负整数分" });
  }
  return Object.freeze({ ok: true as const, values: values as PricingAdjustments });
}

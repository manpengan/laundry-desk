import { parseNonNegCents } from "./order-form.js";
import { activePricingAddons, type PricingPolicyView } from "./pricing-policy-model.js";
import type { ReceiveLineDraft } from "./receive-garment-form.js";

export type PricingSelection = Readonly<{
  discount_cents: string;
  urgent: boolean;
  freight: boolean;
}>;

export type ReceivePreviewTotals = Readonly<{
  original: number;
  discount: number;
  addon: number;
  urgent: number;
  freight: number;
  payable: number;
}>;

export const EMPTY_PRICING_SELECTION: PricingSelection = Object.freeze({
  discount_cents: "0",
  urgent: false,
  freight: false,
});

export function previewReceiveTotals(
  lines: readonly ReceiveLineDraft[],
  selection: PricingSelection,
  policy: PricingPolicyView,
): ReceivePreviewTotals {
  const original = lines.reduce(
    (total, line) => total + (line.unit_price_cents ?? 0) * (parseNonNegCents(line.qty) ?? 0),
    0,
  );
  const discount = parseNonNegCents(selection.discount_cents) ?? 0;
  const addonByCode = new Map(
    activePricingAddons(policy).map((addon) => [addon.code, addon.unit_price_cents]),
  );
  const addon = lines.reduce(
    (total, line) =>
      total +
      line.garments.reduce(
        (pieceTotal, garment) =>
          pieceTotal +
          garment.addon_codes.reduce(
            (addonTotal, code) => addonTotal + (addonByCode.get(code) ?? 0),
            0,
          ),
        0,
      ),
    0,
  );
  const urgent = selection.urgent ? policy.urgent_cents : 0;
  const freight = selection.freight ? policy.freight_cents : 0;
  return Object.freeze({
    original,
    discount,
    addon,
    urgent,
    freight,
    payable: Math.max(0, original - discount + addon + urgent + freight),
  });
}

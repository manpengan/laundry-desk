import type { ActorContext } from "../bus/types.js";
import type { TenantContext } from "../db/types.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";

export const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

export const ACTOR: ActorContext = Object.freeze({
  staffId: DEMO_STAFF_A_ID,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze([
    "customer_write",
    "order_write",
    "order_discount",
    "payment_write",
    "payment_refund",
    "shift_close",
  ]),
});

export const UNIT_PRICE_CENTS = 1_000;
export const PRICING = Object.freeze({
  discount_cents: 100,
  addon_cents: 200,
  urgent_cents: 300,
  freight_cents: 400,
});
export const PAYABLE_CENTS =
  2 * UNIT_PRICE_CENTS -
  PRICING.discount_cents +
  PRICING.addon_cents +
  PRICING.urgent_cents +
  PRICING.freight_cents;
export const FIXED_BUSINESS_DATE = "2026-01-15";
export const CUSTOMER_PHONE = `139${String(Date.parse("2026-07-28") % 100_000_000).padStart(
  8,
  "0",
)}`;
export const TARGET_CUSTOMER_PHONE = `138${CUSTOMER_PHONE.slice(3)}`;

const FIXED_CLOCK_EPOCH_SECONDS = Math.floor(Date.parse("2026-01-15T03:00:00Z") / 1000);
export const fixedNow = (): number => FIXED_CLOCK_EPOCH_SECONDS;

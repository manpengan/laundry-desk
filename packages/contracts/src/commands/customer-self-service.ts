import { z } from "zod";

import { defineQuery, type QueryDefinition } from "../registry/definitions.js";
import {
  ReconciliationPaymentKindSchema,
  ReconciliationPaymentMethodSchema,
} from "./reconciliation.js";

const CentsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const EpochSecondsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const TimestampSchema = z.iso.datetime({ offset: true });
const PortalCodeSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u, "Expected a bounded store code");
const PhoneSchema = z.string().regex(/^1[3-9]\d{9}$/u, "Expected a mainland mobile number");
const PickupCodeSchema = z.string().trim().min(4).max(64);

export const CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME = "x-customer-portal-authority" as const;
export const CustomerPortalAuthoritySchema = z
  .string()
  .regex(/^v1\.[A-Za-z0-9_-]{43}$/u, "Expected a 256-bit tab authority");
export const CustomerPortalCookieSelectorSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u, "Expected a SHA-256 cookie selector");

export function customerPortalCookieNames(selector: string, secure: boolean) {
  const parsed = CustomerPortalCookieSelectorSchema.safeParse(selector);
  if (!parsed.success) return null;
  const prefix = secure ? "__Host-" : "";
  return Object.freeze({
    session: `${prefix}laundry_customer_session_${parsed.data}`,
    csrf: `${prefix}laundry_customer_csrf_${parsed.data}`,
  });
}

export const CustomerPortalLoginInputSchema = z.strictObject({
  org_code: PortalCodeSchema,
  store_code: PortalCodeSchema,
  phone: PhoneSchema,
  pickup_code: PickupCodeSchema,
});
export const CustomerPortalEmptyInputSchema = z.strictObject({});

export const CustomerPortalSessionSchema = z.strictObject({
  authenticated: z.literal(true),
  expires_at: EpochSecondsSchema,
});

export const CustomerSelfServiceOrdersListInputSchema = z.strictObject({
  limit: z.number().int().positive().max(20).optional(),
});
export const CustomerSelfServiceOrderInputSchema = z.strictObject({ order_id: z.uuid() });
export const CustomerSelfServiceGarmentProgressInputSchema = z.strictObject({
  order_id: z.uuid(),
  garment_id: z.uuid(),
});

export const CustomerPortalOrderStatusSchema = z.enum(["open", "closed", "cancelled"]);
export const CustomerPortalGarmentStatusSchema = z.enum([
  "received",
  "washing",
  "ready",
  "racked",
  "picked_up",
  "delivered",
  "reworked",
  "lost",
]);

export const CustomerPortalOrderSummarySchema = z.strictObject({
  order_id: z.uuid(),
  ticket_no: z.string().min(1).max(64),
  status: CustomerPortalOrderStatusSchema,
  payable_cents: CentsSchema,
  paid_cents: CentsSchema,
  balance_cents: CentsSchema,
  garment_count: z.number().int().nonnegative().max(1_000),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});

export const CustomerPortalOrderLineSchema = z.strictObject({
  line_index: z.number().int().nonnegative(),
  service_code: z.string().min(1).max(32),
  category_code: z.string().min(1).max(32),
  unit_price_cents: CentsSchema,
  qty: z.number().int().positive().max(1_000),
  line_total_cents: CentsSchema,
  color: z.string().max(32).nullable(),
  brand: z.string().max(32).nullable(),
});

export const CustomerPortalOrdersListResultSchema = z.strictObject({
  orders: z.array(CustomerPortalOrderSummarySchema).max(20),
});
export const CustomerPortalOrderGetResultSchema = z.strictObject({
  order: CustomerPortalOrderSummarySchema,
  lines: z.array(CustomerPortalOrderLineSchema).max(200),
});

export const CustomerPortalReceiptPaymentSchema = z.strictObject({
  payment_id: z.uuid(),
  method: ReconciliationPaymentMethodSchema,
  kind: ReconciliationPaymentKindSchema,
  amount_cents: CentsSchema,
  at: TimestampSchema,
});
export const CustomerPortalReceiptResultSchema = z.strictObject({
  receipt: z.strictObject({
    order_id: z.uuid(),
    ticket_no: z.string().min(1).max(64),
    business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    original_cents: CentsSchema,
    discount_cents: CentsSchema,
    addon_cents: CentsSchema,
    urgent_cents: CentsSchema,
    freight_cents: CentsSchema,
    payable_cents: CentsSchema,
    paid_cents: CentsSchema,
    balance_cents: CentsSchema,
    created_at: TimestampSchema,
    lines: z.array(CustomerPortalOrderLineSchema).max(200),
    payments: z.array(CustomerPortalReceiptPaymentSchema).max(200),
  }),
});

export const CustomerPortalGarmentSchema = z.strictObject({
  garment_id: z.uuid(),
  order_id: z.uuid(),
  seq: z.number().int().positive().max(1_000),
  service_code: z.string().min(1).max(32),
  category_code: z.string().min(1).max(32),
  color: z.string().max(32).nullable(),
  brand: z.string().max(32).nullable(),
  status: CustomerPortalGarmentStatusSchema,
});
export const CustomerPortalGarmentsListResultSchema = z.strictObject({
  garments: z.array(CustomerPortalGarmentSchema).max(200),
});
export const CustomerPortalGarmentProgressResultSchema = z.strictObject({
  garment: CustomerPortalGarmentSchema,
  progress: z
    .array(
      z.strictObject({
        from_status: CustomerPortalGarmentStatusSchema,
        to_status: CustomerPortalGarmentStatusSchema,
        at: TimestampSchema,
      }),
    )
    .max(200),
});

function customerPortalQuery<T extends z.ZodObject>(definition: {
  name: string;
  description: string;
  input: T;
  max: number;
  resultPath: string;
}): QueryDefinition<T> {
  return defineQuery({
    name: definition.name,
    version: "0.1.0",
    description: definition.description,
    description_llm:
      "Customer-owned receipt and garment data behind a dedicated customer session; never expose it as an AI tool.",
    input: definition.input,
    risk: "R2",
    invariants: ["rbac.customer_self_service_subject"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "pii",
    input_redaction: [],
    result_redaction: [{ path: definition.resultPath, strategy: "mask" }],
    max_result_rows: definition.max,
  });
}

export const CUSTOMER_SELF_SERVICE_QUERIES = Object.freeze([
  customerPortalQuery({
    name: "customer.self_service.orders.list",
    description: "List the signed-in customer's recent formal orders.",
    input: CustomerSelfServiceOrdersListInputSchema,
    max: 20,
    resultPath: "/orders/*/ticket_no",
  }),
  customerPortalQuery({
    name: "customer.self_service.order.get",
    description: "Read one customer-owned order without staff notes or internal evidence.",
    input: CustomerSelfServiceOrderInputSchema,
    max: 201,
    resultPath: "/order/ticket_no",
  }),
  customerPortalQuery({
    name: "customer.self_service.receipt.get",
    description: "Read one customer-owned receipt with integer-cent totals and ledger entries.",
    input: CustomerSelfServiceOrderInputSchema,
    max: 401,
    resultPath: "/receipt/ticket_no",
  }),
  customerPortalQuery({
    name: "customer.self_service.garments.list",
    description: "List the authoritative current garment statuses for one customer-owned order.",
    input: CustomerSelfServiceOrderInputSchema,
    max: 200,
    resultPath: "/garments/*/garment_id",
  }),
  customerPortalQuery({
    name: "customer.self_service.garment.progress",
    description: "Read immutable status transitions for one customer-owned garment.",
    input: CustomerSelfServiceGarmentProgressInputSchema,
    max: 201,
    resultPath: "/garment/garment_id",
  }),
] as const);

export const CUSTOMER_SELF_SERVICE_QUERY_NAMES = Object.freeze(
  CUSTOMER_SELF_SERVICE_QUERIES.map((query) => query.name),
) as readonly [
  "customer.self_service.orders.list",
  "customer.self_service.order.get",
  "customer.self_service.receipt.get",
  "customer.self_service.garments.list",
  "customer.self_service.garment.progress",
];

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type CustomerPortalLoginInput = DeepReadonly<
  z.output<typeof CustomerPortalLoginInputSchema>
>;
export type CustomerPortalSession = DeepReadonly<z.output<typeof CustomerPortalSessionSchema>>;
export type CustomerPortalOrderSummary = DeepReadonly<
  z.output<typeof CustomerPortalOrderSummarySchema>
>;
export type CustomerPortalOrderGetResult = DeepReadonly<
  z.output<typeof CustomerPortalOrderGetResultSchema>
>;
export type CustomerPortalReceiptResult = DeepReadonly<
  z.output<typeof CustomerPortalReceiptResultSchema>
>;
export type CustomerPortalGarmentsListResult = DeepReadonly<
  z.output<typeof CustomerPortalGarmentsListResultSchema>
>;
export type CustomerPortalGarmentProgressResult = DeepReadonly<
  z.output<typeof CustomerPortalGarmentProgressResultSchema>
>;

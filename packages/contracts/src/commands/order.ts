/**
 * M2 counter order commands and read queries (receive, pickup, lookup).
 * Full catalog/payment/fulfillment land in later M2 increments (contracts v0.2).
 */

import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";
import { BusinessDateSchema } from "./stats.js";
import { PaymentMethodSchema } from "./payment.js";
import { PricingAddonCodeSchema } from "./pricing.js";

const ServiceCodeSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/u, "Expected service code");
const CategoryCodeSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/u, "Expected category code");
const NonNegCentsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PhoneSchema = z
  .string()
  .regex(/^1[3-9]\d{9}$/u, "Expected mainland mobile (seed range 13800000xxx ok)");

export const OrderStatusSchema = z.enum(["draft", "open", "closed", "cancelled"]);

const GarmentDetailTextSchema = z.string().trim().min(1).max(32);

export const OrderGarmentDetailSchema = z
  .strictObject({
    color: z.string().trim().max(32).optional(),
    brand: z.string().trim().max(32).optional(),
    defects: z.array(GarmentDetailTextSchema).max(12).optional(),
    accessories: z.array(GarmentDetailTextSchema).max(12).optional(),
    note: z.string().trim().max(256).optional(),
    addon_codes: z.array(PricingAddonCodeSchema).max(8).optional(),
  })
  .superRefine((value, ctx) => {
    const codes = value.addon_codes ?? [];
    if (new Set(codes).size !== codes.length) {
      ctx.addIssue({
        code: "custom",
        path: ["addon_codes"],
        message: "Duplicate addon codes are not allowed",
      });
    }
  });

export const OrderReceiveLineSchema = z
  .strictObject({
    service_code: ServiceCodeSchema,
    category_code: CategoryCodeSchema,
    qty: z.number().int().positive().max(50),
    /** Compatibility-only common values used when an old client omits garments. */
    color: z.string().max(32).optional(),
    brand: z.string().max(32).optional(),
    /** New clients submit exactly one bounded detail object per physical piece. */
    garments: z.array(OrderGarmentDetailSchema).min(1).max(50).optional(),
    /**
     * Compatibility-only field for queued M2 clients. It is validated then
     * discarded; handlers always resolve the price from the active catalog.
     */
    unit_price_cents: NonNegCentsSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.garments !== undefined && value.garments.length !== value.qty) {
      ctx.addIssue({
        code: "custom",
        path: ["garments"],
        message: "garments length must equal qty",
      });
    }
  });

export const OrderPricingAdjustmentsSchema = z.strictObject({
  discount_cents: NonNegCentsSchema.optional(),
  urgent: z.boolean().optional(),
  freight: z.boolean().optional(),
  /** Compatibility-only amounts. The server validates then ignores them. */
  addon_cents: NonNegCentsSchema.optional(),
  urgent_cents: NonNegCentsSchema.optional(),
  freight_cents: NonNegCentsSchema.optional(),
});

export const OrderInitialPaymentSchema = z.strictObject({
  amount_cents: NonNegCentsSchema,
  method: PaymentMethodSchema,
  note: z.string().max(256).optional(),
});

export const OrderReceiveInputSchema = z.strictObject({
  /** Optional existing draft to atomically convert into an open order. */
  draft_id: z.uuid().optional(),
  customer_phone: PhoneSchema.optional(),
  customer_name: z.string().min(1).max(64).optional(),
  lines: z.array(OrderReceiveLineSchema).min(1).max(40),
  /** Omitted means debt order; a zero amount never creates a ledger row. */
  initial_payment: OrderInitialPaymentSchema.optional(),
  /** @deprecated Use initial_payment. Interpreted as a cash initial payment. */
  paid_cents: NonNegCentsSchema.optional(),
  ...OrderPricingAdjustmentsSchema.shape,
  note: z.string().max(256).optional(),
});

export const OrderPickupInputSchema = z.strictObject({
  order_id: z.uuid(),
  /** Empty array = all pickable garments on the order. */
  garment_ids: z.array(z.uuid()).max(200),
  /** Scanned barcodes proving every selected racked garment was physically checked. */
  verification_barcodes: z.array(z.string().trim().min(1).max(64)).max(200).optional(),
  collect_cents: NonNegCentsSchema,
});

export const OrderHoldInputSchema = z.strictObject({
  /** Omit for a new draft; supply to replace the same unreceived draft. */
  draft_id: z.uuid().optional(),
  customer_phone: PhoneSchema.optional(),
  customer_name: z.string().min(1).max(64).optional(),
  lines: z.array(OrderReceiveLineSchema).min(1).max(40),
  ...OrderPricingAdjustmentsSchema.shape,
  note: z.string().max(256).optional(),
});

export const OrderCancelInputSchema = z.strictObject({
  order_id: z.uuid(),
  reason: z.string().min(1).max(256),
});

export const OrderGetInputSchema = z.strictObject({
  order_id: z.uuid(),
});

export const OrderListInputSchema = z.strictObject({
  /** Store business day (YYYY-MM-DD). Omit = all days. */
  business_date: BusinessDateSchema.optional(),
  status: OrderStatusSchema.optional(),
  /** Exact match on order.customer_phone after PhoneSchema normalize. */
  customer_phone: PhoneSchema.optional(),
  /**
   * Receivables filter: keep rows with balance_cents >= this value (integer fen).
   * Debt workbench uses `1` (positive balance). Omit = no balance floor.
   */
  min_balance_cents: NonNegCentsSchema.optional(),
  /** Hard row cap (handler default 20; must not exceed max_result_rows 50). */
  limit: z.number().int().positive().max(50).optional(),
});

/** Counter lookup is intentionally bounded and server-side: never fetch a whole order list to scan. */
export const OrderLookupInputSchema = z.strictObject({
  /** Ticket number, customer pickup code, garment barcode, mobile number, or customer-name prefix. */
  key: z.string().trim().min(1).max(128),
  /** Pickup defaults to open orders; history callers may explicitly widen the status. */
  status: OrderStatusSchema.optional(),
  /** A small candidate set forces an explicit UI choice when a customer has several orders. */
  limit: z.number().int().positive().max(20).optional(),
});

export const OrderLookupMatchKindSchema = z.enum([
  "ticket_no",
  "pickup_code",
  "garment_barcode",
  "customer_phone",
  "customer_name",
]);

/**
 * List row (documented for tests / handlers; not Zod-validated on wire).
 *
 * ```ts
 * {
 *   order_id, ticket_no, status, customer_phone, customer_name,
 *   payable_cents, paid_cents, balance_cents, created_at, garment_count?
 * }
 * ```
 */
export type OrderListRow = Readonly<{
  order_id: string;
  ticket_no: string | null;
  status: "draft" | "open" | "closed" | "cancelled";
  customer_phone: string | null;
  customer_name: string | null;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  created_at: number;
  garment_count?: number;
}>;

export type OrderListResult = Readonly<{
  orders: readonly OrderListRow[];
}>;

export type OrderLookupMatchKind = z.infer<typeof OrderLookupMatchKindSchema>;

export type OrderLookupRow = OrderListRow &
  Readonly<{
    pickup_code: string | null;
    matched_by: OrderLookupMatchKind;
  }>;

export type OrderLookupResult = Readonly<{
  orders: readonly OrderLookupRow[];
}>;

type ReceiveInput = typeof OrderReceiveInputSchema;
type PickupInput = typeof OrderPickupInputSchema;
type HoldInput = typeof OrderHoldInputSchema;
type CancelInput = typeof OrderCancelInputSchema;
type GetInput = typeof OrderGetInputSchema;
type ListInput = typeof OrderListInputSchema;
type LookupInput = typeof OrderLookupInputSchema;

/** 开单：生成 order + order_lines 语义 + 按 qty 拆 garments（runtime）。 */
export const orderReceiveCommand: CommandDefinition<ReceiveInput> = defineCommand({
  name: "order.receive",
  version: "0.4.0",
  description:
    "Create an open order from server catalog and store pricing policy, atomically append its first payment, and expand line quantities into detailed garments.",
  description_llm:
    "Open a counter order using active server catalog and pricing policy. Clients select add-on codes and urgent/freight flags but cannot submit their amounts or a unit price. Expand each line qty into garments at received status. Integer cents only.",
  input: OrderReceiveInputSchema,
  risk: "R1",
  invariants: ["rbac.order_write", "order.lines_nonempty"],
  idempotent: true,
  sideEffects: ["order.created", "garment.received", "audit.order_event"],
  offline_mode: "grant",
  data_classification: "pii",
  input_redaction: [{ path: "/customer_phone", strategy: "mask" }],
  result_redaction: [],
  size_measures: {
    batch: { kind: "array_length", path: "/lines" },
  },
  hard_limits: { max_batch: 40 },
});

/** 取衣：件状态 → picked_up，可整单或勾选部分件。 */
export const orderPickupCommand: CommandDefinition<PickupInput> = defineCommand({
  name: "order.pickup",
  version: "0.3.0",
  description: "Mark selected garments picked up and record cash collection.",
  description_llm:
    "Pickup garments by id (or all pickable). Every selected racked garment requires its scanned barcode in verification_barcodes. collect_cents settles balance.",
  input: OrderPickupInputSchema,
  risk: "R2",
  invariants: ["rbac.order_write", "order.pickup_allowed"],
  idempotent: true,
  sideEffects: ["garment.picked_up", "payment.collected", "audit.order_event"],
  offline_mode: "primary_lease",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [],
  size_measures: {
    batch: { kind: "array_length", path: "/garment_ids" },
    amount: { kind: "field", path: "/collect_cents" },
  },
  hard_limits: { max_batch: 200, max_amount_cents: 5_000_000 },
});

/** 挂单：保留当前订单与计价快照，恢复开单不生成第二张票。 */
export const orderHoldCommand: CommandDefinition<HoldInput> = defineCommand({
  name: "order.hold",
  version: "0.4.0",
  description: "Create or replace an unreceived priced order draft without a ticket or payment.",
  description_llm:
    "Save an unreceived counter draft with server catalog, pricing-policy and per-piece detail snapshots. It has no ticket, formal garments, payment or revenue until order.receive opens it.",
  input: OrderHoldInputSchema,
  risk: "R2",
  invariants: ["rbac.order_write", "order.hold_allowed", "order.server_pricing"],
  idempotent: true,
  sideEffects: ["order.held", "audit.order_event"],
  offline_mode: "grant",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [],
});

/** 撤销：必须带原因，运行时以反向分录和状态记录保持可审计。 */
export const orderCancelCommand: CommandDefinition<CancelInput> = defineCommand({
  name: "order.cancel",
  version: "0.3.0",
  description: "Cancel an open order with a mandatory reason and auditable reversal plan.",
  description_llm:
    "Cancel one open order only with a non-empty reason. Runtime writes auditable reversals; it never deletes ledger rows.",
  input: OrderCancelInputSchema,
  risk: "R3",
  invariants: ["rbac.order_write", "order.cancel_allowed", "order.cancel_reason_required"],
  idempotent: true,
  sideEffects: ["order.cancelled", "payment.reversed", "audit.order_event"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [],
});

/** 读单：取衣前加载订单摘要 + 件列表（多选 partial pickup）。 */
export const orderGetQuery: QueryDefinition<GetInput> = defineQuery({
  name: "order.get",
  version: "0.3.0",
  description: "Load one order's complete counter detail or resumable draft snapshot.",
  description_llm:
    "Fetch order by id with pricing components, editable line and piece details, and formal garment status/barcode/rack data. Drafts can be resumed from this server-owned snapshot. PII may appear.",
  input: OrderGetInputSchema,
  // PII queries must be ≥ R2 (QueryMetadataSchema); task asked R1, schema wins.
  risk: "R2",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [{ path: "/customer_phone", strategy: "mask" }],
  max_result_rows: 1,
});

/** 订单列表：工作台/历史/欠款浏览；按营业日、状态、手机号、最低余额筛选，最新优先。 */
export const orderListQuery: QueryDefinition<ListInput> = defineQuery({
  name: "order.list",
  version: "0.2.0",
  description: "List recent store orders for workbench / history / receivables browsing.",
  description_llm:
    "Return store orders newest-first: order_id, ticket_no, status, customer_phone/name, payable/paid/balance cents, created_at, optional garment_count. Filter by store business_date, status, exact customer_phone, and/or min_balance_cents (integer fen floor on balance). Debt panel: min_balance_cents=1, limit<=50, omit business_date. Default limit 20, max 50. PII phone masked in audit.",
  input: OrderListInputSchema,
  risk: "R2",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [{ path: "/customer_phone", strategy: "mask" }],
  result_redaction: [{ path: "/orders/*/customer_phone", strategy: "mask" }],
  max_result_rows: 50,
});

/** Bounded counter lookup for ticket, pickup code, garment barcode, phone, or customer name. */
export const orderLookupQuery: QueryDefinition<LookupInput> = defineQuery({
  name: "order.lookup",
  version: "0.1.0",
  description: "Find a bounded set of counter pickup candidates by a customer-facing identifier.",
  description_llm:
    "Lookup ticket number, pickup code, garment barcode, exact mobile number, or customer-name prefix. Return no more than 20 store-scoped candidates; show a choice when more than one order matches.",
  input: OrderLookupInputSchema,
  risk: "R2",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [{ path: "/key", strategy: "mask" }],
  result_redaction: [{ path: "/orders/*/customer_phone", strategy: "mask" }],
  max_result_rows: 20,
});

export const ORDER_COMMANDS = Object.freeze([
  orderReceiveCommand,
  orderHoldCommand,
  orderCancelCommand,
  orderPickupCommand,
] as const);

export const ORDER_COMMAND_NAMES = Object.freeze(
  ORDER_COMMANDS.map((command) => command.name),
) as readonly ["order.receive", "order.hold", "order.cancel", "order.pickup"];

export const ORDER_QUERIES = Object.freeze([
  orderGetQuery,
  orderListQuery,
  orderLookupQuery,
] as const);

export const ORDER_QUERY_NAMES = Object.freeze(
  ORDER_QUERIES.map((query) => query.name),
) as readonly ["order.get", "order.list", "order.lookup"];

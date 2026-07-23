/**
 * M2 skeleton order commands + order.get / order.list queries (receive/pickup wave).
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

export const OrderStatusSchema = z.enum(["open", "closed", "cancelled"]);

export const OrderReceiveLineSchema = z.strictObject({
  service_code: ServiceCodeSchema,
  category_code: CategoryCodeSchema,
  unit_price_cents: NonNegCentsSchema,
  qty: z.number().int().positive().max(50),
  color: z.string().max(32).optional(),
  brand: z.string().max(32).optional(),
});

export const OrderReceiveInputSchema = z.strictObject({
  customer_phone: PhoneSchema.optional(),
  customer_name: z.string().min(1).max(64).optional(),
  lines: z.array(OrderReceiveLineSchema).min(1).max(40),
  /** Deposit / partial pay at receive; must be ≤ payable (domain enforces). */
  paid_cents: NonNegCentsSchema,
  note: z.string().max(256).optional(),
});

export const OrderPickupInputSchema = z.strictObject({
  order_id: z.uuid(),
  /** Empty array = all pickable garments on the order. */
  garment_ids: z.array(z.uuid()).max(200),
  collect_cents: NonNegCentsSchema,
});

export const OrderGetInputSchema = z.strictObject({
  order_id: z.uuid(),
});

export const OrderListInputSchema = z.strictObject({
  /** UTC business day of created_at (YYYY-MM-DD). Omit = all days. */
  business_date: BusinessDateSchema.optional(),
  status: OrderStatusSchema.optional(),
  /** Exact match on order.customer_phone after PhoneSchema normalize. */
  customer_phone: PhoneSchema.optional(),
  /** Hard row cap (handler default 20; must not exceed max_result_rows 50). */
  limit: z.number().int().positive().max(50).optional(),
});

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
  ticket_no: string;
  status: "open" | "closed" | "cancelled";
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

type ReceiveInput = typeof OrderReceiveInputSchema;
type PickupInput = typeof OrderPickupInputSchema;
type GetInput = typeof OrderGetInputSchema;
type ListInput = typeof OrderListInputSchema;

/** 开单：生成 order + order_lines 语义 + 按 qty 拆 garments（runtime）。 */
export const orderReceiveCommand: CommandDefinition<ReceiveInput> = defineCommand({
  name: "order.receive",
  version: "0.1.0",
  description: "Create an open order with line items expanded into garments (receive).",
  description_llm:
    "Open a counter order: expand each line qty into garments at received status. Integer cents only.",
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
  version: "0.1.0",
  description: "Mark selected garments picked up and record cash collection.",
  description_llm:
    "Pickup garments by id (or all pickable). collect_cents settles balance; status must allow picked_up.",
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

/** 读单：取衣前加载订单摘要 + 件列表（多选 partial pickup）。 */
export const orderGetQuery: QueryDefinition<GetInput> = defineQuery({
  name: "order.get",
  version: "0.1.0",
  description: "Load one order summary and its garments for counter pickup.",
  description_llm:
    "Fetch order by id with garment list (id, barcode, status, line_index, seq, unit_price_cents). PII may appear.",
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

/** 订单列表：工作台/历史浏览；按营业日、状态、手机号筛选，最新优先。 */
export const orderListQuery: QueryDefinition<ListInput> = defineQuery({
  name: "order.list",
  version: "0.1.0",
  description: "List recent store orders for workbench / history browsing.",
  description_llm:
    "Return store orders newest-first: order_id, ticket_no, status, customer_phone/name, payable/paid/balance cents, created_at, optional garment_count. Filter by UTC business_date, status, and/or exact customer_phone. Default limit 20, max 50. PII phone masked in audit.",
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

export const ORDER_COMMANDS = Object.freeze([orderReceiveCommand, orderPickupCommand] as const);

export const ORDER_COMMAND_NAMES = Object.freeze(
  ORDER_COMMANDS.map((command) => command.name),
) as readonly ["order.receive", "order.pickup"];

export const ORDER_QUERIES = Object.freeze([orderGetQuery, orderListQuery] as const);

export const ORDER_QUERY_NAMES = Object.freeze(
  ORDER_QUERIES.map((query) => query.name),
) as readonly ["order.get", "order.list"];

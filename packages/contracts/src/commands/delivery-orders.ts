import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_EPOCH_SECONDS = 4_294_967_295;
const VersionSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const EpochSchema = z.number().int().nonnegative().max(MAX_EPOCH_SECONDS);

export const DeliveryCollectionMethodSchema = z.enum(["pickup", "store_dropoff"]);
export const DeliveryReturnMethodSchema = z.enum(["delivery", "self_pickup"]);
export const DeliveryOrderStatusSchema = z.enum([
  "pickup_scheduled",
  "pickup_in_progress",
  "picked_up",
  "at_store",
  "return_scheduled",
  "return_in_progress",
  "self_pickup_ready",
  "completed",
  "cancelled",
]);
export const DeliveryOrderCancellationReasonSchema = z.enum([
  "customer_request",
  "store_request",
  "appointment_cancelled",
  "duplicate",
  "other",
]);

export const DeliveryOrderSchema = z.strictObject({
  delivery_order_id: z.uuid(),
  laundry_order_id: z.uuid(),
  customer_id: z.uuid(),
  collection_method: DeliveryCollectionMethodSchema,
  return_method: DeliveryReturnMethodSchema,
  pickup_appointment_id: z.uuid().nullable(),
  return_appointment_id: z.uuid().nullable(),
  pickup_fee_cents: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
  return_fee_cents: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
  total_fee_cents: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
  status: DeliveryOrderStatusSchema,
  version: VersionSchema,
  created_at: EpochSchema,
  updated_at: EpochSchema,
  completed_at: EpochSchema.nullable(),
  cancelled_at: EpochSchema.nullable(),
  cancellation_reason: DeliveryOrderCancellationReasonSchema.nullable(),
});

export const DeliveryOrderCreateInputSchema = z
  .strictObject({
    laundry_order_id: z.uuid(),
    customer_id: z.uuid(),
    collection_method: DeliveryCollectionMethodSchema,
    return_method: DeliveryReturnMethodSchema,
    pickup_appointment_id: z.uuid().optional(),
    return_appointment_id: z.uuid().optional(),
  })
  .superRefine((input, context) => {
    const pickupMatches =
      (input.collection_method === "pickup") === (input.pickup_appointment_id !== undefined);
    const returnMatches =
      (input.return_method === "delivery") === (input.return_appointment_id !== undefined);
    if (!pickupMatches) {
      context.addIssue({
        code: "custom",
        path: ["pickup_appointment_id"],
        message: "Pickup collection requires exactly one pickup appointment",
      });
    }
    if (!returnMatches) {
      context.addIssue({
        code: "custom",
        path: ["return_appointment_id"],
        message: "Delivery return requires exactly one return appointment",
      });
    }
    if (input.collection_method === "store_dropoff" && input.return_method === "self_pickup") {
      context.addIssue({
        code: "custom",
        path: ["return_method"],
        message: "A delivery order must contain at least one delivery leg",
      });
    }
  });

export const DeliveryOrderTransitionInputSchema = z
  .strictObject({
    delivery_order_id: z.uuid(),
    customer_id: z.uuid(),
    expected_version: VersionSchema,
    target_status: DeliveryOrderStatusSchema,
    cancellation_reason: DeliveryOrderCancellationReasonSchema.optional(),
  })
  .superRefine((input, context) => {
    if ((input.target_status === "cancelled") !== (input.cancellation_reason !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["cancellation_reason"],
        message: "Only cancellation transitions require a controlled reason",
      });
    }
  });

export const DeliveryOrderGetInputSchema = z.strictObject({ delivery_order_id: z.uuid() });
export const DeliveryOrdersListInputSchema = z.strictObject({
  customer_id: z.uuid().optional(),
  laundry_order_id: z.uuid().optional(),
  status: DeliveryOrderStatusSchema.optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export const DeliveryOrderMutationResultSchema = z.strictObject({
  delivery_order: DeliveryOrderSchema,
});
export const DeliveryOrderGetResultSchema = DeliveryOrderMutationResultSchema;
export const DeliveryOrdersListResultSchema = z.strictObject({
  delivery_orders: z.array(DeliveryOrderSchema).max(100),
});

const resultRedaction = Object.freeze([
  { path: "/delivery_order/customer_id", strategy: "mask" as const },
]);

export const deliveryOrderCreateCommand: CommandDefinition<typeof DeliveryOrderCreateInputSchema> =
  defineCommand({
    name: "delivery.order.create",
    version: "1.0.0",
    description:
      "Bind one authoritative delivery lifecycle to a laundry order and its appointments.",
    description_llm:
      "Internal online logistics operation. Tenant, customer, fees and initial state are derived and revalidated by the server.",
    input: DeliveryOrderCreateInputSchema,
    risk: "R3",
    invariants: ["rbac.delivery_write", "delivery.order_links", "delivery.feature_enabled"],
    idempotent: true,
    sideEffects: ["delivery.order.created", "audit.delivery_event"],
    offline_mode: "denied",
    data_classification: "pii",
    input_redaction: [{ path: "/customer_id", strategy: "mask" }],
    result_redaction: resultRedaction,
  });

export const deliveryOrderTransitionCommand: CommandDefinition<
  typeof DeliveryOrderTransitionInputSchema
> = defineCommand({
  name: "delivery.order.transition",
  version: "1.0.0",
  description: "Advance one delivery order through its server-enforced optimistic lifecycle.",
  description_llm:
    "Internal online logistics operation. It never substitutes for task assignment, garment fulfillment or delivery evidence.",
  input: DeliveryOrderTransitionInputSchema,
  risk: "R3",
  invariants: ["rbac.delivery_write", "delivery.order_version", "delivery.order_transition"],
  idempotent: true,
  sideEffects: ["delivery.order.transitioned", "audit.delivery_event"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [{ path: "/customer_id", strategy: "mask" }],
  result_redaction: resultRedaction,
});

export const deliveryOrderGetQuery: QueryDefinition<typeof DeliveryOrderGetInputSchema> =
  defineQuery({
    name: "delivery.order.get",
    version: "1.0.0",
    description: "Read one current-store authoritative delivery order.",
    description_llm: "PII-linked internal logistics record. Never exposed to AI tools.",
    input: DeliveryOrderGetInputSchema,
    risk: "R2",
    invariants: ["rbac.delivery_read"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "pii",
    input_redaction: [],
    result_redaction: resultRedaction,
    max_result_rows: 1,
  });

export const deliveryOrdersListQuery: QueryDefinition<typeof DeliveryOrdersListInputSchema> =
  defineQuery({
    name: "delivery.orders.list",
    version: "1.0.0",
    description: "List a bounded current-store delivery order worklist.",
    description_llm: "PII-linked internal logistics worklist. Never exposed to AI tools.",
    input: DeliveryOrdersListInputSchema,
    risk: "R2",
    invariants: ["rbac.delivery_read"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "pii",
    input_redaction: [{ path: "/customer_id", strategy: "mask" }],
    result_redaction: [{ path: "/delivery_orders", strategy: "remove" }],
    max_result_rows: 100,
  });

export const DELIVERY_ORDER_COMMANDS = Object.freeze([
  deliveryOrderCreateCommand,
  deliveryOrderTransitionCommand,
] as const);
export const DELIVERY_ORDER_QUERIES = Object.freeze([
  deliveryOrderGetQuery,
  deliveryOrdersListQuery,
] as const);
export const DELIVERY_ORDER_COMMAND_NAMES = Object.freeze(
  DELIVERY_ORDER_COMMANDS.map(({ name }) => name),
);
export const DELIVERY_ORDER_QUERY_NAMES = Object.freeze(
  DELIVERY_ORDER_QUERIES.map(({ name }) => name),
);

export type DeliveryOrder = z.infer<typeof DeliveryOrderSchema>;
export type DeliveryOrderStatus = z.infer<typeof DeliveryOrderStatusSchema>;
export type DeliveryOrderCancellationReason = z.infer<typeof DeliveryOrderCancellationReasonSchema>;
export type DeliveryOrderCreateInput = z.infer<typeof DeliveryOrderCreateInputSchema>;
export type DeliveryOrderTransitionInput = z.infer<typeof DeliveryOrderTransitionInputSchema>;
export type DeliveryOrdersListInput = z.infer<typeof DeliveryOrdersListInputSchema>;

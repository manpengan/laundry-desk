import { z } from "zod";

import { ExactUtcTimestampSchema } from "./primitives.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MoneySchema = z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX);
const NullableTextSchema = (max: number) => z.string().min(1).max(max).nullable();
export const PrintPaymentMethodSchema = z.enum(["cash", "wechat", "alipay", "other", "balance"]);

export const PrintSnapshotLineSchema = z.strictObject({
  line_index: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
  service_code: z.string().min(1).max(64),
  category_code: z.string().min(1).max(64),
  unit_price_cents: MoneySchema,
  qty: z.number().int().positive().max(POSTGRES_INTEGER_MAX),
  line_total_cents: MoneySchema,
  color: NullableTextSchema(64),
  brand: NullableTextSchema(128),
});

export const PrintSnapshotTotalsSchema = z.strictObject({
  original_cents: MoneySchema,
  discount_cents: MoneySchema,
  addon_cents: MoneySchema,
  urgent_cents: MoneySchema,
  freight_cents: MoneySchema,
  payable_cents: MoneySchema,
  paid_cents: MoneySchema,
  balance_cents: MoneySchema,
});

/** Immutable, server-derived receipt data. No renderer field participates in this snapshot. */
export const PrintSnapshotSchema = z.strictObject({
  version: z.literal(1),
  store_name: z.string().min(1).max(128),
  store_phone: NullableTextSchema(32),
  order_id: z.uuid(),
  ticket_no: z.string().min(1).max(64),
  received_at: ExactUtcTimestampSchema,
  customer_name: NullableTextSchema(128),
  customer_phone: NullableTextSchema(32),
  note: NullableTextSchema(1_000),
  lines: z.array(PrintSnapshotLineSchema).min(1).max(500),
  totals: PrintSnapshotTotalsSchema,
  payment_methods: z
    .array(PrintPaymentMethodSchema)
    .max(5)
    .refine((methods) => new Set(methods).size === methods.length, {
      message: "Print payment methods must be unique",
    }),
});

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type PrintSnapshot = DeepReadonly<z.output<typeof PrintSnapshotSchema>>;

import { z } from "zod";
import { defineCommand, type CommandDefinition } from "./registry/definitions.js";

export const PaymentChannelSchema = z.enum(["wechat", "alipay"]);
const Cents = z.number().int().positive().max(5_000_000);
const Pem = z.string().min(128).max(8192);
const Callback = z
  .url()
  .max(512)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  });
export const PaymentWechatCredentialSchema = z.strictObject({
  channel: z.literal("wechat"),
  appId: z.string().regex(/^wx[A-Za-z0-9]{16}$/u),
  merchantId: z.string().regex(/^\d{6,20}$/u),
  merchantSerial: z.string().regex(/^[A-Fa-f0-9]{16,64}$/u),
  privateKey: Pem,
  platformKeyId: z.string().regex(/^PUB_KEY_ID_\d{8,64}$/u),
  platformPublicKey: Pem,
  apiV3Key: z.string().regex(/^[\x21-\x7e]{32}$/u),
  notifyUrl: Callback,
});
export const PaymentAlipayCredentialSchema = z.strictObject({
  channel: z.literal("alipay"),
  appId: z.string().regex(/^\d{16,32}$/u),
  sellerId: z.string().regex(/^\d{16,32}$/u),
  privateKey: Pem,
  platformPublicKey: Pem,
  notifyUrl: Callback,
});
export const PaymentCredentialSchema = z.discriminatedUnion("channel", [
  PaymentWechatCredentialSchema,
  PaymentAlipayCredentialSchema,
]);
export const PaymentChannelSettingsRequestSchema = z
  .strictObject({
    channel: PaymentChannelSchema,
    expected_version: z.number().int().min(0).max(2_147_483_646),
    enabled: z.boolean(),
    password: z.string().min(1).max(256),
    credential: PaymentCredentialSchema.optional(),
  })
  .refine((value) => value.credential === undefined || value.credential.channel === value.channel);
export const PaymentChannelSettingsViewSchema = z.strictObject({
  custody_available: z.boolean(),
  settings: z
    .array(
      z.strictObject({
        channel: PaymentChannelSchema,
        version: z.number().int().positive(),
        enabled: z.boolean(),
        app_id: z.string().max(32),
        merchant_id: z.string().max(32),
        credential_present: z.literal(true),
      }),
    )
    .max(2),
});
export const ChannelCheckoutInputSchema = z.strictObject({
  idempotency_key: z.uuid(),
  order_id: z.uuid(),
  channel: PaymentChannelSchema,
});
export const ChannelIntentIdSchema = z.strictObject({ intent_id: z.uuid() });
export const ChannelIntentViewSchema = z.strictObject({
  intent_id: z.uuid(),
  order_id: z.uuid().nullable(),
  purpose: z.enum(["order", "topup"]),
  channel: PaymentChannelSchema,
  amount_cents: Cents,
  state: z.enum(["created", "pending", "unknown", "paid", "closed", "needs_review"]),
  qr_url: z.string().max(1024).nullable(),
  payment_id: z.uuid().nullable(),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  error_code: z.string().max(64).nullable(),
});
export const ChannelIntentsViewSchema = z.strictObject({
  intents: z.array(ChannelIntentViewSchema).max(100),
});
export const ChannelRefundInputSchema = z.strictObject({
  intent_id: z.uuid(),
  amount_cents: Cents,
  reason: z.enum(["customer_request", "duplicate_payment", "service_cancelled", "other"]),
});
export const paymentChannelRefundCommand: CommandDefinition<typeof ChannelRefundInputSchema> =
  defineCommand({
    name: "payment.channel.refund",
    version: "1.0.0",
    description:
      "Approve a provider refund request; only a verified provider result appends the refund ledger.",
    description_llm:
      "Online R4 refund. Approval reserves refundability and creates one durable merchant refund reference. Never assume a submitted refund has completed.",
    input: ChannelRefundInputSchema,
    risk: "R4",
    invariants: ["rbac.payment_refund", "payment.original_exists", "payment.append_only"],
    idempotent: true,
    sideEffects: ["payment.channel.refund_requested", "audit.payment_event"],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: [],
    result_redaction: [],
    size_measures: { amount: { kind: "field", path: "/amount_cents" } },
    hard_limits: { max_amount_cents: 5_000_000 },
  });
export const ChannelRefundViewSchema = z.strictObject({
  refund_id: z.uuid(),
  intent_id: z.uuid(),
  amount_cents: Cents,
  state: z.enum(["created", "pending", "unknown", "refunded", "failed", "needs_review"]),
  payment_id: z.uuid().nullable(),
  error_code: z.string().max(64).nullable(),
});
export const ChannelReconcileInputSchema = z.strictObject({
  channel: PaymentChannelSchema,
  business_date: z.iso.date(),
  rows: z
    .array(
      z.strictObject({
        merchant_order: z.string().regex(/^[A-Za-z0-9_]{1,32}$/u),
        provider_order: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
        amount_cents: Cents,
        kind: z.enum(["payment", "refund"]),
        merchant_refund: z
          .string()
          .regex(/^[A-Za-z0-9_]{1,32}$/u)
          .nullable(),
      }),
    )
    .max(10000),
});
export const ChannelListInputSchema = z.strictObject({ order_id: z.uuid().optional() });
/** ADR-85 r1: which channels a collector may offer; no merchant identifiers. */
export const ChannelAvailabilityViewSchema = z.strictObject({
  channels: z.array(z.strictObject({ channel: PaymentChannelSchema, enabled: z.boolean() })).max(2),
  /** Settings, refunds, reconciliation and write-offs stay administrator-only. */
  can_manage: z.boolean(),
});
/**
 * ADR-85 r1: administrator write-off of an expired intent no provider answer can settle.
 * Requires the current administrator password and a reason kept in the audit.
 */
export const ChannelResolveInputSchema = z.strictObject({
  intent_id: z.uuid(),
  note: z.string().trim().min(4).max(200),
  password: z.string().min(1).max(256),
});
export const ChannelRefundIdSchema = z.strictObject({ refund_id: z.uuid() });
export const ChannelRefundsViewSchema = z.strictObject({
  refunds: z.array(ChannelRefundViewSchema).max(100),
});
export const ChannelReconcileViewSchema = z.strictObject({
  reconciliation_id: z.uuid(),
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  matched_count: z.number().int().nonnegative(),
  mismatches: z
    .array(
      z.strictObject({
        merchant_order: z.string(),
        merchant_refund: z.string().nullable(),
        reason: z.enum([
          "missing_local",
          "missing_provider",
          "amount_mismatch",
          "state_mismatch",
          "reference_mismatch",
          "duplicate_provider",
        ]),
      }),
    )
    .max(10000),
});

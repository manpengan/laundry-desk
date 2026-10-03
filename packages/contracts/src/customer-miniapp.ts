import { z } from "zod";
import {
  CustomerPortalProfileUpdateInputSchema,
  CUSTOMER_SELF_SERVICE_QUERY_NAMES,
} from "./commands/customer-self-service.js";
import { DeliveryPolicySchema } from "./commands/delivery-policy.js";
import { DeliveryAppointmentSchema } from "./commands/delivery-appointments.js";

const Epoch = z.number().int().nonnegative().max(4_294_967_295);
const Version = z.number().int().positive().max(2_147_483_647);
const Cents = z.number().int().nonnegative().max(5_000_000);
const PositiveCents = Cents.positive();
const Idempotency = z.uuid();
const Template = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
export const MiniappPublicSchema = z.strictObject({
  store_name: z.string().trim().min(1).max(128),
  app_id: z.string().regex(/^wx[A-Za-z0-9]{16}$/u),
  subscription_template_ids: z.array(Template).max(3),
});
export const MiniappLoginInputSchema = z.strictObject({
  code: z.string().min(1).max(256),
  phone_code: z.string().min(1).max(256).optional(),
});
export const MiniappSessionSchema = z.union([
  z.strictObject({ binding_required: z.literal(true) }),
  z.strictObject({
    authenticated: z.literal(true),
    access_token: z.string().regex(/^m1\.[A-Za-z0-9_-]{43}$/u),
    expires_at: Epoch,
  }),
]);
export const MiniappQueryInputSchema = z.strictObject({
  name: z.enum(CUSTOMER_SELF_SERVICE_QUERY_NAMES),
  input: z.record(z.string(), z.unknown()),
});
export const MiniappOptionsSchema = z.strictObject({
  timezone: z.string().min(1).max(64),
  delivery_policy: DeliveryPolicySchema.nullable(),
  topup_bonus_rules: z
    .array(z.strictObject({ min_topup_cents: PositiveCents, bonus_cents: Cents }))
    .max(100),
  wechat_pay_enabled: z.boolean(),
  delegation_enabled: z.boolean(),
});
export const MiniappAppointmentsSchema = z.strictObject({
  appointments: z.array(DeliveryAppointmentSchema).max(100),
});
export const MiniappAppointmentResultSchema = z.strictObject({
  appointment: DeliveryAppointmentSchema,
});
export const MiniappJsapiCheckoutSchema = z.strictObject({
  kind: z.literal("jsapi"),
  appId: z.string().regex(/^wx[A-Za-z0-9]{16}$/u),
  timeStamp: z.string().regex(/^\d{10}$/u),
  nonceStr: z.string().min(16).max(32),
  package: z.string().regex(/^prepay_id=[A-Za-z0-9_-]{1,128}$/u),
  signType: z.literal("RSA"),
  paySign: z.string().regex(/^[A-Za-z0-9+/]{342,684}={0,2}$/u),
});
export const MiniappPaymentIntentSchema = z.strictObject({
  intent_id: z.uuid(),
  state: z.enum(["created", "pending", "unknown", "paid", "closed", "needs_review"]),
  amount_cents: PositiveCents,
  checkout: MiniappJsapiCheckoutSchema.nullable(),
});
export const MiniappPaymentListSchema = z.strictObject({
  intents: z.array(MiniappPaymentIntentSchema).max(20),
});
export const MiniappBalancePaymentSchema = z.strictObject({
  order_id: z.uuid(),
  paid_cents: Cents,
  balance_cents: Cents,
  payment_id: z.uuid(),
});
export const MiniappBenefitAppliedSchema = z.strictObject({
  applied: z.literal(true),
  entity_id: z.uuid(),
});
export const MiniappSubscriptionInputSchema = z.strictObject({
  template_ids: z.array(Template).min(1).max(3),
});
export const MINIAPP_TRANSACTION_SCHEMAS = Object.freeze({
  options: z.strictObject({}),
  "appointments/list": z.strictObject({}),
  "appointments/create": z.strictObject({
    idempotency_key: Idempotency,
    address_id: z.uuid(),
    direction: z.enum(["pickup", "return"]),
    service_area_code: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/u),
    requested_start_at: Epoch,
    expected_policy_version: Version,
  }),
  "appointments/cancel": z.strictObject({
    idempotency_key: Idempotency,
    appointment_id: z.uuid(),
    expected_version: Version,
  }),
  "payment/create": z.strictObject({ idempotency_key: Idempotency, order_id: z.uuid() }),
  "topup/create": z.strictObject({ idempotency_key: Idempotency, amount_cents: PositiveCents }),
  "payment/status": z.strictObject({ intent_id: z.uuid() }),
  "payment/list": z.strictObject({}),
  "balance/pay": z.strictObject({ idempotency_key: Idempotency, order_id: z.uuid() }),
  "benefits/coupon": z.strictObject({
    idempotency_key: Idempotency,
    order_id: z.uuid(),
    asset_id: z.uuid(),
  }),
  "benefits/punch": z.strictObject({
    idempotency_key: Idempotency,
    order_id: z.uuid(),
    asset_id: z.uuid(),
    uses: z.number().int().min(1).max(99),
  }),
  "benefits/points": z.strictObject({
    idempotency_key: Idempotency,
    order_id: z.uuid(),
    points: z.number().int().min(1).max(1_000_000),
  }),
  "profile/update": CustomerPortalProfileUpdateInputSchema,
});
export type MiniappTransactionAction = keyof typeof MINIAPP_TRANSACTION_SCHEMAS;

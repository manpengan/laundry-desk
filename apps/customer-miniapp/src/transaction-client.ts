import {
  CustomerPortalProfileResultSchema,
  CustomerPortalProfileUpdateInputSchema,
  DeliveryAppointmentsListResultSchema,
  DeliveryAppointmentMutationResultSchema,
  MiniappOptionsSchema as OptionsSchema,
  MiniappPaymentIntentSchema as PaymentSchema,
  MiniappBenefitAppliedSchema as AppliedSchema,
  MiniappBalancePaymentSchema as BalanceSchema,
  MINIAPP_TRANSACTION_SCHEMAS,
  MiniappPaymentListSchema,
  type MiniappTransactionAction,
} from "@laundry/contracts";
import { z } from "zod";
import type { MiniappClient } from "./client.js";
import { requestId, type WxPort } from "./wx-port.js";

export type PaymentIntent = z.infer<typeof PaymentSchema>;
export type TransactionOptions = z.infer<typeof OptionsSchema>;
export function createTransactions(client: MiniappClient, wx: WxPort) {
  // A failed response reuses the same key and payload; no blind automatic mutation retry.
  let keys = new Map<string, string>();
  const mutation = async <T>(
    action: MiniappTransactionAction,
    input: Readonly<Record<string, unknown>>,
    schema: z.ZodType<T>,
  ) => {
    const epoch = client.authorityEpoch();
    const fingerprint = JSON.stringify([action, input]);
    let key = keys.get(fingerprint);
    if (!key) {
      key = await requestId(wx);
      keys = new Map(keys).set(fingerprint, key);
    }
    if (epoch !== client.authorityEpoch()) throw new Error("会话已结束");
    const body = MINIAPP_TRANSACTION_SCHEMAS[action].parse({ ...input, idempotency_key: key });
    const data = await client.transaction(`transactions/${action}`, body, schema);
    keys = new Map([...keys].filter(([existing]) => existing !== fingerprint));
    return data;
  };
  return Object.freeze({
    clear: () => {
      keys = new Map();
    },
    options: () => client.transaction("transactions/options", {}, OptionsSchema),
    payments: () => client.transaction("transactions/payment/list", {}, MiniappPaymentListSchema),
    appointments: () =>
      client.transaction(
        "transactions/appointments/list",
        {},
        DeliveryAppointmentsListResultSchema,
      ),
    book: (
      input: Readonly<{
        address_id: string;
        direction: "pickup" | "return";
        service_area_code: string;
        requested_start_at: number;
        expected_policy_version: number;
      }>,
    ) => mutation("appointments/create", input, DeliveryAppointmentMutationResultSchema),
    cancel: (appointment_id: string, expected_version: number) =>
      mutation(
        "appointments/cancel",
        { appointment_id, expected_version },
        DeliveryAppointmentMutationResultSchema,
      ),
    pay: (order_id: string) => mutation("payment/create", { order_id }, PaymentSchema),
    topup: (amount_cents: number) => mutation("topup/create", { amount_cents }, PaymentSchema),
    status: (intent_id: string) =>
      client.transaction("transactions/payment/status", { intent_id }, PaymentSchema),
    balance: (order_id: string) => mutation("balance/pay", { order_id }, BalanceSchema),
    coupon: (order_id: string, asset_id: string) =>
      mutation("benefits/coupon", { order_id, asset_id }, AppliedSchema),
    punch: (order_id: string, asset_id: string, uses: number) =>
      mutation("benefits/punch", { order_id, asset_id, uses }, AppliedSchema),
    points: (order_id: string, points: number) =>
      mutation("benefits/points", { order_id, points }, AppliedSchema),
    profile: (input: unknown) =>
      client.transaction(
        "transactions/profile/update",
        CustomerPortalProfileUpdateInputSchema.parse(input),
        CustomerPortalProfileResultSchema,
      ),
    subscribe: (template_ids: readonly string[]) =>
      client.transaction(
        "subscriptions",
        { template_ids },
        z.strictObject({ accepted: z.literal(true) }),
      ),
  });
}

export async function invokePayment(
  wx: WxPort,
  intent: PaymentIntent,
): Promise<"submitted" | "cancelled"> {
  if (intent.state === "paid") return "submitted";
  if (intent.checkout === null || !["created", "pending"].includes(intent.state))
    throw new Error("付款结果待确认，请刷新查询，不要重复付款");
  if (intent.checkout.appId !== wx.getAccountInfoSync().miniProgram.appId)
    throw new Error("付款小程序配置不匹配，请联系门店");
  const checkout = intent.checkout;
  return new Promise((resolve, reject) =>
    wx.requestPayment({
      timeStamp: checkout.timeStamp,
      nonceStr: checkout.nonceStr,
      package: checkout.package,
      signType: checkout.signType,
      paySign: checkout.paySign,
      success: () => resolve("submitted"),
      fail: (error) =>
        /cancel/iu.test(error.errMsg ?? "")
          ? resolve("cancelled")
          : reject(new Error("微信支付未完成，请查询处理结果")),
    }),
  );
}

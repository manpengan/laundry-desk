import { DesktopPaymentChannelInputSchema, MiniappSettingsSaveSchema } from "@laundry/contracts";

const id = "10000000-0000-4000-8000-000000000001";
export const paymentInputs = Object.freeze(
  [
    { operation: "settings.get" },
    {
      operation: "settings.save",
      body: { channel: "wechat", expected_version: 1, enabled: false, password: "fixture" },
    },
    { operation: "checkout", body: { order_id: id, channel: "wechat", idempotency_key: id } },
    { operation: "list", body: {} },
    { operation: "status", body: { intent_id: id } },
    { operation: "close", body: { intent_id: id } },
    { operation: "refunds.list", body: {} },
    { operation: "refunds.status", body: { refund_id: id } },
    { operation: "reconcile", body: { channel: "wechat", business_date: "2026-10-03", rows: [] } },
  ].map((input) => DesktopPaymentChannelInputSchema.parse(input)),
);

export const miniappSettingsBody = MiniappSettingsSaveSchema.parse({
  password: "fixture",
  expected_version: 1,
  enabled: false,
  transactions_enabled: false,
  delegated_staff_id: null,
  app_id: "wx1234567890abcdef",
  subscription_template_ids: [],
});

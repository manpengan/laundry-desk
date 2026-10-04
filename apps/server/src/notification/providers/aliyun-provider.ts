import type {
  NotificationProviderSettings,
  NotificationDeliveryCapabilityResult,
} from "@laundry/contracts";
import { NotificationDeliveryCapabilityResultSchema } from "@laundry/contracts";
import { formatBalanceYuan } from "@laundry/domain";
import type { NotificationProvider } from "../delivery-types.js";
import { DISABLED_NOTIFICATION_CAPABILITY } from "../delivery-provider.js";
import type { createAliyunSmsClient } from "./aliyun-client.js";

export function aliyunProviderCode(settings: NotificationProviderSettings): string {
  return `aliyun_sms_v${settings.version}`;
}
export function aliyunCapability(
  settings: NotificationProviderSettings | null,
): NotificationDeliveryCapabilityResult {
  if (settings === null || !settings.enabled) return DISABLED_NOTIFICATION_CAPABILITY;
  return NotificationDeliveryCapabilityResultSchema.parse({
    state: "external",
    provider_code: aliyunProviderCode(settings),
    channels: { manual: "available", sms: "external", wechat: "disabled" },
    templates: [{ code: "pickup_reminder_v1", version: 1, channel: "sms" }],
    max_batch: 50,
    r4_threshold: 10,
    unit_cost_cents: settings.unit_cost_cents,
    max_batch_cost_cents: settings.max_batch_cost_cents,
  });
}
export function createAliyunNotificationProvider(
  settings: NotificationProviderSettings,
  client: ReturnType<typeof createAliyunSmsClient>,
  stillEnabled: () => Promise<boolean>,
): NotificationProvider {
  return Object.freeze({
    code: aliyunProviderCode(settings),
    assurance: "external",
    channel: "sms",
    maxBatchSize: 50,
    supportsIdempotency: false,
    deliverySemantics: "at_most_once",
    supportsCancellation: true,
    supportsReceipts: true,
    unitCostCents: settings.unit_cost_cents,
    maxBatchCostCents: settings.max_batch_cost_cents,
    async send(input) {
      if (!(await stillEnabled()))
        return Object.freeze({
          outcome: "permanent_failure",
          errorCode: "PROVIDER_CONFIGURATION_CHANGED",
          providerRef: null,
          costCents: 0,
        });
      const cents = input.parameters.balance_cents;
      const result = await client.send(
        {
          phone: input.recipient,
          deliveryId: input.deliveryId,
          signName: settings.sign_name,
          templateCode: settings.template_code,
          parameters: {
            tickets: input.parameters.tickets,
            garment_count: input.parameters.garment_count,
            // An unusable amount fails the client's validation as a local rejection.
            balance_yuan: /^\d{1,12}$/u.test(cents) ? formatBalanceYuan(Number(cents)) : "",
          },
        },
        input.signal,
      );
      if (result.status === "accepted")
        return Object.freeze({
          outcome: "accepted",
          errorCode: null,
          providerRef: result.bizId,
          costCents: settings.unit_cost_cents,
        });
      // ADR-91 §2: a request Aliyun never received, or explicitly refused, ends with its reason
      // and releases the reservation. At-most-once delivery forbids an automatic resend, so
      // staff take those orders back to the manual list. Only a request Aliyun may have
      // accepted stays uncertain and keeps its reservation.
      return Object.freeze({
        outcome: result.status === "uncertain" ? "uncertain" : "permanent_failure",
        errorCode: result.code,
        providerRef: null,
        costCents: 0,
      });
    },
  });
}

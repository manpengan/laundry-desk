import type {
  NotificationProviderSettings,
  NotificationDeliveryCapabilityResult,
} from "@laundry/contracts";
import { NotificationDeliveryCapabilityResultSchema } from "@laundry/contracts";
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
      const result = await client.send(
        {
          phone: input.recipient,
          deliveryId: input.deliveryId,
          signName: settings.sign_name,
          templateCode: settings.template_code,
          parameters: input.parameters,
        },
        input.signal,
      );
      return result.status === "accepted"
        ? Object.freeze({
            outcome: "accepted",
            errorCode: null,
            providerRef: result.bizId,
            costCents: settings.unit_cost_cents,
          })
        : Object.freeze({
            outcome: result.status === "uncertain" ? "uncertain" : "permanent_failure",
            errorCode: result.code,
            providerRef: null,
            costCents: 0,
          });
    },
  });
}

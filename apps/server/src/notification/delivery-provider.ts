import { createHash } from "node:crypto";

import {
  NotificationDeliveryCapabilityResultSchema,
  type NotificationDeliveryCapabilityResult,
} from "@laundry/contracts";

import type { NotificationProvider } from "./delivery-types.js";

export const DISABLED_NOTIFICATION_CAPABILITY: NotificationDeliveryCapabilityResult =
  NotificationDeliveryCapabilityResultSchema.parse({
    state: "disabled",
    provider_code: null,
    channels: { manual: "available", sms: "disabled", wechat: "disabled" },
    templates: [],
    max_batch: 50,
    r4_threshold: 10,
    unit_cost_cents: null,
    max_batch_cost_cents: null,
  });

export const SOFTWARE_ONLY_NOTIFICATION_CAPABILITY: NotificationDeliveryCapabilityResult =
  NotificationDeliveryCapabilityResultSchema.parse({
    state: "software_only",
    provider_code: "software_only_fake",
    channels: { manual: "available", sms: "software_only", wechat: "disabled" },
    templates: [{ code: "pickup_reminder_v1", version: 1, channel: "sms" }],
    max_batch: 50,
    r4_threshold: 10,
    unit_cost_cents: 0,
    max_batch_cost_cents: 0,
  });

/** Deterministic, no-network adapter. Acceptance means simulation only. */
export function createSoftwareOnlyNotificationProvider(): NotificationProvider {
  return Object.freeze({
    code: "software_only_fake",
    assurance: "software_only" as const,
    supportsIdempotency: true,
    supportsCancellation: true,
    unitCostCents: 0,
    maxBatchCostCents: 0,
    send: async (input) =>
      Object.freeze({
        outcome: "accepted" as const,
        errorCode: null,
        providerRef: createHash("sha256")
          .update(`software-only:${input.deliveryId}`, "utf8")
          .digest("hex"),
        costCents: 0,
      }),
  });
}

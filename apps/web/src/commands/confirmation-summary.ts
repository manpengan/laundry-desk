import {
  DeliveryTaskConfirmationSummarySchema,
  FactoryHandoffConfirmationSummarySchema,
  FulfillmentOperationConfirmationSummarySchema,
  NotificationDeliveryConfirmationSummarySchema,
  DeliveryPolicyConfirmationSummarySchema,
} from "@laundry/contracts";

import { readMemberTopupConfirmationSummary } from "./member-topup-confirmation.js";
import type { ConfirmationSummary } from "./types.js";

export function readConfirmationSummary(value: unknown): ConfirmationSummary | null {
  const member = readMemberTopupConfirmationSummary(value);
  if (member !== null) return member;
  const notification = NotificationDeliveryConfirmationSummarySchema.safeParse(value);
  if (notification.success) {
    return Object.freeze({
      ...notification.data,
      ticket_nos: Object.freeze([...notification.data.ticket_nos]),
      garment_statuses: Object.freeze([...notification.data.garment_statuses]),
    });
  }
  const deliveryPolicy = DeliveryPolicyConfirmationSummarySchema.safeParse(value);
  if (deliveryPolicy.success) {
    return Object.freeze({
      ...deliveryPolicy.data,
      service_areas: Object.freeze(
        deliveryPolicy.data.service_areas.map((area) => Object.freeze({ ...area })),
      ),
      weekly_windows: Object.freeze(
        deliveryPolicy.data.weekly_windows.map((window) => Object.freeze({ ...window })),
      ),
    });
  }
  const factory = FactoryHandoffConfirmationSummarySchema.safeParse(value);
  if (factory.success) {
    return Object.freeze({
      ...factory.data,
      ticket_nos: Object.freeze([...factory.data.ticket_nos]),
      barcodes: Object.freeze([...factory.data.barcodes]),
      counts: Object.freeze({ ...factory.data.counts }),
    });
  }
  const deliveryTask = DeliveryTaskConfirmationSummarySchema.safeParse(value);
  if (deliveryTask.success) return Object.freeze({ ...deliveryTask.data });
  const fulfillment = FulfillmentOperationConfirmationSummarySchema.safeParse(value);
  if (!fulfillment.success) return null;
  return Object.freeze({
    ...fulfillment.data,
    garment_ids: Object.freeze([...fulfillment.data.garment_ids]),
    ticket_nos: Object.freeze([...fulfillment.data.ticket_nos]),
    barcodes: Object.freeze([...fulfillment.data.barcodes]),
  });
}

import {
  DELIVERY_APPOINTMENT_COMMAND_NAMES,
  DELIVERY_EVIDENCE_COMMAND_NAMES,
  DELIVERY_ORDER_COMMAND_NAMES,
  DELIVERY_TASK_COMMAND_NAMES,
} from "@laundry/contracts";

export const REUSABLE_PENDING_COMMANDS: ReadonlySet<string> = new Set([
  "delivery.policy.set",
  ...DELIVERY_APPOINTMENT_COMMAND_NAMES,
  ...DELIVERY_ORDER_COMMAND_NAMES,
  ...DELIVERY_TASK_COMMAND_NAMES,
  ...DELIVERY_EVIDENCE_COMMAND_NAMES,
  "marketing.campaign.set",
  "marketing.campaign.audience.freeze",
]);

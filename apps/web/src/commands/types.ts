/**
 * Browser command bus envelope shapes (A2) for SPA clients.
 */

import type {
  DeliveryTaskConfirmationSummary,
  FactoryHandoffConfirmationSummary,
  FulfillmentOperationConfirmationSummary,
  DeliveryPolicyConfirmationSummary,
} from "@laundry/contracts";

export type MemberTopupMatchedRule = Readonly<{
  rule_id: string;
  min_topup_cents: number;
  bonus_cents: number;
}>;

export type MemberTopupConfirmationSummary = Readonly<{
  kind: "member_topup";
  principal_cents: number;
  bonus_cents: number;
  credited_cents: number;
  matched_rule: MemberTopupMatchedRule | null;
}>;

export type NotificationDeliveryConfirmationSummary = Readonly<{
  kind: "notification_delivery_batch";
  order_count: number;
  risk_window_order_count: number;
  ticket_nos: readonly string[];
  channel: "sms";
  assurance: "software_only" | "external";
  provider_code: string;
  template_code: "pickup_reminder_v1";
  template_version: number;
  estimated_cost_cents: number;
  max_cost_cents: number;
  min_age_days: 30 | 90 | 180;
  unpaid_only: boolean;
  garment_statuses: readonly ("ready" | "racked")[];
}>;

export type ConfirmationSummary =
  | MemberTopupConfirmationSummary
  | NotificationDeliveryConfirmationSummary
  | DeliveryPolicyConfirmationSummary
  | FactoryHandoffConfirmationSummary
  | FulfillmentOperationConfirmationSummary
  | DeliveryTaskConfirmationSummary;

export type CommandErrorDetail = Readonly<{
  kind?: string;
  confirm_ref?: string;
  message?: string;
  summary?: ConfirmationSummary;
}>;

export type CommandFailure = Readonly<{
  code: string;
  detail?: CommandErrorDetail;
  message?: string;
}>;

export type CommandResult<T = unknown> =
  Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: CommandFailure }>;

export type CommandPort = Readonly<{
  execute: <T = unknown>(
    name: string,
    body?: unknown,
    options?: Readonly<{ confirmRef?: string }>,
  ) => Promise<CommandResult<T>>;
}>;

/** Read-only query bus port (POST /v1/queries/:name). Same result envelope as commands. */
export type QueryPort = Readonly<{
  execute: <T = unknown>(name: string, body?: unknown) => Promise<CommandResult<T>>;
}>;

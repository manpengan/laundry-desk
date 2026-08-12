import {
  DeliveryAppointmentCancelInputSchema,
  DeliveryAppointmentAddressesListResultSchema,
  DeliveryAppointmentCreateInputSchema,
  DeliveryAppointmentRescheduleInputSchema,
  DeliveryAppointmentsListResultSchema,
  type DeliveryAppointment,
  type DeliveryAppointmentAddress,
  type DeliveryAppointmentCancelInput,
} from "@laundry/contracts";

import { epochFromLocalDateTime } from "./delivery-policy-model.js";

export type DeliveryAppointmentView = Readonly<DeliveryAppointment>;
export type DeliveryAppointmentAddressView = Readonly<DeliveryAppointmentAddress>;
export type DeliveryCancellationReason = DeliveryAppointmentCancelInput["reason"];

export const DELIVERY_DIRECTION_LABELS = Object.freeze({
  pickup: "上门取件",
  return: "送回顾客",
});

export const DELIVERY_CANCELLATION_LABELS: Readonly<Record<DeliveryCancellationReason, string>> =
  Object.freeze({
    customer_request: "顾客要求取消",
    store_request: "门店要求取消",
    unreachable: "无法联系顾客",
    duplicate: "重复预约",
    other: "其他受控原因",
  });

type BuildResult =
  | Readonly<{ ok: true; body: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; message: string }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapBusResult(value: unknown): unknown {
  return isRecord(value) && "result" in value ? value.result : value;
}

function firstIssueMessage(
  issues: readonly Readonly<{ path: PropertyKey[]; message: string }>[],
): string {
  const issue = issues[0];
  return issue === undefined
    ? "预约输入无效"
    : `${issue.path.join(".") || "预约"}：${issue.message}`;
}

export function parseDeliveryAppointments(
  value: unknown,
): readonly DeliveryAppointmentView[] | null {
  const parsed = DeliveryAppointmentsListResultSchema.safeParse(unwrapBusResult(value));
  if (!parsed.success) return null;
  return Object.freeze(
    parsed.data.appointments.map((appointment) => Object.freeze({ ...appointment })),
  );
}

export function parseDeliveryAppointmentAddresses(value: unknown): Readonly<{
  customer_id: string;
  addresses: readonly DeliveryAppointmentAddressView[];
}> | null {
  const parsed = DeliveryAppointmentAddressesListResultSchema.safeParse(unwrapBusResult(value));
  if (!parsed.success) return null;
  return Object.freeze({
    customer_id: parsed.data.customer_id,
    addresses: Object.freeze(parsed.data.addresses.map((address) => Object.freeze({ ...address }))),
  });
}

export function buildDeliveryAppointmentCreate(
  customerId: string,
  addressId: string,
  direction: "pickup" | "return",
  serviceAreaCode: string,
  localDateTime: string,
  expectedPolicyVersion: number,
): BuildResult {
  const requestedStartAt = epochFromLocalDateTime(localDateTime);
  const parsed = DeliveryAppointmentCreateInputSchema.safeParse({
    customer_id: customerId,
    address_id: addressId,
    direction,
    service_area_code: serviceAreaCode,
    requested_start_at: requestedStartAt,
    expected_policy_version: expectedPolicyVersion,
  });
  return parsed.success
    ? Object.freeze({ ok: true as const, body: Object.freeze(parsed.data) })
    : Object.freeze({ ok: false as const, message: firstIssueMessage(parsed.error.issues) });
}

export function buildDeliveryAppointmentReschedule(
  appointment: DeliveryAppointmentView,
  localDateTime: string,
  expectedPolicyVersion: number,
): BuildResult {
  const requestedStartAt = epochFromLocalDateTime(localDateTime);
  const parsed = DeliveryAppointmentRescheduleInputSchema.safeParse({
    appointment_id: appointment.appointment_id,
    customer_id: appointment.customer_id,
    expected_version: appointment.version,
    expected_policy_version: expectedPolicyVersion,
    requested_start_at: requestedStartAt,
  });
  return parsed.success
    ? Object.freeze({ ok: true as const, body: Object.freeze(parsed.data) })
    : Object.freeze({ ok: false as const, message: firstIssueMessage(parsed.error.issues) });
}

export function buildDeliveryAppointmentCancel(
  appointment: DeliveryAppointmentView,
  reason: DeliveryCancellationReason,
): BuildResult {
  const parsed = DeliveryAppointmentCancelInputSchema.safeParse({
    appointment_id: appointment.appointment_id,
    customer_id: appointment.customer_id,
    expected_version: appointment.version,
    reason,
  });
  return parsed.success
    ? Object.freeze({ ok: true as const, body: Object.freeze(parsed.data) })
    : Object.freeze({ ok: false as const, message: firstIssueMessage(parsed.error.issues) });
}

export function localDateTimeFromEpoch(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1_000);
  const part = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

export function formatDeliveryAppointmentTime(epochSeconds: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(epochSeconds * 1_000));
}

export function formatDeliveryFee(feeCents: number): string {
  return `¥${(feeCents / 100).toFixed(2)}`;
}

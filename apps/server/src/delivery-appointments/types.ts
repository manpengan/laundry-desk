import {
  DeliveryAppointmentSchema,
  type DeliveryAppointment,
  DeliveryAppointmentCancellationReasonSchema,
  type DeliveryAppointmentsListInput,
  type DeliveryDirection,
} from "@laundry/contracts";
import type { z } from "zod";

export type AppointmentCancellationReason = z.infer<
  typeof DeliveryAppointmentCancellationReasonSchema
>;

export type AppointmentCreateRequest = Readonly<{
  appointment_id: string;
  org_id: string;
  store_id: string;
  staff_id: string;
  customer_id: string;
  address_id: string;
  direction: DeliveryDirection;
  service_area_code: string;
  scheduled_start_at: number;
  scheduled_end_at: number;
  fee_cents: number;
  policy_version: number;
  timezone: string;
  max_appointments_per_slot: number;
  at: number;
}>;

export type AppointmentRescheduleRequest = Readonly<{
  org_id: string;
  store_id: string;
  staff_id: string;
  appointment_id: string;
  customer_id: string;
  expected_version: number;
  direction: DeliveryDirection;
  service_area_code: string;
  scheduled_start_at: number;
  scheduled_end_at: number;
  fee_cents: number;
  policy_version: number;
  timezone: string;
  max_appointments_per_slot: number;
  at: number;
}>;

export type AppointmentCancelRequest = Readonly<{
  org_id: string;
  store_id: string;
  staff_id: string;
  appointment_id: string;
  customer_id: string;
  expected_version: number;
  reason: AppointmentCancellationReason;
  at: number;
}>;

export type AppointmentMutationFailure =
  | "address_unavailable"
  | "capacity_full"
  | "duplicate"
  | "feature_disabled"
  | "not_found"
  | "policy_changed"
  | "state_conflict";

export type AppointmentMutationResult =
  | Readonly<{ ok: true; appointment: DeliveryAppointment }>
  | Readonly<{ ok: false; reason: AppointmentMutationFailure }>;

export type AppointmentListFilter = Readonly<
  Omit<DeliveryAppointmentsListInput, "limit"> & { limit: number }
>;

export type DeliveryAppointmentStore = Readonly<{
  create: (request: AppointmentCreateRequest) => Promise<AppointmentMutationResult>;
  reschedule: (request: AppointmentRescheduleRequest) => Promise<AppointmentMutationResult>;
  cancel: (request: AppointmentCancelRequest) => Promise<AppointmentMutationResult>;
  get: (
    orgId: string,
    storeId: string,
    appointmentId: string,
  ) => Promise<DeliveryAppointment | null>;
  list: (
    orgId: string,
    storeId: string,
    filter: AppointmentListFilter,
  ) => Promise<readonly DeliveryAppointment[]>;
}>;

export function freezeAppointment(input: DeliveryAppointment): DeliveryAppointment {
  const parsed = DeliveryAppointmentSchema.safeParse(input);
  if (!parsed.success || parsed.data.scheduled_end_at <= parsed.data.scheduled_start_at) {
    throw new TypeError("Invalid delivery appointment");
  }
  const cancelled = parsed.data.status === "cancelled";
  if (
    cancelled !== (parsed.data.cancelled_at !== null) ||
    cancelled !== (parsed.data.cancellation_reason !== null)
  ) {
    throw new TypeError("Invalid delivery appointment cancellation state");
  }
  return Object.freeze({ ...parsed.data });
}

export function createdAppointment(request: AppointmentCreateRequest): DeliveryAppointment {
  return freezeAppointment({
    appointment_id: request.appointment_id,
    customer_id: request.customer_id,
    address_id: request.address_id,
    direction: request.direction,
    service_area_code: request.service_area_code,
    scheduled_start_at: request.scheduled_start_at,
    scheduled_end_at: request.scheduled_end_at,
    fee_cents: request.fee_cents,
    status: "scheduled",
    version: 1,
    policy_version: request.policy_version,
    created_at: request.at,
    updated_at: request.at,
    cancelled_at: null,
    cancellation_reason: null,
  });
}

import type { DeliveryAppointment } from "@laundry/contracts";

import {
  createdAppointment,
  freezeAppointment,
  type AppointmentCreateRequest,
  type AppointmentListFilter,
  type AppointmentMutationResult,
  type DeliveryAppointmentStore,
} from "./types.js";

const key = (orgId: string, storeId: string, appointmentId: string): string =>
  `${orgId}|${storeId}|${appointmentId}`;

type StoredAppointment = Readonly<{
  org_id: string;
  store_id: string;
  appointment: DeliveryAppointment;
}>;

function scoped(
  rows: Iterable<StoredAppointment>,
  request: Pick<AppointmentCreateRequest, "org_id" | "store_id">,
): readonly DeliveryAppointment[] {
  return [...rows]
    .filter((row) => row.org_id === request.org_id && row.store_id === request.store_id)
    .map((row) => row.appointment);
}

function capacityDecision(
  rows: readonly DeliveryAppointment[],
  input: Readonly<{
    appointment_id?: string;
    customer_id: string;
    direction: DeliveryAppointment["direction"];
    scheduled_start_at: number;
    max_appointments_per_slot: number;
  }>,
): AppointmentMutationResult | null {
  const active = rows.filter(
    (row) =>
      row.status === "scheduled" &&
      row.scheduled_start_at === input.scheduled_start_at &&
      row.appointment_id !== input.appointment_id,
  );
  if (
    active.some((row) => row.customer_id === input.customer_id && row.direction === input.direction)
  ) {
    return Object.freeze({ ok: false as const, reason: "duplicate" as const });
  }
  return active.length >= input.max_appointments_per_slot
    ? Object.freeze({ ok: false as const, reason: "capacity_full" as const })
    : null;
}

function matchesFilter(row: DeliveryAppointment, filter: AppointmentListFilter): boolean {
  return (
    (filter.customer_id === undefined || row.customer_id === filter.customer_id) &&
    (filter.status === undefined || row.status === filter.status) &&
    (filter.from_start_at === undefined || row.scheduled_start_at >= filter.from_start_at) &&
    (filter.to_start_at === undefined || row.scheduled_start_at <= filter.to_start_at)
  );
}

export function createMemoryDeliveryAppointmentStore(): DeliveryAppointmentStore {
  const appointments = new Map<string, StoredAppointment>();
  return Object.freeze({
    async create(request) {
      const decision = capacityDecision(scoped(appointments.values(), request), request);
      if (decision !== null) return decision;
      const appointment = createdAppointment(request);
      appointments.set(
        key(request.org_id, request.store_id, request.appointment_id),
        Object.freeze({
          org_id: request.org_id,
          store_id: request.store_id,
          appointment,
        }),
      );
      return Object.freeze({ ok: true as const, appointment });
    },
    async reschedule(request) {
      const appointmentKey = key(request.org_id, request.store_id, request.appointment_id);
      const stored = appointments.get(appointmentKey);
      if (stored === undefined) return Object.freeze({ ok: false, reason: "not_found" });
      const current = stored.appointment;
      if (
        current.customer_id !== request.customer_id ||
        current.version !== request.expected_version ||
        current.status !== "scheduled"
      ) {
        return Object.freeze({ ok: false, reason: "state_conflict" });
      }
      const decision = capacityDecision(scoped(appointments.values(), request), request);
      if (decision !== null) return decision;
      const updated = freezeAppointment({
        ...current,
        direction: request.direction,
        service_area_code: request.service_area_code,
        scheduled_start_at: request.scheduled_start_at,
        scheduled_end_at: request.scheduled_end_at,
        fee_cents: request.fee_cents,
        policy_version: request.policy_version,
        version: current.version + 1,
        updated_at: request.at,
      });
      appointments.set(appointmentKey, Object.freeze({ ...stored, appointment: updated }));
      return Object.freeze({ ok: true as const, appointment: updated });
    },
    async cancel(request) {
      const appointmentKey = key(request.org_id, request.store_id, request.appointment_id);
      const stored = appointments.get(appointmentKey);
      if (stored === undefined) return Object.freeze({ ok: false, reason: "not_found" });
      const current = stored.appointment;
      if (
        current.customer_id !== request.customer_id ||
        current.version !== request.expected_version ||
        current.status !== "scheduled"
      ) {
        return Object.freeze({ ok: false, reason: "state_conflict" });
      }
      const updated = freezeAppointment({
        ...current,
        status: "cancelled",
        version: current.version + 1,
        cancellation_reason: request.reason,
        cancelled_at: request.at,
        updated_at: request.at,
      });
      appointments.set(appointmentKey, Object.freeze({ ...stored, appointment: updated }));
      return Object.freeze({ ok: true as const, appointment: updated });
    },
    async get(orgId, storeId, appointmentId) {
      return appointments.get(key(orgId, storeId, appointmentId))?.appointment ?? null;
    },
    async list(orgId, storeId, filter) {
      return Object.freeze(
        [...appointments.values()]
          .filter((row) => row.org_id === orgId && row.store_id === storeId)
          .map((row) => row.appointment)
          .filter((row) => matchesFilter(row, filter))
          .sort(
            (left, right) =>
              right.scheduled_start_at - left.scheduled_start_at ||
              left.appointment_id.localeCompare(right.appointment_id),
          )
          .slice(0, filter.limit),
      );
    },
  });
}

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import {
  APPOINTMENT_COLUMNS,
  lockPolicyAndFeature,
  lockSlot,
  mapAppointment,
  slotKey,
  type AppointmentRow,
} from "./pg-support.js";
import type {
  AppointmentCreateRequest,
  AppointmentListFilter,
  AppointmentMutationResult,
  AppointmentRescheduleRequest,
  DeliveryAppointmentStore,
} from "./types.js";

async function capacityDecision(
  client: SqlClient,
  input: Readonly<{
    org_id: string;
    store_id: string;
    customer_id: string;
    direction: string;
    scheduled_start_at: number;
    max_appointments_per_slot: number;
    appointment_id?: string;
  }>,
): Promise<AppointmentMutationResult | null> {
  const result = await client.query<Readonly<{ count: number; duplicate: boolean }>>(
    `SELECT count(*)::integer AS count,
            COALESCE(bool_or(
              canonical.group_customer_id IS NOT NULL AND appointment.direction = $5
            ), false) AS duplicate
       FROM delivery_appointments appointment
       LEFT JOIN customer_canonical_group($4::uuid) canonical
         ON canonical.group_customer_id = appointment.customer_id
      WHERE appointment.org_id = $1::uuid AND appointment.store_id = $2::uuid
        AND appointment.scheduled_start_at = $3 AND appointment.status = 'scheduled'
        AND ($6::uuid IS NULL OR appointment.id <> $6::uuid)`,
    [
      input.org_id,
      input.store_id,
      new Date(input.scheduled_start_at * 1_000),
      input.customer_id,
      input.direction,
      input.appointment_id ?? null,
    ],
  );
  const row = result.rows[0];
  if (row?.duplicate === true) return Object.freeze({ ok: false, reason: "duplicate" });
  return (row?.count ?? 0) >= input.max_appointments_per_slot
    ? Object.freeze({ ok: false, reason: "capacity_full" })
    : null;
}

async function createAppointment(
  client: SqlClient,
  request: AppointmentCreateRequest,
): Promise<AppointmentMutationResult> {
  const policy = await lockPolicyAndFeature(
    client,
    request.org_id,
    request.store_id,
    request.policy_version,
    request.timezone,
  );
  if (policy !== "ok") return Object.freeze({ ok: false, reason: policy });
  await lockSlot(client, [slotKey(request.org_id, request.store_id, request.scheduled_start_at)]);
  const capacity = await capacityDecision(client, request);
  if (capacity !== null) return capacity;
  const result = await client.query<AppointmentRow>(
    `INSERT INTO delivery_appointments (
       id, org_id, store_id, customer_id, address_id, direction, service_area_code,
       scheduled_start_at, scheduled_end_at, fee_cents, status, version, policy_version,
       created_at, updated_at, created_by_staff_id, updated_by_staff_id
     ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9,$10,
               'scheduled',1,$11,$12,$12,$13::uuid,$13::uuid)
     RETURNING ${APPOINTMENT_COLUMNS}`,
    [
      request.appointment_id,
      request.org_id,
      request.store_id,
      request.customer_id,
      request.address_id,
      request.direction,
      request.service_area_code,
      new Date(request.scheduled_start_at * 1_000),
      new Date(request.scheduled_end_at * 1_000),
      request.fee_cents,
      request.policy_version,
      new Date(request.at * 1_000),
      request.staff_id,
    ],
  );
  const row = result.rows[0];
  return row === undefined
    ? Object.freeze({ ok: false, reason: "state_conflict" })
    : Object.freeze({ ok: true, appointment: mapAppointment(row) });
}

async function loadLocked(
  client: SqlClient,
  orgId: string,
  storeId: string,
  appointmentId: string,
): Promise<AppointmentRow | null> {
  const result = await client.query<AppointmentRow>(
    `SELECT ${APPOINTMENT_COLUMNS} FROM delivery_appointments
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE`,
    [orgId, storeId, appointmentId],
  );
  return result.rows[0] ?? null;
}

async function rescheduleAppointment(
  client: SqlClient,
  request: AppointmentRescheduleRequest,
): Promise<AppointmentMutationResult> {
  const row = await loadLocked(client, request.org_id, request.store_id, request.appointment_id);
  if (row === null) return Object.freeze({ ok: false, reason: "not_found" });
  const current = mapAppointment(row);
  if (
    current.customer_id !== request.customer_id ||
    current.version !== request.expected_version ||
    current.status !== "scheduled"
  ) {
    return Object.freeze({ ok: false, reason: "state_conflict" });
  }
  const policy = await lockPolicyAndFeature(
    client,
    request.org_id,
    request.store_id,
    request.policy_version,
    request.timezone,
  );
  if (policy !== "ok") return Object.freeze({ ok: false, reason: policy });
  await lockSlot(client, [
    slotKey(request.org_id, request.store_id, current.scheduled_start_at),
    slotKey(request.org_id, request.store_id, request.scheduled_start_at),
  ]);
  const capacity = await capacityDecision(client, request);
  if (capacity !== null) return capacity;
  const result = await client.query<AppointmentRow>(
    `UPDATE delivery_appointments
        SET direction = $6, service_area_code = $7, scheduled_start_at = $8,
            scheduled_end_at = $9, fee_cents = $10, policy_version = $11,
            version = version + 1, updated_at = $12, updated_by_staff_id = $13::uuid
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND customer_id = $4::uuid AND version = $5 AND status = 'scheduled'
      RETURNING ${APPOINTMENT_COLUMNS}`,
    [
      request.org_id,
      request.store_id,
      request.appointment_id,
      request.customer_id,
      request.expected_version,
      request.direction,
      request.service_area_code,
      new Date(request.scheduled_start_at * 1_000),
      new Date(request.scheduled_end_at * 1_000),
      request.fee_cents,
      request.policy_version,
      new Date(request.at * 1_000),
      request.staff_id,
    ],
  );
  const updated = result.rows[0];
  return updated === undefined
    ? Object.freeze({ ok: false, reason: "state_conflict" })
    : Object.freeze({ ok: true, appointment: mapAppointment(updated) });
}

function listQuery(filter: AppointmentListFilter): Readonly<{ sql: string; values: unknown[] }> {
  const conditions = ["org_id = $1::uuid", "store_id = $2::uuid"];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    conditions.push(sql.replace("?", `$${values.length + 2}`));
  };
  if (filter.customer_id !== undefined) {
    add(
      "customer_id IN (SELECT group_customer_id FROM customer_canonical_group(?::uuid))",
      filter.customer_id,
    );
  }
  if (filter.status !== undefined) add("status = ?", filter.status);
  if (filter.from_start_at !== undefined) {
    add("scheduled_start_at >= ?", new Date(filter.from_start_at * 1_000));
  }
  if (filter.to_start_at !== undefined) {
    add("scheduled_start_at <= ?", new Date(filter.to_start_at * 1_000));
  }
  values.push(filter.limit);
  return Object.freeze({
    sql: `SELECT ${APPOINTMENT_COLUMNS} FROM delivery_appointments
           WHERE ${conditions.join(" AND ")}
           ORDER BY scheduled_start_at DESC, id
           LIMIT $${values.length + 2}`,
    values,
  });
}

export function createPgDeliveryAppointmentStore(pool: PgPool): DeliveryAppointmentStore {
  return Object.freeze({
    create: (request) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: request.org_id, storeId: request.store_id, staffId: request.staff_id },
        (client) => createAppointment(client, request),
      ),
    reschedule: (request) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: request.org_id, storeId: request.store_id, staffId: request.staff_id },
        (client) => rescheduleAppointment(client, request),
      ),
    cancel: (request) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: request.org_id, storeId: request.store_id, staffId: request.staff_id },
        async (client) => {
          const row = await loadLocked(
            client,
            request.org_id,
            request.store_id,
            request.appointment_id,
          );
          if (row === null) return Object.freeze({ ok: false, reason: "not_found" as const });
          const current = mapAppointment(row);
          if (
            current.customer_id !== request.customer_id ||
            current.version !== request.expected_version ||
            current.status !== "scheduled"
          ) {
            return Object.freeze({ ok: false, reason: "state_conflict" as const });
          }
          const result = await client.query<AppointmentRow>(
            `UPDATE delivery_appointments
              SET status = 'cancelled', cancellation_reason = $6, cancelled_at = $7,
                  cancelled_by_staff_id = $8::uuid, updated_at = $7,
                  updated_by_staff_id = $8::uuid, version = version + 1
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
              AND customer_id = $4::uuid AND version = $5 AND status = 'scheduled'
            RETURNING ${APPOINTMENT_COLUMNS}`,
            [
              request.org_id,
              request.store_id,
              request.appointment_id,
              request.customer_id,
              request.expected_version,
              request.reason,
              new Date(request.at * 1_000),
              request.staff_id,
            ],
          );
          const updated = result.rows[0];
          return updated === undefined
            ? Object.freeze({ ok: false, reason: "state_conflict" as const })
            : Object.freeze({ ok: true as const, appointment: mapAppointment(updated) });
        },
      ),
    get: (orgId, storeId, appointmentId) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) => {
        const result = await client.query<AppointmentRow>(
          `SELECT ${APPOINTMENT_COLUMNS} FROM delivery_appointments
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
          [orgId, storeId, appointmentId],
        );
        return result.rows[0] === undefined ? null : mapAppointment(result.rows[0]);
      }),
    list: (orgId, storeId, filter) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) => {
        const query = listQuery(filter);
        const result = await client.query<AppointmentRow>(query.sql, [
          orgId,
          storeId,
          ...query.values,
        ]);
        return Object.freeze(result.rows.map(mapAppointment));
      }),
  });
}

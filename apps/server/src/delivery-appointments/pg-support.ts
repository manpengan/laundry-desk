import type { DeliveryAppointment } from "@laundry/contracts";

import type { SqlClient } from "../db/types.js";
import { freezeAppointment } from "./types.js";

export type AppointmentRow = Readonly<{
  appointment_id: string;
  customer_id: string;
  address_id: string;
  direction: DeliveryAppointment["direction"];
  service_area_code: string;
  scheduled_start_at: Date | string;
  scheduled_end_at: Date | string;
  fee_cents: number;
  status: DeliveryAppointment["status"];
  version: number;
  policy_version: number;
  created_at: Date | string;
  updated_at: Date | string;
  cancelled_at: Date | string | null;
  cancellation_reason: DeliveryAppointment["cancellation_reason"];
}>;

export const APPOINTMENT_COLUMNS = `id::text AS appointment_id, customer_id::text,
       address_id::text, direction, service_area_code, scheduled_start_at,
       scheduled_end_at, fee_cents, status, version, policy_version,
       created_at, updated_at, cancelled_at, cancellation_reason`;

const epoch = (value: Date | string): number =>
  Math.floor((value instanceof Date ? value.getTime() : new Date(value).getTime()) / 1_000);

export function mapAppointment(row: AppointmentRow): DeliveryAppointment {
  return freezeAppointment({
    ...row,
    scheduled_start_at: epoch(row.scheduled_start_at),
    scheduled_end_at: epoch(row.scheduled_end_at),
    created_at: epoch(row.created_at),
    updated_at: epoch(row.updated_at),
    cancelled_at: row.cancelled_at === null ? null : epoch(row.cancelled_at),
  });
}

export async function lockPolicyAndFeature(
  client: SqlClient,
  orgId: string,
  storeId: string,
  policyVersion: number,
  timezone: string,
): Promise<"ok" | "feature_disabled" | "policy_changed"> {
  const store = await client.query<Readonly<{ timezone: string }>>(
    `SELECT timezone FROM stores
      WHERE org_id = $1::uuid AND id = $2::uuid
      FOR SHARE`,
    [orgId, storeId],
  );
  if (store.rows[0]?.timezone !== timezone) return "policy_changed";
  const policy = await client.query<Readonly<{ version: number }>>(
    `SELECT version FROM delivery_policies
      WHERE org_id = $1::uuid AND store_id = $2::uuid
      FOR SHARE`,
    [orgId, storeId],
  );
  if (policy.rows[0]?.version !== policyVersion) return "policy_changed";
  const feature = await client.query<Readonly<{ delivery: boolean }>>(
    `SELECT delivery FROM store_features
      WHERE org_id = $1::uuid AND store_id = $2::uuid
      FOR SHARE`,
    [orgId, storeId],
  );
  return feature.rows[0]?.delivery === true ? "ok" : "feature_disabled";
}

export async function lockSlot(client: SqlClient, slotKeys: readonly string[]): Promise<void> {
  for (const slotKey of [...new Set(slotKeys)].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [slotKey]);
  }
}

export const slotKey = (orgId: string, storeId: string, startAt: number): string =>
  `delivery-appointment:${orgId}:${storeId}:${startAt}`;

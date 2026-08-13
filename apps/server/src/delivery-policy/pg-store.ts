import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import {
  EMPTY_DELIVERY_POLICY,
  freezeDeliveryPolicy,
  policyFromSetRequest,
  type DeliveryPolicySetRequest,
  type DeliveryPolicyStore,
  type StoreDeliveryPolicy,
} from "./types.js";

type DeliveryPolicyRow = Readonly<{
  accepting_appointments: boolean;
  minimum_lead_minutes: number;
  maximum_advance_days: number;
  slot_minutes: number;
  max_appointments_per_slot: number;
  service_areas_json: unknown;
  weekly_windows_json: unknown;
  version: number;
  updated_at: Date | string;
}>;

const POLICY_COLUMNS = `accepting_appointments, minimum_lead_minutes, maximum_advance_days,
       slot_minutes, max_appointments_per_slot, service_areas_json,
       weekly_windows_json, version, updated_at`;

const epoch = (value: Date | string): number =>
  Math.floor((value instanceof Date ? value.getTime() : new Date(value).getTime()) / 1_000);

function mapPolicy(row: DeliveryPolicyRow): StoreDeliveryPolicy {
  return freezeDeliveryPolicy({
    version: row.version,
    accepting_appointments: row.accepting_appointments,
    minimum_lead_minutes: row.minimum_lead_minutes,
    maximum_advance_days: row.maximum_advance_days,
    slot_minutes: row.slot_minutes,
    max_appointments_per_slot: row.max_appointments_per_slot,
    service_areas: row.service_areas_json as StoreDeliveryPolicy["service_areas"],
    weekly_windows: row.weekly_windows_json as StoreDeliveryPolicy["weekly_windows"],
    updated_at: epoch(row.updated_at),
  });
}

async function loadPolicy(
  client: SqlClient,
  orgId: string,
  storeId: string,
): Promise<StoreDeliveryPolicy> {
  const result = await client.query<DeliveryPolicyRow>(
    `SELECT ${POLICY_COLUMNS}
       FROM delivery_policies
      WHERE org_id = $1::uuid AND store_id = $2::uuid
      LIMIT 1`,
    [orgId, storeId],
  );
  const row = result.rows[0];
  return row === undefined ? EMPTY_DELIVERY_POLICY : mapPolicy(row);
}

async function replacePolicy(
  client: SqlClient,
  request: DeliveryPolicySetRequest,
): Promise<StoreDeliveryPolicy | null> {
  const next = policyFromSetRequest(request, request.expected_version + 1);
  const values = [
    request.org_id,
    request.store_id,
    next.accepting_appointments,
    next.minimum_lead_minutes,
    next.maximum_advance_days,
    next.slot_minutes,
    next.max_appointments_per_slot,
    JSON.stringify(next.service_areas),
    JSON.stringify(next.weekly_windows),
    next.version,
    request.staff_id,
  ] as const;
  const result =
    request.expected_version === 0
      ? await client.query<DeliveryPolicyRow>(
          `INSERT INTO delivery_policies (
             org_id, store_id, accepting_appointments, minimum_lead_minutes,
             maximum_advance_days, slot_minutes, max_appointments_per_slot,
             service_areas_json, weekly_windows_json, version, updated_at, updated_by_staff_id
           ) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,statement_timestamp(),$11::uuid)
           ON CONFLICT (org_id, store_id) DO NOTHING
           RETURNING ${POLICY_COLUMNS}`,
          values,
        )
      : await client.query<DeliveryPolicyRow>(
          `UPDATE delivery_policies
              SET accepting_appointments = $3, minimum_lead_minutes = $4,
                  maximum_advance_days = $5, slot_minutes = $6,
                  max_appointments_per_slot = $7, service_areas_json = $8::jsonb,
                  weekly_windows_json = $9::jsonb, version = $10,
                  updated_at = statement_timestamp(), updated_by_staff_id = $11::uuid
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND version = $12
          RETURNING ${POLICY_COLUMNS}`,
          [...values, request.expected_version] as const,
        );
  const row = result.rows[0];
  return row === undefined ? null : mapPolicy(row);
}

export function createPgDeliveryPolicyStore(pool: PgPool): DeliveryPolicyStore {
  return Object.freeze({
    get: (orgId, storeId) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, (client) =>
        loadPolicy(client, orgId, storeId),
      ),
    set: (request) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: request.org_id, storeId: request.store_id, staffId: request.staff_id },
        async (client) => {
          const before = await loadPolicy(client, request.org_id, request.store_id);
          if (before.version !== request.expected_version) return null;
          const after = await replacePolicy(client, request);
          return after === null ? null : Object.freeze({ before, after });
        },
      ),
  });
}

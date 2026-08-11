import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import {
  EMPTY_PRICING_POLICY,
  freezePricingPolicy,
  normalizePricingAddons,
  type PricingPolicySetRequest,
  type PricingPolicyStore,
  type StorePricingPolicy,
} from "./types.js";

type PricingPolicyRow = Readonly<{
  urgent_cents: number;
  freight_cents: number;
  addons_json: unknown;
  version: number;
  updated_at: Date | string;
}>;

const epoch = (value: Date | string): number =>
  Math.floor((value instanceof Date ? value.getTime() : new Date(value).getTime()) / 1000);

function mapPolicy(row: PricingPolicyRow): StorePricingPolicy {
  return freezePricingPolicy({
    version: row.version,
    urgent_cents: row.urgent_cents,
    freight_cents: row.freight_cents,
    addons: normalizePricingAddons(row.addons_json),
    updated_at: epoch(row.updated_at),
  });
}

async function loadPolicy(
  client: SqlClient,
  orgId: string,
  storeId: string,
): Promise<StorePricingPolicy> {
  const result = await client.query<PricingPolicyRow>(
    `SELECT urgent_cents, freight_cents, addons_json, version, updated_at
       FROM store_pricing_policies
      WHERE org_id = $1::uuid AND store_id = $2::uuid
      LIMIT 1`,
    [orgId, storeId],
  );
  const row = result.rows[0];
  return row === undefined ? EMPTY_PRICING_POLICY : mapPolicy(row);
}

async function replacePolicy(
  client: SqlClient,
  request: PricingPolicySetRequest,
): Promise<StorePricingPolicy | null> {
  const addons = normalizePricingAddons(request.addons);
  const nextVersion = request.expected_version + 1;
  const common = [
    request.org_id,
    request.store_id,
    request.urgent_cents,
    request.freight_cents,
    JSON.stringify(addons),
    nextVersion,
    new Date(request.updated_at * 1000),
    request.staff_id,
  ] as const;
  const result =
    request.expected_version === 0
      ? await client.query<PricingPolicyRow>(
          `INSERT INTO store_pricing_policies (
             org_id, store_id, urgent_cents, freight_cents, addons_json,
             version, updated_at, updated_by_staff_id
           ) VALUES ($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6,$7,$8::uuid)
           ON CONFLICT (org_id, store_id) DO NOTHING
           RETURNING urgent_cents, freight_cents, addons_json, version, updated_at`,
          common,
        )
      : await client.query<PricingPolicyRow>(
          `UPDATE store_pricing_policies
              SET urgent_cents = $3, freight_cents = $4, addons_json = $5::jsonb,
                  version = $6, updated_at = $7, updated_by_staff_id = $8::uuid
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND version = $9
          RETURNING urgent_cents, freight_cents, addons_json, version, updated_at`,
          [...common, request.expected_version],
        );
  const row = result.rows[0];
  return row === undefined ? null : mapPolicy(row);
}

export function createPgPricingPolicyStore(pool: PgPool): PricingPolicyStore {
  return Object.freeze({
    get: async (orgId, storeId) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, (client) =>
        loadPolicy(client, orgId, storeId),
      ),
    set: async (request) =>
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

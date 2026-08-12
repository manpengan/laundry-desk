import { StoreTimeZoneSchema } from "@laundry/contracts";

import type { SqlClient, TenantContext } from "../db/types.js";

type StoreTimeZoneRow = Readonly<{ timezone: string }>;

export type StoreTimeZoneResolver = (client: SqlClient, tenant: TenantContext) => Promise<string>;

export const readPgStoreTimeZone: StoreTimeZoneResolver = async (client, tenant) => {
  const result = await client.query<StoreTimeZoneRow>(
    `SELECT timezone
       FROM stores
      WHERE org_id = $1::uuid
        AND id = $2::uuid
      LIMIT 2`,
    [tenant.orgId, tenant.storeId],
  );
  if (result.rows.length !== 1) {
    throw new TypeError("missing PostgreSQL store timezone");
  }
  return StoreTimeZoneSchema.parse(result.rows[0]?.timezone);
};

import type { SqlClient, TenantContext } from "../db/types.js";
import type { OwnerPortfolioStoreCandidate, OwnerPortfolioStoreScopeRequest } from "./types.js";

type StoreRow = Readonly<{
  id: string;
  code: string;
  name: string;
  timezone: string;
}>;

type AuthorizationRow = Readonly<{ authorized: boolean }>;

const MAXIMUM_PORTFOLIO_STORE_CANDIDATES = 200;
const PORTFOLIO_STORE_CANDIDATE_QUERY_LIMIT = MAXIMUM_PORTFOLIO_STORE_CANDIDATES + 1;

const LIST_STORES_SQL = `
  SELECT store.id, store.code, store.name, store.timezone
    FROM stores AS store
   WHERE store.org_id = $1::uuid
   ORDER BY store.code ASC, store.id ASC
   LIMIT $2::integer
`;

const AUTHORIZE_STORE_SQL = `
  SELECT EXISTS (
    SELECT 1
      FROM staff_store_roles AS store_role
      JOIN staffs AS staff
        ON staff.org_id = store_role.org_id
       AND staff.id = store_role.staff_id
     WHERE store_role.org_id = $1::uuid
       AND store_role.store_id = $2::uuid
       AND store_role.staff_id = $3::uuid
       AND store_role.role = 'admin'
       AND store_role.is_active
       AND staff.org_id = $1::uuid
       AND staff.id = $3::uuid
       AND staff.is_active
  ) AS authorized
`;

const SET_STORE_GUC_SQL = "SELECT set_config('app.store_id', $1, true)";

function toCandidate(row: StoreRow): OwnerPortfolioStoreCandidate {
  if (row.code.length === 0 || row.name.length === 0 || row.timezone.length === 0) {
    throw new TypeError("invalid PostgreSQL owner portfolio store");
  }
  return Object.freeze({
    storeId: row.id,
    storeCode: row.code,
    storeName: row.name,
    timeZone: row.timezone,
  });
}

export async function listPgOwnerPortfolioStores(
  client: SqlClient,
  tenant: TenantContext,
): Promise<readonly OwnerPortfolioStoreCandidate[]> {
  const result = await client.query<StoreRow>(LIST_STORES_SQL, [
    tenant.orgId,
    PORTFOLIO_STORE_CANDIDATE_QUERY_LIMIT,
  ]);
  if (result.rows.length > MAXIMUM_PORTFOLIO_STORE_CANDIDATES) {
    throw new RangeError("PostgreSQL owner portfolio candidate limit exceeded");
  }
  return Object.freeze(result.rows.map(toCandidate));
}

async function actorIsStoreAdmin(request: OwnerPortfolioStoreScopeRequest): Promise<boolean> {
  const result = await request.client.query<AuthorizationRow>(AUTHORIZE_STORE_SQL, [
    request.tenant.orgId,
    request.store.storeId,
    request.tenant.staffId,
  ]);
  const row = result.rows[0];
  if (row === undefined || typeof row.authorized !== "boolean") {
    throw new TypeError("missing PostgreSQL owner portfolio authorization");
  }
  return row.authorized;
}

export async function withPgAuthorizedPortfolioStore<TResult>(
  request: OwnerPortfolioStoreScopeRequest,
  read: (tenant: TenantContext) => Promise<TResult>,
): Promise<TResult | null> {
  await request.client.query(SET_STORE_GUC_SQL, [request.store.storeId]);
  try {
    if (!(await actorIsStoreAdmin(request))) return null;
    const tenant = Object.freeze({ ...request.tenant, storeId: request.store.storeId });
    return await read(tenant);
  } finally {
    await request.client.query(SET_STORE_GUC_SQL, [request.tenant.storeId]);
  }
}

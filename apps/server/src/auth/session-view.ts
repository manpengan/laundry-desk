import { AccessSessionResponseSchema, type AccessSessionResponse } from "@laundry/contracts";
import { z } from "zod";

import { createSessionSqlClient } from "../db/pg-sql-client.js";
import { withStoreGuc } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import type { SessionIssueResult, SessionRecord } from "../identity/types.js";
import type { LocalRuntime } from "../local/demo-seed.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { createSqlFeaturesStore, type StoreFeatureFlags } from "../platform/features.js";

export type StaffAuthorityBinding = Readonly<{
  org_id: string;
  store_id: string;
  staff_id: string;
  permission_version?: number;
}>;

export type SessionStaffAuthority = Readonly<{
  staff_id: string;
  display_name: string;
  role: "admin" | "staff";
  permission_version: number;
  is_privacy_admin: boolean;
}>;

export type AuthorizedSession = Readonly<{
  session: SessionRecord;
  authority: SessionStaffAuthority;
}>;

export type AccessSessionProjection = Readonly<{
  org_id: string;
  store_id: string;
  staff_id: string;
  permission_version: number;
  role: "admin" | "staff";
  features: Readonly<Record<string, boolean>>;
  display: AccessSessionResponse["display"];
}>;

const StaffAuthorityRowSchema = z.strictObject({
  staff_id: z.uuid(),
  display_name: z.string().trim().min(1),
  role: z.enum(["admin", "staff"]),
  permission_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  is_privacy_admin: z.boolean(),
});

const projectFeatureFlags = (flags: StoreFeatureFlags): Readonly<Record<string, boolean>> =>
  Object.freeze({
    ai_enabled: flags.ai,
    member_enabled: flags.membership,
    fulfillment_enabled: flags.fulfillment,
    shift_closing_enabled: flags.shift_closing,
    delivery_enabled: flags.delivery,
    marketing_enabled: flags.marketing,
  });

async function readPgStaffAuthority(
  client: SqlClient,
  binding: StaffAuthorityBinding,
): Promise<SessionStaffAuthority | null> {
  const result = await client.query<z.input<typeof StaffAuthorityRowSchema>>(
    `SELECT staff.id::text AS staff_id, staff.display_name,
            staff.permission_version, role.role, role.is_privacy_admin
       FROM staffs staff
       JOIN staff_store_roles role
         ON role.org_id = staff.org_id
        AND role.staff_id = staff.id
      WHERE staff.org_id = $1::uuid
        AND role.store_id = $2::uuid
        AND staff.id = $3::uuid
        AND staff.is_active = true
        AND role.is_active = true
      LIMIT 2`,
    [binding.org_id, binding.store_id, binding.staff_id],
  );
  if (result.rows.length !== 1) return null;
  const parsed = StaffAuthorityRowSchema.safeParse(result.rows[0]);
  if (!parsed.success) return null;
  return Object.freeze(parsed.data);
}

async function readMemoryStaffAuthority(
  runtime: LocalRuntime,
  binding: StaffAuthorityBinding,
): Promise<SessionStaffAuthority | null> {
  const staff = await runtime.identity.login.staff.findById(binding.org_id, binding.staff_id);
  const directory = runtime.staffDirectory.find((entry) => entry.staff_id === binding.staff_id);
  if (staff === null || !staff.is_active || directory === undefined) return null;
  return Object.freeze({
    staff_id: staff.staff_id,
    display_name: staff.display_name,
    role: directory.role,
    permission_version: staff.permission_version,
    is_privacy_admin: directory.privacy_admin,
  });
}

function authorityMatchesBinding(
  authority: SessionStaffAuthority | null,
  binding: StaffAuthorityBinding,
): authority is SessionStaffAuthority {
  return (
    authority !== null &&
    authority.staff_id === binding.staff_id &&
    (binding.permission_version === undefined ||
      authority.permission_version === binding.permission_version)
  );
}

function isLocalBinding(binding: StaffAuthorityBinding): boolean {
  return binding.org_id === LOCAL_PROFILE.orgId && binding.store_id === LOCAL_PROFILE.storeId;
}

export async function loadSessionStaffAuthority(
  runtime: LocalRuntime,
  binding: StaffAuthorityBinding,
): Promise<SessionStaffAuthority | null> {
  if (!isLocalBinding(binding)) return null;
  if (runtime.mode === "pg") {
    if (runtime.pool === null) {
      throw new Error("PostgreSQL staff authority requires an active application pool");
    }
    const authority = await withStoreGuc(
      runtime.pool,
      {
        orgId: binding.org_id,
        storeId: binding.store_id,
        staffId: binding.staff_id,
      },
      (client) => readPgStaffAuthority(createSessionSqlClient(client), binding),
    );
    return authorityMatchesBinding(authority, binding) ? authority : null;
  }
  const authority = await readMemoryStaffAuthority(runtime, binding);
  return authorityMatchesBinding(authority, binding) ? authority : null;
}

function buildProjection(
  binding: StaffAuthorityBinding,
  authority: SessionStaffAuthority,
  flags: StoreFeatureFlags,
): AccessSessionProjection {
  return Object.freeze({
    org_id: binding.org_id,
    store_id: binding.store_id,
    staff_id: authority.staff_id,
    permission_version: authority.permission_version,
    role: authority.role,
    features: projectFeatureFlags(flags),
    display: Object.freeze({
      store_name: LOCAL_PROFILE.storeName,
      staff_name: authority.display_name,
      org_code: LOCAL_PROFILE.orgCode,
      store_code: LOCAL_PROFILE.storeCode,
    }),
  });
}

/**
 * Read the current staff role and store features before mutating session state.
 * PG mode performs both reads in one app-role transaction under the exact tenant GUCs.
 */
export async function prepareAccessSessionProjection(
  runtime: LocalRuntime,
  binding: StaffAuthorityBinding,
): Promise<AccessSessionProjection | null> {
  if (!isLocalBinding(binding)) return null;
  if (runtime.mode === "pg") {
    if (runtime.pool === null) {
      throw new Error("PostgreSQL session projection requires an active application pool");
    }
    return withStoreGuc(
      runtime.pool,
      {
        orgId: binding.org_id,
        storeId: binding.store_id,
        staffId: binding.staff_id,
      },
      async (client) => {
        const sql = createSessionSqlClient(client);
        const authority = await readPgStaffAuthority(sql, binding);
        if (!authorityMatchesBinding(authority, binding)) return null;
        const flags = await createSqlFeaturesStore(
          sql,
          Object.freeze({
            orgId: binding.org_id,
            storeId: binding.store_id,
            staffId: binding.staff_id,
          }),
        ).get(binding.store_id);
        return buildProjection(binding, authority, flags);
      },
    );
  }

  const authority = await readMemoryStaffAuthority(runtime, binding);
  if (!authorityMatchesBinding(authority, binding)) return null;
  const flags = await runtime.platform.features.get(binding.store_id);
  return buildProjection(binding, authority, flags);
}

const freezeResponse = (response: AccessSessionResponse): AccessSessionResponse =>
  Object.freeze({
    ...response,
    session: Object.freeze({ ...response.session }),
    features: Object.freeze({ ...response.features }),
    display: Object.freeze({ ...response.display }),
  });

/**
 * Add one prevalidated server-owned projection to an issued access session without I/O.
 * The binding check prevents a projection prepared for one actor/version being reused for another.
 */
export function buildAccessSessionResponse(
  issued: SessionIssueResult,
  projection: AccessSessionProjection,
): AccessSessionResponse {
  if (
    issued.session.org_id !== projection.org_id ||
    issued.session.store_id !== projection.store_id ||
    issued.session.staff_id !== projection.staff_id ||
    issued.session.permission_version !== projection.permission_version
  ) {
    throw new Error("Issued session does not match its prepared server authority");
  }

  const parsed = AccessSessionResponseSchema.parse({
    access_token: issued.access_token,
    token_type: issued.token_type,
    expires_in: issued.expires_in,
    storage: issued.storage,
    session: issued.session,
    role: projection.role,
    features: projection.features,
    display: projection.display,
  });

  return freezeResponse(parsed);
}

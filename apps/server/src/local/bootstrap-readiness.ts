import type { PgPool } from "../db/pg-pool.js";
import { withStoreGuc } from "../db/tenant-guc-client.js";
import {
  BOOTSTRAP_ADMIN_ROLE_ID,
  BOOTSTRAP_APPROVER_ROLE_ID,
  BOOTSTRAP_APPROVER_STAFF_ID,
  BOOTSTRAP_COMMISSION_AUDIT_ID,
  LOCAL_FEATURE_PROFILE_VERSION,
} from "./bootstrap-constants.js";
import { LOCAL_PROFILE } from "./profile.js";

export class LocalRuntimeReadinessError extends Error {
  readonly code = "LOCAL_RUNTIME_NOT_READY";

  constructor(options?: ErrorOptions) {
    super("LOCAL_RUNTIME_NOT_READY", options);
    this.name = "LocalRuntimeReadinessError";
  }
}

type RuntimeProfileRow = Readonly<{
  authenticated_role: string;
  authenticated_role_has_memberships: boolean;
  authenticated_role_can_login: boolean;
  authenticated_role_inherits: boolean;
  authenticated_role_can_create_db: boolean;
  authenticated_role_can_create_role: boolean;
  authenticated_role_can_replicate: boolean;
  authenticated_role_owns_database: boolean;
  authenticated_role_owns_public_schema: boolean;
  authenticated_role_owns_public_objects: boolean;
  authenticated_role_can_create_database_objects: boolean;
  authenticated_role_can_create_temporary_objects: boolean;
  authenticated_role_can_create_public_objects: boolean;
  effective_search_path: readonly string[];
  current_role: string;
  current_role_is_superuser: boolean;
  current_role_bypasses_rls: boolean;
  org_id: string;
  org_code: string;
  org_name: string;
  org_demo_only: boolean;
  store_id: string;
  store_code: string;
  store_name: string;
  store_timezone: string;
  admin_staff_id: string;
  admin_username: string;
  admin_display_name: string;
  admin_is_active: boolean;
  role_id: string;
  role_name: string;
  role_is_active: boolean;
  role_is_privacy_admin: boolean;
}>;

type CommissionedProfileRow = Readonly<{
  approver_staff_id: string;
  approver_role_id: string;
  approver_role_name: string;
  approver_is_active: boolean;
  approver_role_is_active: boolean;
  approver_is_privacy_admin: boolean;
  fulfillment: boolean;
  membership: boolean;
  shift_closing: boolean;
  delivery: boolean;
  marketing: boolean;
  ai: boolean;
  audit_id: string;
  audit_via: string;
  audit_command: string;
  audit_entity: string;
}>;

type ExplicitBootstrapReadyRow = Readonly<{ explicit_bootstrap_ready: boolean }>;
type CommissioningState = "commissioned" | "commission_required";
type CommissioningStateRow = Readonly<{ commissioning_state: string }>;

const READ_RUNTIME_PROFILE_SQL = `
  SELECT
    session_user AS authenticated_role,
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles granted_role
      WHERE granted_role.oid <> runtime_role.oid
        AND pg_catalog.pg_has_role(session_user, granted_role.oid, 'MEMBER')
    ) AS authenticated_role_has_memberships,
    runtime_role.rolcanlogin AS authenticated_role_can_login,
    runtime_role.rolinherit AS authenticated_role_inherits,
    runtime_role.rolcreatedb AS authenticated_role_can_create_db,
    runtime_role.rolcreaterole AS authenticated_role_can_create_role,
    runtime_role.rolreplication AS authenticated_role_can_replicate,
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_database owned_database
      WHERE owned_database.datname = pg_catalog.current_database()
        AND owned_database.datdba = runtime_role.oid
    ) AS authenticated_role_owns_database,
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_namespace owned_schema
      WHERE owned_schema.nspname = 'public' AND owned_schema.nspowner = runtime_role.oid
    ) AS authenticated_role_owns_public_schema,
    (
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_class owned_class
        JOIN pg_catalog.pg_namespace owned_namespace
          ON owned_namespace.oid = owned_class.relnamespace
        WHERE owned_class.relowner = runtime_role.oid
          AND owned_namespace.nspname = 'public'
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc owned_function
        JOIN pg_catalog.pg_namespace owned_function_namespace
          ON owned_function_namespace.oid = owned_function.pronamespace
        WHERE owned_function.proowner = runtime_role.oid
          AND owned_function_namespace.nspname = 'public'
      )
    ) AS authenticated_role_owns_public_objects,
    pg_catalog.has_database_privilege(session_user, pg_catalog.current_database(), 'CREATE')
      AS authenticated_role_can_create_database_objects,
    pg_catalog.has_database_privilege(session_user, pg_catalog.current_database(), 'TEMPORARY')
      AS authenticated_role_can_create_temporary_objects,
    pg_catalog.has_schema_privilege(session_user, 'public', 'CREATE')
      AS authenticated_role_can_create_public_objects,
    pg_catalog.current_schemas(false)::text[] AS effective_search_path,
    current_user AS current_role,
    runtime_role.rolsuper AS current_role_is_superuser,
    runtime_role.rolbypassrls AS current_role_bypasses_rls,
    org.id::text AS org_id, org.code AS org_code, org.name AS org_name,
    org.demo_only AS org_demo_only,
    store.id::text AS store_id, store.code AS store_code, store.name AS store_name,
    store.timezone AS store_timezone,
    admin.id::text AS admin_staff_id, admin.username AS admin_username,
    admin.display_name AS admin_display_name, admin.is_active AS admin_is_active,
    role.id::text AS role_id, role.role AS role_name, role.is_active AS role_is_active,
    role.is_privacy_admin AS role_is_privacy_admin
  FROM pg_catalog.pg_roles runtime_role
  JOIN public.orgs org ON runtime_role.rolname = session_user
  JOIN public.stores store ON store.org_id = org.id AND store.id = $2::uuid
  JOIN public.staffs admin ON admin.org_id = org.id AND admin.id = $3::uuid
  JOIN public.staff_store_roles role
    ON role.id = $4::uuid AND role.org_id = org.id
   AND role.store_id = store.id AND role.staff_id = admin.id
  WHERE org.id = $1::uuid
  LIMIT 1
`;

const READ_COMMISSIONED_PROFILE_SQL = `
  SELECT approver.id::text AS approver_staff_id,
         role.id::text AS approver_role_id, role.role AS approver_role_name,
         approver.is_active AS approver_is_active, role.is_active AS approver_role_is_active,
         role.is_privacy_admin AS approver_is_privacy_admin,
         features.fulfillment, features.membership, features.shift_closing,
         features.delivery, features.marketing, features.ai,
         audit.id::text AS audit_id, audit.via AS audit_via,
         audit.command AS audit_command, audit.entity AS audit_entity
    FROM staffs approver
    JOIN staff_store_roles role
      ON role.org_id = approver.org_id AND role.staff_id = approver.id
     AND role.store_id = $2::uuid AND role.id = $4::uuid
    JOIN store_features features
      ON features.org_id = approver.org_id AND features.store_id = $2::uuid
    JOIN audit_log audit
      ON audit.org_id = approver.org_id AND audit.store_id = $2::uuid
     AND audit.id = $5::uuid
   WHERE approver.org_id = $1::uuid AND approver.id = $3::uuid
   LIMIT 1
`;

const READ_EXPLICIT_BOOTSTRAP_READY_SQL = `
  SELECT public.laundry_local_bootstrap_ready(
    $1::uuid, $2::uuid, $3::uuid, $4::text, $5::boolean
  ) AS explicit_bootstrap_ready
`;

const READ_COMMISSIONING_STATE_SQL = `
  SELECT public.laundry_local_commissioning_state(
    $1::uuid, $2::uuid, $3::uuid, $4::text, $5::boolean,
    $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::integer
  ) AS commissioning_state
`;

const runtimeProfileMatches = (row: RuntimeProfileRow, expectedDemoOnly: boolean): boolean =>
  row.authenticated_role === "laundry_app" &&
  !row.authenticated_role_has_memberships &&
  row.authenticated_role_can_login &&
  !row.authenticated_role_inherits &&
  !row.authenticated_role_can_create_db &&
  !row.authenticated_role_can_create_role &&
  !row.authenticated_role_can_replicate &&
  !row.authenticated_role_owns_database &&
  !row.authenticated_role_owns_public_schema &&
  !row.authenticated_role_owns_public_objects &&
  !row.authenticated_role_can_create_database_objects &&
  !row.authenticated_role_can_create_temporary_objects &&
  !row.authenticated_role_can_create_public_objects &&
  row.effective_search_path.length === 1 &&
  row.effective_search_path[0] === "public" &&
  row.current_role === "laundry_app" &&
  !row.current_role_is_superuser &&
  !row.current_role_bypasses_rls &&
  row.org_id === LOCAL_PROFILE.orgId &&
  row.org_code === LOCAL_PROFILE.orgCode &&
  row.org_name === LOCAL_PROFILE.orgName &&
  row.org_demo_only === expectedDemoOnly &&
  row.store_id === LOCAL_PROFILE.storeId &&
  row.store_code === LOCAL_PROFILE.storeCode &&
  row.store_name === LOCAL_PROFILE.storeName &&
  row.store_timezone === LOCAL_PROFILE.timezone &&
  row.admin_staff_id === LOCAL_PROFILE.adminStaffId &&
  row.admin_is_active &&
  row.role_id === BOOTSTRAP_ADMIN_ROLE_ID &&
  row.role_name === "admin" &&
  row.role_is_active &&
  row.role_is_privacy_admin;

const commissionedProfileMatches = (row: CommissionedProfileRow): boolean =>
  row.approver_staff_id === BOOTSTRAP_APPROVER_STAFF_ID &&
  row.approver_role_id === BOOTSTRAP_APPROVER_ROLE_ID &&
  row.approver_role_name === "admin" &&
  row.approver_is_active &&
  row.approver_role_is_active &&
  row.approver_is_privacy_admin &&
  row.fulfillment &&
  row.membership &&
  row.shift_closing &&
  !row.delivery &&
  !row.marketing &&
  !row.ai &&
  row.audit_id === BOOTSTRAP_COMMISSION_AUDIT_ID &&
  row.audit_via === "runtime" &&
  row.audit_command === "local.commissioning.complete" &&
  row.audit_entity === "local_commissioning";

export async function assertLocalBootstrapReadyCore(
  pool: PgPool,
  expectedDemoOnly: boolean,
  profileHashFor: (username: string, displayName: string) => string,
  requireCommissioned = false,
): Promise<CommissioningState> {
  try {
    return await withStoreGuc(
      pool,
      {
        orgId: LOCAL_PROFILE.orgId,
        storeId: LOCAL_PROFILE.storeId,
        staffId: LOCAL_PROFILE.adminStaffId,
      },
      async (client) => {
        const result = await client.query<RuntimeProfileRow>(READ_RUNTIME_PROFILE_SQL, [
          LOCAL_PROFILE.orgId,
          LOCAL_PROFILE.storeId,
          LOCAL_PROFILE.adminStaffId,
          BOOTSTRAP_ADMIN_ROLE_ID,
        ]);
        const row = result.rows[0];
        if (row === undefined || !runtimeProfileMatches(row, expectedDemoOnly)) {
          throw new LocalRuntimeReadinessError();
        }
        const profileHash = profileHashFor(row.admin_username, row.admin_display_name);
        const marker = await client.query<ExplicitBootstrapReadyRow>(
          READ_EXPLICIT_BOOTSTRAP_READY_SQL,
          [
            LOCAL_PROFILE.orgId,
            LOCAL_PROFILE.storeId,
            LOCAL_PROFILE.adminStaffId,
            profileHash,
            expectedDemoOnly,
          ],
        );
        if (marker.rows[0]?.explicit_bootstrap_ready !== true) {
          throw new LocalRuntimeReadinessError();
        }
        const stateResult = await client.query<CommissioningStateRow>(
          READ_COMMISSIONING_STATE_SQL,
          [
            LOCAL_PROFILE.orgId,
            LOCAL_PROFILE.storeId,
            LOCAL_PROFILE.adminStaffId,
            profileHash,
            expectedDemoOnly,
            BOOTSTRAP_ADMIN_ROLE_ID,
            BOOTSTRAP_APPROVER_STAFF_ID,
            BOOTSTRAP_APPROVER_ROLE_ID,
            BOOTSTRAP_COMMISSION_AUDIT_ID,
            LOCAL_FEATURE_PROFILE_VERSION,
          ],
        );
        const state = stateResult.rows[0]?.commissioning_state;
        if (state !== "commissioned" && state !== "commission_required") {
          throw new LocalRuntimeReadinessError();
        }
        if (state === "commission_required") {
          if (requireCommissioned) throw new LocalRuntimeReadinessError();
          return state;
        }
        const commissioned = await client.query<CommissionedProfileRow>(
          READ_COMMISSIONED_PROFILE_SQL,
          [
            LOCAL_PROFILE.orgId,
            LOCAL_PROFILE.storeId,
            BOOTSTRAP_APPROVER_STAFF_ID,
            BOOTSTRAP_APPROVER_ROLE_ID,
            BOOTSTRAP_COMMISSION_AUDIT_ID,
          ],
        );
        if (
          commissioned.rows[0] === undefined ||
          !commissionedProfileMatches(commissioned.rows[0])
        ) {
          throw new LocalRuntimeReadinessError();
        }
        return state;
      },
    );
  } catch (error) {
    if (error instanceof LocalRuntimeReadinessError) throw error;
    throw new LocalRuntimeReadinessError({ cause: error });
  }
}

import { createHash } from "node:crypto";
import { z } from "zod";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { withStoreGuc } from "../db/tenant-guc-client.js";
import type { PasswordPort } from "../identity/password.js";
import { LOCAL_PROFILE, type LocalProfile } from "./profile.js";

/**
 * One transaction-scoped lock serializes every local bootstrap attempt.
 * Keep this signed bigint stable across releases so different binaries contend on one key.
 */
export const LOCAL_BOOTSTRAP_ADVISORY_LOCK_ID = "-5847291036815640321";

/** Deterministic role identity for the one fixed local administrator. */
export const BOOTSTRAP_ADMIN_ROLE_ID = "55555555-5555-4555-8555-111111111103";

const PROFILE_HASH_VERSION = "laundry-local-bootstrap-v1";
const ADMIN_ROLE = "admin";

export type BootstrapInput = Readonly<{
  profile: LocalProfile;
  adminUsername: string;
  adminDisplayName: string;
  adminPassword: string;
  adminPin: string;
  demoOnly: boolean;
}>;

export type BootstrapResult = Readonly<{
  status: "created" | "unchanged";
  orgId: string;
  storeId: string;
  adminStaffId: string;
  demoOnly: boolean;
}>;

export type BootstrapErrorCode =
  | "BOOTSTRAP_COLLISION"
  | "BOOTSTRAP_DEMO_CONFLICT"
  | "BOOTSTRAP_HASH_FAILED"
  | "BOOTSTRAP_PREFLIGHT_FAILED"
  | "BOOTSTRAP_ROLLBACK_FAILED"
  | "BOOTSTRAP_STATE_CONFLICT";

export class BootstrapError extends Error {
  readonly code: BootstrapErrorCode;

  constructor(code: BootstrapErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "BootstrapError";
    this.code = code;
  }
}

export class LocalRuntimeReadinessError extends Error {
  readonly code = "LOCAL_RUNTIME_NOT_READY";

  constructor(options?: ErrorOptions) {
    super("LOCAL_RUNTIME_NOT_READY", options);
    this.name = "LocalRuntimeReadinessError";
  }
}

const FixedLocalProfileSchema: z.ZodType<LocalProfile> = z
  .object({
    orgId: z.literal(LOCAL_PROFILE.orgId),
    storeId: z.literal(LOCAL_PROFILE.storeId),
    adminStaffId: z.literal(LOCAL_PROFILE.adminStaffId),
    orgCode: z.literal(LOCAL_PROFILE.orgCode),
    storeCode: z.literal(LOCAL_PROFILE.storeCode),
    orgName: z.literal(LOCAL_PROFILE.orgName),
    storeName: z.literal(LOCAL_PROFILE.storeName),
    timezone: z.literal(LOCAL_PROFILE.timezone),
  })
  .strict()
  .readonly();

export const BootstrapInputSchema: z.ZodType<BootstrapInput> = z
  .object({
    profile: FixedLocalProfileSchema,
    adminUsername: z
      .string()
      .min(1, "must not be empty")
      .max(128, "must contain at most 128 characters")
      .regex(/^[\x21-\x7e]+$/u, "must contain visible ASCII only"),
    adminDisplayName: z
      .string()
      .trim()
      .min(1, "must not be empty")
      .max(128, "must contain at most 128 characters"),
    adminPassword: z
      .string()
      .min(1, "must not be empty")
      .max(1_024, "must contain at most 1024 characters"),
    adminPin: z.string().regex(/^\d{4,8}$/u, "must contain 4 to 8 digits"),
    demoOnly: z.boolean(),
  })
  .strict()
  .readonly();

type BootstrapProfileHashInput = Pick<
  BootstrapInput,
  "profile" | "adminUsername" | "adminDisplayName" | "demoOnly"
>;

const canonicalProfile = (input: BootstrapProfileHashInput): string =>
  JSON.stringify({
    version: PROFILE_HASH_VERSION,
    profile: {
      orgId: input.profile.orgId,
      storeId: input.profile.storeId,
      adminStaffId: input.profile.adminStaffId,
      orgCode: input.profile.orgCode,
      storeCode: input.profile.storeCode,
      orgName: input.profile.orgName,
      storeName: input.profile.storeName,
      timezone: input.profile.timezone,
    },
    admin: {
      username: input.adminUsername,
      displayName: input.adminDisplayName,
    },
    demoOnly: input.demoOnly,
  });

const computeParsedProfileHash = (input: BootstrapProfileHashInput): string =>
  createHash("sha256").update(canonicalProfile(input), "utf8").digest("hex");

export const computeBootstrapProfileHash = (rawInput: BootstrapInput): string => {
  const input = BootstrapInputSchema.parse(rawInput);
  return computeParsedProfileHash(input);
};

type BootstrapDependencies = Readonly<{
  pool: PgPool;
  passwordPort: PasswordPort;
  now?: () => Date;
}>;

type HashedCredentials = Readonly<{
  passwordHash: string;
  pinHash: string;
}>;

type MetadataRow = Readonly<{
  singleton: boolean;
  org_id: string;
  store_id: string;
  admin_staff_id: string;
  profile_hash: string;
  demo_only: boolean;
}>;

type ExistingStateRow = Readonly<{
  metadata_org_id: string;
  metadata_store_id: string;
  metadata_admin_staff_id: string;
  metadata_profile_hash: string;
  metadata_demo_only: boolean;
  org_id: string;
  org_code: string;
  org_name: string;
  org_demo_only: boolean;
  store_id: string;
  store_org_id: string;
  store_code: string;
  store_name: string;
  store_timezone: string;
  admin_staff_id: string;
  admin_org_id: string;
  admin_username: string;
  admin_password_hash: string;
  admin_pin_hash: string | null;
  admin_display_name: string;
  admin_is_active: boolean;
  admin_permission_version: number;
  role_id: string;
  role_org_id: string;
  role_store_id: string;
  role_staff_id: string;
  role_name: string;
  role_is_active: boolean;
}>;

type CollisionRow = Readonly<{
  org_id_exists: boolean;
  org_code_exists: boolean;
  store_id_exists: boolean;
  store_code_exists: boolean;
  staff_id_exists: boolean;
  staff_username_exists: boolean;
  role_id_exists: boolean;
  demo_only_conflict: boolean;
}>;

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
}>;

type ExplicitBootstrapReadyRow = Readonly<{
  explicit_bootstrap_ready: boolean;
}>;

const LOCK_METADATA_SQL = `
  SELECT singleton, org_id, store_id, admin_staff_id, profile_hash, demo_only
    FROM local_bootstrap_metadata
   WHERE singleton = true
   FOR UPDATE
`;

const READ_EXISTING_STATE_SQL = `
  SELECT
    metadata.org_id AS metadata_org_id,
    metadata.store_id AS metadata_store_id,
    metadata.admin_staff_id AS metadata_admin_staff_id,
    metadata.profile_hash AS metadata_profile_hash,
    metadata.demo_only AS metadata_demo_only,
    org.id AS org_id,
    org.code AS org_code,
    org.name AS org_name,
    org.demo_only AS org_demo_only,
    store.id AS store_id,
    store.org_id AS store_org_id,
    store.code AS store_code,
    store.name AS store_name,
    store.timezone AS store_timezone,
    admin.id AS admin_staff_id,
    admin.org_id AS admin_org_id,
    admin.username AS admin_username,
    admin.password_hash AS admin_password_hash,
    admin.pin_hash AS admin_pin_hash,
    admin.display_name AS admin_display_name,
    admin.is_active AS admin_is_active,
    admin.permission_version AS admin_permission_version,
    role.id AS role_id,
    role.org_id AS role_org_id,
    role.store_id AS role_store_id,
    role.staff_id AS role_staff_id,
    role.role AS role_name,
    role.is_active AS role_is_active
  FROM local_bootstrap_metadata metadata
  JOIN orgs org ON org.id = metadata.org_id
  JOIN stores store
    ON store.org_id = metadata.org_id
   AND store.id = metadata.store_id
  JOIN staffs admin
    ON admin.org_id = metadata.org_id
   AND admin.id = metadata.admin_staff_id
  JOIN staff_store_roles role
    ON role.id = $1
   AND role.org_id = metadata.org_id
   AND role.store_id = metadata.store_id
   AND role.staff_id = metadata.admin_staff_id
  WHERE metadata.singleton = true
`;

const COLLISION_PREFLIGHT_SQL = `
  SELECT
    EXISTS (SELECT 1 FROM orgs WHERE id = $1) AS org_id_exists,
    EXISTS (SELECT 1 FROM orgs WHERE code = $2) AS org_code_exists,
    EXISTS (SELECT 1 FROM stores WHERE id = $3) AS store_id_exists,
    EXISTS (
      SELECT 1 FROM stores WHERE org_id = $1 AND code = $4
    ) AS store_code_exists,
    EXISTS (SELECT 1 FROM staffs WHERE id = $5) AS staff_id_exists,
    EXISTS (
      SELECT 1 FROM staffs WHERE org_id = $1 AND username = $6
    ) AS staff_username_exists,
    EXISTS (SELECT 1 FROM staff_store_roles WHERE id = $7) AS role_id_exists,
    EXISTS (
      SELECT 1
        FROM orgs
       WHERE demo_only = true
         AND (id = $1 OR code = $2)
         AND $8::boolean = false
    ) AS demo_only_conflict
`;

const READ_RUNTIME_PROFILE_SQL = `
  SELECT
    session_user AS authenticated_role,
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles granted_role
      WHERE granted_role.oid <> runtime_role.oid
        AND pg_catalog.pg_has_role(session_user, granted_role.oid, 'MEMBER')
    ) AS authenticated_role_has_memberships,
    runtime_role.rolcanlogin AS authenticated_role_can_login,
    runtime_role.rolinherit AS authenticated_role_inherits,
    runtime_role.rolcreatedb AS authenticated_role_can_create_db,
    runtime_role.rolcreaterole AS authenticated_role_can_create_role,
    runtime_role.rolreplication AS authenticated_role_can_replicate,
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_database owned_database
      WHERE owned_database.datname = pg_catalog.current_database()
        AND owned_database.datdba = runtime_role.oid
    ) AS authenticated_role_owns_database,
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_namespace owned_schema
      WHERE owned_schema.nspname = 'public'
        AND owned_schema.nspowner = runtime_role.oid
    ) AS authenticated_role_owns_public_schema,
    (
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class owned_class
        JOIN pg_catalog.pg_namespace owned_namespace
          ON owned_namespace.oid = owned_class.relnamespace
        WHERE owned_class.relowner = runtime_role.oid
          AND owned_namespace.nspname = 'public'
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc owned_function
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
    org.id::text AS org_id,
    org.code AS org_code,
    org.name AS org_name,
    org.demo_only AS org_demo_only,
    store.id::text AS store_id,
    store.code AS store_code,
    store.name AS store_name,
    store.timezone AS store_timezone,
    admin.id::text AS admin_staff_id,
    admin.username AS admin_username,
    admin.display_name AS admin_display_name,
    admin.is_active AS admin_is_active,
    role.id::text AS role_id,
    role.role AS role_name,
    role.is_active AS role_is_active
  FROM pg_catalog.pg_roles runtime_role
  JOIN public.orgs org
    ON runtime_role.rolname = session_user
  JOIN public.stores store
    ON store.org_id = org.id
   AND store.id = $2::uuid
  JOIN public.staffs admin
    ON admin.org_id = org.id
   AND admin.id = $3::uuid
  JOIN public.staff_store_roles role
    ON role.id = $4::uuid
   AND role.org_id = org.id
   AND role.store_id = store.id
   AND role.staff_id = admin.id
  WHERE org.id = $1::uuid
  LIMIT 1
`;

const READ_EXPLICIT_BOOTSTRAP_READY_SQL = `
  SELECT public.laundry_local_bootstrap_ready(
    $1::uuid,
    $2::uuid,
    $3::uuid,
    $4::text,
    $5::boolean
  ) AS explicit_bootstrap_ready
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
  row.role_name === ADMIN_ROLE &&
  row.role_is_active;

/**
 * Verify runtime connectivity and the fixed local profile entirely through laundry_app.
 * An owner-owned boolean function proves the explicit bootstrap marker without granting
 * laundry_app direct access to the metadata table.
 */
export async function assertLocalBootstrapReady(
  pool: PgPool,
  expectedDemoOnly = false,
): Promise<void> {
  try {
    await withStoreGuc(
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
        const profileHash = computeParsedProfileHash({
          profile: LOCAL_PROFILE,
          adminUsername: row.admin_username,
          adminDisplayName: row.admin_display_name,
          demoOnly: expectedDemoOnly,
        });
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
      },
    );
  } catch (error) {
    if (error instanceof LocalRuntimeReadinessError) {
      throw error;
    }
    throw new LocalRuntimeReadinessError({ cause: error });
  }
}

const resultFor = (input: BootstrapInput, status: BootstrapResult["status"]): BootstrapResult =>
  Object.freeze({
    status,
    orgId: input.profile.orgId,
    storeId: input.profile.storeId,
    adminStaffId: input.profile.adminStaffId,
    demoOnly: input.demoOnly,
  });

const hashCredentials = async (
  passwordPort: PasswordPort,
  input: BootstrapInput,
): Promise<HashedCredentials> => {
  const [passwordHash, pinHash] = await Promise.all([
    passwordPort.hashPassword(input.adminPassword),
    passwordPort.hashPassword(input.adminPin),
  ]);
  if (!passwordHash.startsWith("$argon2id$") || !pinHash.startsWith("$argon2id$")) {
    throw new BootstrapError("BOOTSTRAP_HASH_FAILED");
  }
  return Object.freeze({ passwordHash, pinHash });
};

const metadataMatches = (
  metadata: MetadataRow,
  input: BootstrapInput,
  profileHash: string,
): boolean =>
  metadata.singleton &&
  metadata.org_id === input.profile.orgId &&
  metadata.store_id === input.profile.storeId &&
  metadata.admin_staff_id === input.profile.adminStaffId &&
  metadata.profile_hash === profileHash &&
  metadata.demo_only === input.demoOnly;

const staticStateMatches = (row: ExistingStateRow, input: BootstrapInput): boolean =>
  row.metadata_org_id === input.profile.orgId &&
  row.metadata_store_id === input.profile.storeId &&
  row.metadata_admin_staff_id === input.profile.adminStaffId &&
  row.org_id === input.profile.orgId &&
  row.org_code === input.profile.orgCode &&
  row.org_name === input.profile.orgName &&
  row.org_demo_only === input.demoOnly &&
  row.store_id === input.profile.storeId &&
  row.store_org_id === input.profile.orgId &&
  row.store_code === input.profile.storeCode &&
  row.store_name === input.profile.storeName &&
  row.store_timezone === input.profile.timezone &&
  row.admin_staff_id === input.profile.adminStaffId &&
  row.admin_org_id === input.profile.orgId &&
  row.admin_username === input.adminUsername &&
  row.admin_display_name === input.adminDisplayName &&
  row.admin_is_active &&
  row.admin_permission_version === 1 &&
  row.role_id === BOOTSTRAP_ADMIN_ROLE_ID &&
  row.role_org_id === input.profile.orgId &&
  row.role_store_id === input.profile.storeId &&
  row.role_staff_id === input.profile.adminStaffId &&
  row.role_name === ADMIN_ROLE &&
  row.role_is_active;

const credentialsMatch = async (
  passwordPort: PasswordPort,
  input: BootstrapInput,
  row: ExistingStateRow,
): Promise<boolean> => {
  if (
    !row.admin_password_hash.startsWith("$argon2id$") ||
    row.admin_pin_hash === null ||
    !row.admin_pin_hash.startsWith("$argon2id$")
  ) {
    return false;
  }
  const [passwordMatches, pinMatches] = await Promise.all([
    passwordPort.verifyPassword(input.adminPassword, row.admin_password_hash),
    passwordPort.verifyPassword(input.adminPin, row.admin_pin_hash),
  ]);
  return passwordMatches && pinMatches;
};

const assertExistingState = async (
  client: PgPoolClient,
  passwordPort: PasswordPort,
  input: BootstrapInput,
  profileHash: string,
  metadata: MetadataRow,
): Promise<void> => {
  if (!metadataMatches(metadata, input, profileHash)) {
    throw new BootstrapError("BOOTSTRAP_STATE_CONFLICT");
  }
  const existing = await client.query<ExistingStateRow>(READ_EXISTING_STATE_SQL, [
    BOOTSTRAP_ADMIN_ROLE_ID,
  ]);
  const row = existing.rows[0];
  if (
    row === undefined ||
    row.metadata_profile_hash !== profileHash ||
    row.metadata_demo_only !== input.demoOnly ||
    !staticStateMatches(row, input) ||
    !(await credentialsMatch(passwordPort, input, row))
  ) {
    throw new BootstrapError("BOOTSTRAP_STATE_CONFLICT");
  }
};

const hasCollision = (row: CollisionRow): boolean =>
  row.org_id_exists ||
  row.org_code_exists ||
  row.store_id_exists ||
  row.store_code_exists ||
  row.staff_id_exists ||
  row.staff_username_exists ||
  row.role_id_exists;

const assertNoCollision = async (client: PgPoolClient, input: BootstrapInput): Promise<void> => {
  const preflight = await client.query<CollisionRow>(COLLISION_PREFLIGHT_SQL, [
    input.profile.orgId,
    input.profile.orgCode,
    input.profile.storeId,
    input.profile.storeCode,
    input.profile.adminStaffId,
    input.adminUsername,
    BOOTSTRAP_ADMIN_ROLE_ID,
    input.demoOnly,
  ]);
  const row = preflight.rows[0];
  if (row === undefined) {
    throw new BootstrapError("BOOTSTRAP_PREFLIGHT_FAILED");
  }
  if (row.demo_only_conflict) {
    throw new BootstrapError("BOOTSTRAP_DEMO_CONFLICT");
  }
  if (hasCollision(row)) {
    throw new BootstrapError("BOOTSTRAP_COLLISION");
  }
};

const insertOrg = (client: PgPoolClient, input: BootstrapInput, now: Date): Promise<unknown> =>
  client.query(
    `INSERT INTO orgs (id, code, name, demo_only, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [input.profile.orgId, input.profile.orgCode, input.profile.orgName, input.demoOnly, now],
  );

const insertStore = (client: PgPoolClient, input: BootstrapInput, now: Date): Promise<unknown> =>
  client.query(
    `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [
      input.profile.storeId,
      input.profile.orgId,
      input.profile.storeCode,
      input.profile.storeName,
      input.profile.timezone,
      now,
    ],
  );

const insertAdmin = (
  client: PgPoolClient,
  input: BootstrapInput,
  credentials: HashedCredentials,
  now: Date,
): Promise<unknown> =>
  client.query(
    `INSERT INTO staffs (
       id, org_id, username, password_hash, pin_hash, display_name,
       is_active, permission_version, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, true, 1, $7, $7)`,
    [
      input.profile.adminStaffId,
      input.profile.orgId,
      input.adminUsername,
      credentials.passwordHash,
      credentials.pinHash,
      input.adminDisplayName,
      now,
    ],
  );

const insertAdminRole = (
  client: PgPoolClient,
  input: BootstrapInput,
  now: Date,
): Promise<unknown> =>
  client.query(
    `INSERT INTO staff_store_roles (
       id, org_id, store_id, staff_id, role, is_active, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, true, $6, $6)`,
    [
      BOOTSTRAP_ADMIN_ROLE_ID,
      input.profile.orgId,
      input.profile.storeId,
      input.profile.adminStaffId,
      ADMIN_ROLE,
      now,
    ],
  );

const insertMetadata = (
  client: PgPoolClient,
  input: BootstrapInput,
  profileHash: string,
  now: Date,
): Promise<unknown> =>
  client.query(
    `INSERT INTO local_bootstrap_metadata (
       org_id, store_id, admin_staff_id, profile_hash, demo_only, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.profile.orgId,
      input.profile.storeId,
      input.profile.adminStaffId,
      profileHash,
      input.demoOnly,
      now,
    ],
  );

const insertBootstrapRows = async (
  client: PgPoolClient,
  input: BootstrapInput,
  credentials: HashedCredentials,
  profileHash: string,
  now: Date,
): Promise<void> => {
  await insertOrg(client, input, now);
  await insertStore(client, input, now);
  await insertAdmin(client, input, credentials, now);
  await insertAdminRole(client, input, now);
  await insertMetadata(client, input, profileHash, now);
};

const executeBootstrapTransaction = async (
  client: PgPoolClient,
  passwordPort: PasswordPort,
  input: BootstrapInput,
  credentials: HashedCredentials,
  profileHash: string,
  now: Date,
): Promise<BootstrapResult> => {
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
    LOCAL_BOOTSTRAP_ADVISORY_LOCK_ID,
  ]);
  await client.query("SET LOCAL ROLE laundry_owner");
  const metadataResult = await client.query<MetadataRow>(LOCK_METADATA_SQL);
  const metadata = metadataResult.rows[0];
  if (metadata !== undefined) {
    await assertExistingState(client, passwordPort, input, profileHash, metadata);
    return resultFor(input, "unchanged");
  }

  await assertNoCollision(client, input);
  await insertBootstrapRows(client, input, credentials, profileHash, now);
  return resultFor(input, "created");
};

const rollbackOrThrow = async (client: PgPoolClient, cause: unknown): Promise<never> => {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    throw new BootstrapError("BOOTSTRAP_ROLLBACK_FAILED", {
      cause: Object.freeze({ cause, rollbackError }),
    });
  }
  throw cause;
};

export async function bootstrapLocalIdentity(
  dependencies: BootstrapDependencies,
  rawInput: BootstrapInput,
): Promise<BootstrapResult> {
  const input = BootstrapInputSchema.parse(rawInput);
  const credentials = await hashCredentials(dependencies.passwordPort, input);
  const profileHash = computeParsedProfileHash(input);
  const now = (dependencies.now ?? (() => new Date()))();
  const client = await dependencies.pool.connect();

  try {
    await client.query("BEGIN");
    try {
      const result = await executeBootstrapTransaction(
        client,
        dependencies.passwordPort,
        input,
        credentials,
        profileHash,
        now,
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      return await rollbackOrThrow(client, error);
    }
  } finally {
    client.release();
  }
}

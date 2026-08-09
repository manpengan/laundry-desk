import type { PgPoolClient } from "../db/pg-pool.js";
import type { PasswordPort } from "../identity/password.js";
import {
  BOOTSTRAP_ADMIN_ROLE_ID,
  BOOTSTRAP_APPROVER_ROLE_ID,
  BOOTSTRAP_APPROVER_STAFF_ID,
  BOOTSTRAP_COMMISSION_AUDIT_ID,
  BOOTSTRAP_FEATURE_ROW_ID,
  LOCAL_BOOTSTRAP_ADVISORY_LOCK_ID,
  LOCAL_FEATURE_PROFILE,
  LOCAL_FEATURE_PROFILE_VERSION,
} from "./bootstrap-constants.js";
import {
  assertExistingBootstrapState,
  LOCK_METADATA_SQL,
  type MetadataRow,
} from "./bootstrap-existing-state.js";
import {
  BootstrapError,
  type BootstrapInput,
  type BootstrapResult,
  type HashedCredentials,
  resultFor,
} from "./bootstrap-model.js";

type BootstrapHashes = Readonly<{ admin: HashedCredentials; approver: HashedCredentials }>;
type CollisionRow = Readonly<{
  org_id_exists: boolean;
  org_code_exists: boolean;
  store_id_exists: boolean;
  store_code_exists: boolean;
  admin_staff_id_exists: boolean;
  approver_staff_id_exists: boolean;
  admin_username_exists: boolean;
  approver_username_exists: boolean;
  admin_role_id_exists: boolean;
  approver_role_id_exists: boolean;
  feature_id_exists: boolean;
  audit_id_exists: boolean;
  demo_only_conflict: boolean;
}>;

const COLLISION_PREFLIGHT_SQL = `
  SELECT EXISTS (SELECT 1 FROM orgs WHERE id = $1) AS org_id_exists,
    EXISTS (SELECT 1 FROM orgs WHERE code = $2) AS org_code_exists,
    EXISTS (SELECT 1 FROM stores WHERE id = $3) AS store_id_exists,
    EXISTS (SELECT 1 FROM stores WHERE org_id = $1 AND code = $4) AS store_code_exists,
    EXISTS (SELECT 1 FROM staffs WHERE id = $5) AS admin_staff_id_exists,
    EXISTS (SELECT 1 FROM staffs WHERE id = $7) AS approver_staff_id_exists,
    EXISTS (SELECT 1 FROM staffs WHERE org_id = $1 AND username = $6) AS admin_username_exists,
    EXISTS (SELECT 1 FROM staffs WHERE org_id = $1 AND username = $8) AS approver_username_exists,
    EXISTS (SELECT 1 FROM staff_store_roles WHERE id = $9) AS admin_role_id_exists,
    EXISTS (SELECT 1 FROM staff_store_roles WHERE id = $10) AS approver_role_id_exists,
    EXISTS (SELECT 1 FROM store_features WHERE id = $11) AS feature_id_exists,
    EXISTS (SELECT 1 FROM audit_log WHERE id = $12) AS audit_id_exists,
    EXISTS (SELECT 1 FROM orgs WHERE demo_only = true AND (id = $1 OR code = $2)
      AND $13::boolean = false) AS demo_only_conflict
`;

const assertNoCollision = async (client: PgPoolClient, input: BootstrapInput): Promise<void> => {
  const result = await client.query<CollisionRow>(COLLISION_PREFLIGHT_SQL, [
    input.profile.orgId,
    input.profile.orgCode,
    input.profile.storeId,
    input.profile.storeCode,
    input.profile.adminStaffId,
    input.adminUsername,
    BOOTSTRAP_APPROVER_STAFF_ID,
    input.approverUsername,
    BOOTSTRAP_ADMIN_ROLE_ID,
    BOOTSTRAP_APPROVER_ROLE_ID,
    BOOTSTRAP_FEATURE_ROW_ID,
    BOOTSTRAP_COMMISSION_AUDIT_ID,
    input.demoOnly,
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new BootstrapError("BOOTSTRAP_PREFLIGHT_FAILED");
  if (row.demo_only_conflict) throw new BootstrapError("BOOTSTRAP_DEMO_CONFLICT");
  if (Object.entries(row).some(([key, value]) => key !== "demo_only_conflict" && value)) {
    throw new BootstrapError("BOOTSTRAP_COLLISION");
  }
};

const insertStaff = (
  client: PgPoolClient,
  input: BootstrapInput,
  id: string,
  username: string,
  displayName: string,
  credentials: HashedCredentials,
  now: Date,
): Promise<unknown> =>
  client.query(
    `INSERT INTO staffs (id, org_id, username, password_hash, pin_hash, display_name,
     is_active, permission_version, created_at, updated_at)
   VALUES ($1, $2, $3, $4, $5, $6, true, 1, $7, $7)`,
    [
      id,
      input.profile.orgId,
      username,
      credentials.passwordHash,
      credentials.pinHash,
      displayName,
      now,
    ],
  );

const insertRole = (
  client: PgPoolClient,
  input: BootstrapInput,
  id: string,
  staffId: string,
  now: Date,
): Promise<unknown> =>
  client.query(
    `INSERT INTO staff_store_roles (id, org_id, store_id, staff_id, role,
     is_privacy_admin, is_active, created_at, updated_at)
   VALUES ($1, $2, $3, $4, 'admin', true, true, $5, $5)`,
    [id, input.profile.orgId, input.profile.storeId, staffId, now],
  );

const insertFeatureProfile = (
  client: PgPoolClient,
  input: BootstrapInput,
  now: Date,
): Promise<unknown> =>
  client.query(
    `INSERT INTO store_features (id, org_id, store_id, fulfillment, membership,
     shift_closing, delivery, marketing, ai, updated_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      BOOTSTRAP_FEATURE_ROW_ID,
      input.profile.orgId,
      input.profile.storeId,
      LOCAL_FEATURE_PROFILE.fulfillment,
      LOCAL_FEATURE_PROFILE.membership,
      LOCAL_FEATURE_PROFILE.shiftClosing,
      LOCAL_FEATURE_PROFILE.delivery,
      LOCAL_FEATURE_PROFILE.marketing,
      LOCAL_FEATURE_PROFILE.ai,
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
    `INSERT INTO local_bootstrap_metadata (org_id, store_id, admin_staff_id,
     approver_staff_id, profile_hash, demo_only, commissioned_at,
     feature_profile_version, created_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7)`,
    [
      input.profile.orgId,
      input.profile.storeId,
      input.profile.adminStaffId,
      BOOTSTRAP_APPROVER_STAFF_ID,
      profileHash,
      input.demoOnly,
      now,
      LOCAL_FEATURE_PROFILE_VERSION,
    ],
  );

const insertAudit = (client: PgPoolClient, input: BootstrapInput, now: Date): Promise<unknown> =>
  client.query(
    `INSERT INTO audit_log (id, org_id, store_id, staff_id, via, command,
     idempotency_key, dry_run, entity, entity_id, before_json, after_json, at)
   VALUES ($1, $2, $3::uuid, $4, 'runtime', 'local.commissioning.complete',
     'runtime-bootstrap-v2', false, 'local_commissioning', $3::uuid::text, $5, $6, $7)`,
    [
      BOOTSTRAP_COMMISSION_AUDIT_ID,
      input.profile.orgId,
      input.profile.storeId,
      input.profile.adminStaffId,
      JSON.stringify({ commissioned: false, active_admin_count: 0, feature_profile_version: 0 }),
      JSON.stringify({
        commissioned: true,
        active_admin_count: 2,
        feature_profile_version: LOCAL_FEATURE_PROFILE_VERSION,
      }),
      now,
    ],
  );

const insertRows = async (
  client: PgPoolClient,
  input: BootstrapInput,
  hashes: BootstrapHashes,
  profileHash: string,
  now: Date,
): Promise<void> => {
  await client.query(
    `INSERT INTO orgs (id, code, name, demo_only, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [input.profile.orgId, input.profile.orgCode, input.profile.orgName, input.demoOnly, now],
  );
  await client.query(
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
  await insertStaff(
    client,
    input,
    input.profile.adminStaffId,
    input.adminUsername,
    input.adminDisplayName,
    hashes.admin,
    now,
  );
  await insertRole(client, input, BOOTSTRAP_ADMIN_ROLE_ID, input.profile.adminStaffId, now);
  await insertStaff(
    client,
    input,
    BOOTSTRAP_APPROVER_STAFF_ID,
    input.approverUsername,
    input.approverDisplayName,
    hashes.approver,
    now,
  );
  await insertRole(client, input, BOOTSTRAP_APPROVER_ROLE_ID, BOOTSTRAP_APPROVER_STAFF_ID, now);
  await insertFeatureProfile(client, input, now);
  await insertMetadata(client, input, profileHash, now);
  await insertAudit(client, input, now);
};

export async function executeBootstrapTransaction(
  client: PgPoolClient,
  passwordPort: PasswordPort,
  input: BootstrapInput,
  hashes: BootstrapHashes,
  profileHash: string,
  now: Date,
): Promise<BootstrapResult> {
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
    LOCAL_BOOTSTRAP_ADVISORY_LOCK_ID,
  ]);
  await client.query("SET LOCAL ROLE laundry_owner");
  const metadata = (await client.query<MetadataRow>(LOCK_METADATA_SQL)).rows[0];
  if (metadata !== undefined) {
    await assertExistingBootstrapState(client, passwordPort, input, profileHash, metadata);
    return resultFor(input, BOOTSTRAP_APPROVER_STAFF_ID, "unchanged");
  }
  await assertNoCollision(client, input);
  await insertRows(client, input, hashes, profileHash, now);
  return resultFor(input, BOOTSTRAP_APPROVER_STAFF_ID, "created");
}

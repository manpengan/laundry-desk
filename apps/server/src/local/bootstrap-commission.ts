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
  BootstrapError,
  commissionedResult,
  type CommissionInput,
  type CommissionResult,
  type HashedCredentials,
} from "./bootstrap-model.js";

type CommissionStateRow = Readonly<{
  metadata_org_id: string;
  metadata_store_id: string;
  metadata_admin_staff_id: string;
  approver_staff_id: string | null;
  commissioned_at: Date | null;
  feature_profile_version: number;
  metadata_demo_only: boolean;
  org_code: string;
  org_name: string;
  org_demo_only: boolean;
  store_code: string;
  store_name: string;
  store_timezone: string;
  admin_is_active: boolean;
  admin_role_id: string;
  admin_role_name: string;
  admin_password_hash: string;
  admin_pin_hash: string | null;
  admin_role_is_active: boolean;
  admin_role_is_privacy_admin: boolean;
  active_admin_count: number;
  target_staff_id_exists: boolean;
  target_username_exists: boolean;
  target_role_id_exists: boolean;
  audit_id_exists: boolean;
}>;

const LOCK_COMMISSION_STATE_SQL = `
  SELECT metadata.org_id AS metadata_org_id, metadata.store_id AS metadata_store_id,
    metadata.admin_staff_id AS metadata_admin_staff_id,
    metadata.approver_staff_id, metadata.commissioned_at,
    metadata.feature_profile_version, metadata.demo_only AS metadata_demo_only,
    org.code AS org_code, org.name AS org_name, org.demo_only AS org_demo_only,
    store.code AS store_code, store.name AS store_name, store.timezone AS store_timezone,
    admin.is_active AS admin_is_active, admin.password_hash AS admin_password_hash,
    admin.pin_hash AS admin_pin_hash, admin_role.id AS admin_role_id,
    admin_role.role AS admin_role_name, admin_role.is_active AS admin_role_is_active,
    admin_role.is_privacy_admin AS admin_role_is_privacy_admin,
    (SELECT count(*)::integer FROM staff_store_roles counted_role
      JOIN staffs counted_staff ON counted_staff.org_id = counted_role.org_id
        AND counted_staff.id = counted_role.staff_id
      WHERE counted_role.org_id = metadata.org_id
        AND counted_role.store_id = metadata.store_id
        AND counted_role.role = 'admin' AND counted_role.is_active
        AND counted_staff.is_active) AS active_admin_count,
    EXISTS (SELECT 1 FROM staffs WHERE id = $2) AS target_staff_id_exists,
    EXISTS (SELECT 1 FROM staffs WHERE org_id = metadata.org_id AND username = $3)
      AS target_username_exists,
    EXISTS (SELECT 1 FROM staff_store_roles WHERE id = $4) AS target_role_id_exists,
    EXISTS (SELECT 1 FROM audit_log WHERE id = $5) AS audit_id_exists
  FROM local_bootstrap_metadata metadata
  JOIN orgs org ON org.id = metadata.org_id
  JOIN stores store ON store.org_id = metadata.org_id AND store.id = metadata.store_id
  JOIN staffs admin ON admin.org_id = metadata.org_id AND admin.id = metadata.admin_staff_id
  JOIN staff_store_roles admin_role ON admin_role.id = $1
    AND admin_role.org_id = metadata.org_id AND admin_role.store_id = metadata.store_id
    AND admin_role.staff_id = metadata.admin_staff_id
  WHERE metadata.singleton = true
  FOR UPDATE OF metadata
`;

const alreadyCommissioned = (row: CommissionStateRow): boolean =>
  row.approver_staff_id !== null ||
  row.commissioned_at !== null ||
  row.feature_profile_version !== 0;

const fixedLegacyStateMatches = (row: CommissionStateRow, input: CommissionInput): boolean =>
  row.metadata_org_id === input.profile.orgId &&
  row.metadata_store_id === input.profile.storeId &&
  row.metadata_admin_staff_id === input.profile.adminStaffId &&
  !row.metadata_demo_only &&
  row.org_code === input.profile.orgCode &&
  row.org_name === input.profile.orgName &&
  !row.org_demo_only &&
  row.store_code === input.profile.storeCode &&
  row.store_name === input.profile.storeName &&
  row.store_timezone === input.profile.timezone &&
  row.admin_is_active &&
  row.admin_role_id === BOOTSTRAP_ADMIN_ROLE_ID &&
  row.admin_role_name === "admin" &&
  row.admin_role_is_active &&
  row.admin_role_is_privacy_admin &&
  row.active_admin_count === 1;

const assertCommissionable = (
  row: CommissionStateRow | undefined,
  input: CommissionInput,
): void => {
  if (row === undefined) throw new BootstrapError("COMMISSION_PREFLIGHT_FAILED");
  if (alreadyCommissioned(row)) throw new BootstrapError("COMMISSION_ALREADY_COMPLETE");
  if (!fixedLegacyStateMatches(row, input)) throw new BootstrapError("COMMISSION_STATE_CONFLICT");
  if (
    row.target_staff_id_exists ||
    row.target_username_exists ||
    row.target_role_id_exists ||
    row.audit_id_exists
  ) {
    throw new BootstrapError("COMMISSION_COLLISION");
  }
};

const insertApprover = async (
  client: PgPoolClient,
  input: CommissionInput,
  credentials: HashedCredentials,
  now: Date,
): Promise<void> => {
  await client.query(
    `INSERT INTO staffs (id, org_id, username, password_hash, pin_hash, display_name,
       is_active, permission_version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, true, 1, $7, $7)`,
    [
      BOOTSTRAP_APPROVER_STAFF_ID,
      input.profile.orgId,
      input.approverUsername,
      credentials.passwordHash,
      credentials.pinHash,
      input.approverDisplayName,
      now,
    ],
  );
  await client.query(
    `INSERT INTO staff_store_roles (id, org_id, store_id, staff_id, role,
       is_privacy_admin, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'admin', true, true, $5, $5)`,
    [
      BOOTSTRAP_APPROVER_ROLE_ID,
      input.profile.orgId,
      input.profile.storeId,
      BOOTSTRAP_APPROVER_STAFF_ID,
      now,
    ],
  );
};

const writeFeatureProfile = (
  client: PgPoolClient,
  input: CommissionInput,
  now: Date,
): Promise<unknown> =>
  client.query(
    `INSERT INTO store_features (id, org_id, store_id, fulfillment, membership,
     shift_closing, delivery, marketing, ai, updated_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
   ON CONFLICT (org_id, store_id) DO UPDATE SET
     fulfillment = EXCLUDED.fulfillment, membership = EXCLUDED.membership,
     shift_closing = EXCLUDED.shift_closing, delivery = EXCLUDED.delivery,
     marketing = EXCLUDED.marketing, ai = EXCLUDED.ai, updated_at = EXCLUDED.updated_at`,
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

export async function executeCommissionTransaction(
  client: PgPoolClient,
  passwordPort: PasswordPort,
  input: CommissionInput,
  credentials: HashedCredentials,
  now: Date,
): Promise<CommissionResult> {
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
    LOCAL_BOOTSTRAP_ADVISORY_LOCK_ID,
  ]);
  await client.query("SET LOCAL ROLE laundry_owner");
  const row = (
    await client.query<CommissionStateRow>(LOCK_COMMISSION_STATE_SQL, [
      BOOTSTRAP_ADMIN_ROLE_ID,
      BOOTSTRAP_APPROVER_STAFF_ID,
      input.approverUsername,
      BOOTSTRAP_APPROVER_ROLE_ID,
      BOOTSTRAP_COMMISSION_AUDIT_ID,
    ])
  ).rows[0];
  assertCommissionable(row, input);
  if (
    row === undefined ||
    row.admin_pin_hash === null ||
    (await passwordPort.verifyPassword(input.approverPassword, row.admin_password_hash)) ||
    (await passwordPort.verifyPassword(input.approverPin, row.admin_pin_hash))
  ) {
    throw new BootstrapError("COMMISSION_STATE_CONFLICT");
  }
  await insertApprover(client, input, credentials, now);
  await writeFeatureProfile(client, input, now);
  const updated = await client.query(
    `UPDATE local_bootstrap_metadata
        SET approver_staff_id = $1, commissioned_at = $2, feature_profile_version = $3
      WHERE singleton = true AND approver_staff_id IS NULL AND commissioned_at IS NULL
        AND feature_profile_version = 0`,
    [BOOTSTRAP_APPROVER_STAFF_ID, now, LOCAL_FEATURE_PROFILE_VERSION],
  );
  if (updated.rowCount !== 1) throw new BootstrapError("COMMISSION_STATE_CONFLICT");
  await client.query(
    `INSERT INTO audit_log (id, org_id, store_id, staff_id, via, command,
       idempotency_key, dry_run, entity, entity_id, before_json, after_json, at)
     VALUES ($1, $2, $3::uuid, $4, 'runtime', 'local.commissioning.complete',
       'runtime-legacy-commission-v1', false, 'local_commissioning', $3::uuid::text, $5, $6, $7)`,
    [
      BOOTSTRAP_COMMISSION_AUDIT_ID,
      input.profile.orgId,
      input.profile.storeId,
      input.profile.adminStaffId,
      JSON.stringify({ commissioned: false, active_admin_count: 1, feature_profile_version: 0 }),
      JSON.stringify({
        commissioned: true,
        active_admin_count: 2,
        feature_profile_version: LOCAL_FEATURE_PROFILE_VERSION,
      }),
      now,
    ],
  );
  return commissionedResult(input, BOOTSTRAP_APPROVER_STAFF_ID);
}

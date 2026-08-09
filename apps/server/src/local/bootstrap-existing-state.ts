import type { PgPoolClient } from "../db/pg-pool.js";
import type { PasswordPort } from "../identity/password.js";
import {
  BOOTSTRAP_ADMIN_ROLE_ID,
  BOOTSTRAP_APPROVER_ROLE_ID,
  BOOTSTRAP_APPROVER_STAFF_ID,
  BOOTSTRAP_COMMISSION_AUDIT_ID,
  BOOTSTRAP_FEATURE_ROW_ID,
  LOCAL_FEATURE_PROFILE_VERSION,
} from "./bootstrap-constants.js";
import { BootstrapError, type BootstrapInput } from "./bootstrap-model.js";

export type MetadataRow = Readonly<{
  singleton: boolean;
  org_id: string;
  store_id: string;
  admin_staff_id: string;
  approver_staff_id: string | null;
  profile_hash: string;
  demo_only: boolean;
  commissioned_at: Date | null;
  feature_profile_version: number;
}>;

type ExistingStateRow = Readonly<{
  metadata_org_id: string;
  metadata_store_id: string;
  metadata_admin_staff_id: string;
  metadata_approver_staff_id: string | null;
  metadata_profile_hash: string;
  metadata_demo_only: boolean;
  metadata_commissioned_at: Date | null;
  metadata_feature_profile_version: number;
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
  admin_role_id: string;
  admin_role_name: string;
  admin_role_is_active: boolean;
  admin_role_is_privacy_admin: boolean;
  approver_staff_id: string;
  approver_org_id: string;
  approver_username: string;
  approver_password_hash: string;
  approver_pin_hash: string | null;
  approver_display_name: string;
  approver_is_active: boolean;
  approver_permission_version: number;
  approver_role_id: string;
  approver_role_name: string;
  approver_role_is_active: boolean;
  approver_role_is_privacy_admin: boolean;
  feature_id: string;
  fulfillment: boolean;
  membership: boolean;
  shift_closing: boolean;
  delivery: boolean;
  marketing: boolean;
  ai: boolean;
  audit_id: string;
}>;

export const LOCK_METADATA_SQL = `
  SELECT singleton, org_id, store_id, admin_staff_id, approver_staff_id,
         profile_hash, demo_only, commissioned_at, feature_profile_version
    FROM local_bootstrap_metadata WHERE singleton = true FOR UPDATE
`;

const READ_EXISTING_STATE_SQL = `
  SELECT metadata.org_id AS metadata_org_id, metadata.store_id AS metadata_store_id,
    metadata.admin_staff_id AS metadata_admin_staff_id,
    metadata.approver_staff_id AS metadata_approver_staff_id,
    metadata.profile_hash AS metadata_profile_hash, metadata.demo_only AS metadata_demo_only,
    metadata.commissioned_at AS metadata_commissioned_at,
    metadata.feature_profile_version AS metadata_feature_profile_version,
    org.id AS org_id, org.code AS org_code, org.name AS org_name, org.demo_only AS org_demo_only,
    store.id AS store_id, store.org_id AS store_org_id, store.code AS store_code,
    store.name AS store_name, store.timezone AS store_timezone,
    admin.id AS admin_staff_id, admin.org_id AS admin_org_id, admin.username AS admin_username,
    admin.password_hash AS admin_password_hash, admin.pin_hash AS admin_pin_hash,
    admin.display_name AS admin_display_name, admin.is_active AS admin_is_active,
    admin.permission_version AS admin_permission_version,
    admin_role.id AS admin_role_id, admin_role.role AS admin_role_name,
    admin_role.is_active AS admin_role_is_active,
    admin_role.is_privacy_admin AS admin_role_is_privacy_admin,
    approver.id AS approver_staff_id, approver.org_id AS approver_org_id,
    approver.username AS approver_username, approver.password_hash AS approver_password_hash,
    approver.pin_hash AS approver_pin_hash, approver.display_name AS approver_display_name,
    approver.is_active AS approver_is_active,
    approver.permission_version AS approver_permission_version,
    approver_role.id AS approver_role_id, approver_role.role AS approver_role_name,
    approver_role.is_active AS approver_role_is_active,
    approver_role.is_privacy_admin AS approver_role_is_privacy_admin,
    features.id AS feature_id, features.fulfillment, features.membership,
    features.shift_closing, features.delivery, features.marketing, features.ai,
    audit.id AS audit_id
  FROM local_bootstrap_metadata metadata
  JOIN orgs org ON org.id = metadata.org_id
  JOIN stores store ON store.org_id = metadata.org_id AND store.id = metadata.store_id
  JOIN staffs admin ON admin.org_id = metadata.org_id AND admin.id = metadata.admin_staff_id
  JOIN staff_store_roles admin_role ON admin_role.id = $1
    AND admin_role.org_id = metadata.org_id AND admin_role.store_id = metadata.store_id
    AND admin_role.staff_id = metadata.admin_staff_id
  JOIN staffs approver ON approver.org_id = metadata.org_id AND approver.id = $2
  JOIN staff_store_roles approver_role ON approver_role.id = $3
    AND approver_role.org_id = metadata.org_id AND approver_role.store_id = metadata.store_id
    AND approver_role.staff_id = approver.id
  JOIN store_features features ON features.org_id = metadata.org_id
    AND features.store_id = metadata.store_id AND features.id = $4
  JOIN audit_log audit ON audit.org_id = metadata.org_id AND audit.store_id = metadata.store_id
    AND audit.id = $5 AND audit.command = 'local.commissioning.complete'
  WHERE metadata.singleton = true
`;

const metadataMatches = (row: MetadataRow, input: BootstrapInput, hash: string): boolean =>
  row.singleton &&
  row.org_id === input.profile.orgId &&
  row.store_id === input.profile.storeId &&
  row.admin_staff_id === input.profile.adminStaffId &&
  row.approver_staff_id === BOOTSTRAP_APPROVER_STAFF_ID &&
  row.profile_hash === hash &&
  row.demo_only === input.demoOnly &&
  row.commissioned_at !== null &&
  row.feature_profile_version === LOCAL_FEATURE_PROFILE_VERSION;

const verifyCredential = async (
  passwordPort: PasswordPort,
  password: string,
  pin: string,
  passwordHash: string,
  pinHash: string | null,
): Promise<boolean> =>
  pinHash !== null &&
  passwordHash.startsWith("$argon2id$") &&
  pinHash.startsWith("$argon2id$") &&
  (await passwordPort.verifyPassword(password, passwordHash)) &&
  (await passwordPort.verifyPassword(pin, pinHash));

const staticStateMatches = (row: ExistingStateRow, input: BootstrapInput): boolean =>
  row.metadata_org_id === input.profile.orgId &&
  row.metadata_store_id === input.profile.storeId &&
  row.metadata_admin_staff_id === input.profile.adminStaffId &&
  row.metadata_approver_staff_id === BOOTSTRAP_APPROVER_STAFF_ID &&
  row.metadata_demo_only === input.demoOnly &&
  row.metadata_commissioned_at !== null &&
  row.metadata_feature_profile_version === LOCAL_FEATURE_PROFILE_VERSION &&
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
  row.admin_role_id === BOOTSTRAP_ADMIN_ROLE_ID &&
  row.admin_role_name === "admin" &&
  row.admin_role_is_active &&
  row.admin_role_is_privacy_admin &&
  row.approver_staff_id === BOOTSTRAP_APPROVER_STAFF_ID &&
  row.approver_org_id === input.profile.orgId &&
  row.approver_username === input.approverUsername &&
  row.approver_display_name === input.approverDisplayName &&
  row.approver_is_active &&
  row.approver_permission_version === 1 &&
  row.approver_role_id === BOOTSTRAP_APPROVER_ROLE_ID &&
  row.approver_role_name === "admin" &&
  row.approver_role_is_active &&
  row.approver_role_is_privacy_admin &&
  row.feature_id === BOOTSTRAP_FEATURE_ROW_ID &&
  row.fulfillment &&
  row.membership &&
  row.shift_closing &&
  !row.delivery &&
  !row.marketing &&
  !row.ai &&
  row.audit_id === BOOTSTRAP_COMMISSION_AUDIT_ID;

export async function assertExistingBootstrapState(
  client: PgPoolClient,
  passwordPort: PasswordPort,
  input: BootstrapInput,
  profileHash: string,
  metadata: MetadataRow,
): Promise<void> {
  if (!metadataMatches(metadata, input, profileHash)) {
    throw new BootstrapError("BOOTSTRAP_STATE_CONFLICT");
  }
  const row = (
    await client.query<ExistingStateRow>(READ_EXISTING_STATE_SQL, [
      BOOTSTRAP_ADMIN_ROLE_ID,
      BOOTSTRAP_APPROVER_STAFF_ID,
      BOOTSTRAP_APPROVER_ROLE_ID,
      BOOTSTRAP_FEATURE_ROW_ID,
      BOOTSTRAP_COMMISSION_AUDIT_ID,
    ])
  ).rows[0];
  if (
    row === undefined ||
    row.metadata_profile_hash !== profileHash ||
    !staticStateMatches(row, input) ||
    !(await verifyCredential(
      passwordPort,
      input.adminPassword,
      input.adminPin,
      row.admin_password_hash,
      row.admin_pin_hash,
    )) ||
    !(await verifyCredential(
      passwordPort,
      input.approverPassword,
      input.approverPin,
      row.approver_password_hash,
      row.approver_pin_hash,
    ))
  ) {
    throw new BootstrapError("BOOTSTRAP_STATE_CONFLICT");
  }
}

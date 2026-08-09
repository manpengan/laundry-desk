import { randomUUID } from "node:crypto";

import { writeAudit } from "../audit/write-audit.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { StaffAccessRow } from "./access-store.js";
import type {
  StaffCreate,
  StaffCredentialComplete,
  StaffCredentialIssue,
  StaffCredentialMutationResult,
  StaffCredentialReset,
  StaffCredentialStore,
} from "./credential-types.js";
import {
  PENDING_PASSWORD_HASH,
  accessRow,
  countOtherAuthorities,
  hasActiveAdmin,
  insertSetup,
  lockAuthorityRows,
  lockStaffCredentialLifecycle,
  revokeTargetSessions,
  setupResult,
  type TargetRow,
} from "./sql-credential-support.js";

type SetupRow = TargetRow &
  Readonly<{
    setup_id: string;
    created_by_staff_id: string;
    purpose: string;
    activate_role: string;
    activate_privacy_admin: boolean;
    target_permission_version: number;
    status: string;
    expires_at_epoch: string;
  }>;

type ExistingSetupRow = Readonly<{
  id: string;
  purpose: string;
  activate_role: string;
  activate_privacy_admin: boolean;
  target_permission_version: number;
  status: string;
}>;

async function createStaff(
  client: SqlClient,
  tenant: TenantContext,
  actorStaffId: string,
  input: StaffCreate,
  issue: StaffCredentialIssue,
): Promise<StaffCredentialMutationResult> {
  await lockStaffCredentialLifecycle(client, tenant);
  await lockAuthorityRows(client, tenant);
  if (!(await hasActiveAdmin(client, tenant, actorStaffId))) {
    return Object.freeze({ ok: false as const, reason: "not_found" as const });
  }
  const staffInsert = await client.query(
    `INSERT INTO staffs (
       id, org_id, username, password_hash, pin_hash, display_name,
       is_active, permission_version, created_at, updated_at
     ) VALUES ($1::uuid,$2::uuid,$3,$4,NULL,$5,false,1,to_timestamp($6),to_timestamp($6))
     ON CONFLICT (org_id, username) DO NOTHING`,
    [
      issue.targetStaffId,
      tenant.orgId,
      input.username,
      PENDING_PASSWORD_HASH,
      input.display_name,
      issue.createdAt,
    ],
  );
  if (staffInsert.rowCount !== 1) {
    return Object.freeze({ ok: false as const, reason: "duplicate_username" as const });
  }
  await client.query(
    `INSERT INTO staff_store_roles (
       id, org_id, store_id, staff_id, role, is_active, is_privacy_admin, created_at, updated_at
     ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,false,false,to_timestamp($6),to_timestamp($6))`,
    [
      issue.roleRowId,
      tenant.orgId,
      tenant.storeId,
      issue.targetStaffId,
      input.role,
      issue.createdAt,
    ],
  );
  if (
    !(await insertSetup(
      client,
      tenant,
      actorStaffId,
      issue,
      "create",
      input.role,
      input.privacy_admin,
      1,
    ))
  ) {
    throw new Error("Credential setup reference collision");
  }
  const after: StaffAccessRow = Object.freeze({
    staff_id: issue.targetStaffId,
    username: input.username,
    display_name: input.display_name,
    role: input.role,
    privacy_admin: false,
    is_active: false,
    permission_version: 1,
  });
  return Object.freeze({ ok: true as const, setup: setupResult(issue), after });
}

async function resetStaff(
  client: SqlClient,
  tenant: TenantContext,
  actorStaffId: string,
  input: StaffCredentialReset,
  issue: StaffCredentialIssue,
): Promise<StaffCredentialMutationResult> {
  if (actorStaffId === input.target_staff_id) {
    return Object.freeze({ ok: false as const, reason: "self_change" as const });
  }
  await lockStaffCredentialLifecycle(client, tenant);
  await lockAuthorityRows(client, tenant);
  if (!(await hasActiveAdmin(client, tenant, actorStaffId))) {
    return Object.freeze({ ok: false as const, reason: "not_found" as const });
  }
  const target = await client.query<TargetRow>(
    `SELECT staff.id::text AS staff_id, staff.username, staff.display_name,
            staff.password_hash, staff.pin_hash, role.role,
            role.is_privacy_admin AS privacy_admin, staff.is_active AS staff_active,
            role.is_active AS role_active, staff.permission_version
       FROM staffs staff JOIN staff_store_roles role
         ON role.org_id = staff.org_id AND role.staff_id = staff.id
      WHERE staff.org_id = $1::uuid AND role.store_id = $2::uuid AND staff.id = $3::uuid
      FOR UPDATE OF staff, role`,
    [tenant.orgId, tenant.storeId, input.target_staff_id],
  );
  const row = target.rows[0];
  if (row === undefined) return Object.freeze({ ok: false as const, reason: "not_found" as const });
  if (row.permission_version !== input.expected_permission_version) {
    return Object.freeze({ ok: false as const, reason: "stale" as const });
  }
  if (!row.staff_active || !row.role_active) {
    if (
      row.staff_active ||
      row.role_active ||
      row.password_hash !== PENDING_PASSWORD_HASH ||
      row.pin_hash !== null ||
      row.privacy_admin
    ) {
      return Object.freeze({ ok: false as const, reason: "inactive" as const });
    }
    const previous = await client.query<ExistingSetupRow>(
      `SELECT id::text, purpose, activate_role,
              activate_privacy_admin, target_permission_version, status
         FROM staff_credential_setups
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND staff_id = $3::uuid
          AND status IN ('pending', 'expired')
        ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`,
      [tenant.orgId, tenant.storeId, input.target_staff_id],
    );
    const setup = previous.rows[0];
    if (
      setup === undefined ||
      (setup.purpose !== "create" && setup.purpose !== "reset") ||
      (setup.activate_role !== "admin" && setup.activate_role !== "staff") ||
      (setup.activate_privacy_admin && setup.activate_role !== "admin") ||
      setup.target_permission_version !== row.permission_version
    ) {
      return Object.freeze({ ok: false as const, reason: "inactive" as const });
    }
    if (setup.status === "pending") {
      await client.query(
        `UPDATE staff_credential_setups SET status = 'expired'
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
            AND status = 'pending'`,
        [tenant.orgId, tenant.storeId, setup.id],
      );
    }
    if (
      !(await insertSetup(
        client,
        tenant,
        actorStaffId,
        issue,
        "reset",
        setup.activate_role,
        setup.activate_privacy_admin,
        row.permission_version,
      ))
    ) {
      throw new Error("Credential setup reissue collision");
    }
    const unchanged = accessRow(row, false);
    return Object.freeze({
      ok: true as const,
      setup: setupResult(issue),
      before: unchanged,
      after: unchanged,
    });
  }
  if (row.role !== "admin" && row.role !== "staff") {
    return Object.freeze({ ok: false as const, reason: "inactive" as const });
  }
  const other = await countOtherAuthorities(client, tenant, input.target_staff_id);
  if (row.role === "admin" && other.admins < 1) {
    return Object.freeze({ ok: false as const, reason: "last_admin" as const });
  }
  if (row.privacy_admin && other.privacyAdmins < 1) {
    return Object.freeze({ ok: false as const, reason: "last_privacy_admin" as const });
  }
  const nextVersion = row.permission_version + 1;
  if (
    !(await insertSetup(
      client,
      tenant,
      actorStaffId,
      issue,
      "reset",
      row.role,
      row.privacy_admin,
      nextVersion,
    ))
  ) {
    return Object.freeze({ ok: false as const, reason: "setup_pending" as const });
  }
  await client.query(
    `UPDATE staffs SET password_hash = $4, pin_hash = NULL, is_active = false,
                       permission_version = permission_version + 1, updated_at = to_timestamp($5)
      WHERE org_id = $1::uuid AND id = $2::uuid AND permission_version = $3`,
    [
      tenant.orgId,
      input.target_staff_id,
      row.permission_version,
      PENDING_PASSWORD_HASH,
      issue.createdAt,
    ],
  );
  await client.query(
    `UPDATE staff_store_roles SET is_active = false, is_privacy_admin = false,
                                  updated_at = to_timestamp($4)
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND staff_id = $3::uuid`,
    [tenant.orgId, tenant.storeId, input.target_staff_id, issue.createdAt],
  );
  await revokeTargetSessions(client, tenant, actorStaffId, input.target_staff_id);
  const before = accessRow(row);
  const after = Object.freeze({
    ...before,
    privacy_admin: false,
    is_active: false,
    permission_version: nextVersion,
  });
  return Object.freeze({ ok: true as const, setup: setupResult(issue), before, after });
}

async function completeSetup(
  client: SqlClient,
  tenant: TenantContext,
  actorStaffId: string,
  input: StaffCredentialComplete,
) {
  await lockStaffCredentialLifecycle(client, tenant);
  await lockAuthorityRows(client, tenant);
  await client.query(
    `UPDATE staff_credential_setups SET status = 'expired'
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND status = 'pending' AND expires_at <= to_timestamp($4)`,
    [tenant.orgId, tenant.storeId, input.credential_setup_ref, input.now],
  );
  const selected = await client.query<SetupRow>(
    `SELECT setup.id::text AS setup_id, setup.created_by_staff_id::text,
            setup.purpose, setup.activate_role, setup.activate_privacy_admin,
            setup.target_permission_version, setup.status,
            extract(epoch FROM setup.expires_at)::bigint::text AS expires_at_epoch,
            staff.id::text AS staff_id, staff.username, staff.display_name,
            staff.password_hash, staff.pin_hash, staff.permission_version,
            staff.is_active AS staff_active,
            role.role, role.is_privacy_admin AS privacy_admin, role.is_active AS role_active
       FROM staff_credential_setups setup
       JOIN staffs staff ON staff.org_id = setup.org_id AND staff.id = setup.staff_id
       JOIN staff_store_roles role ON role.org_id = setup.org_id
         AND role.store_id = setup.store_id AND role.staff_id = setup.staff_id
      WHERE setup.org_id = $1::uuid AND setup.store_id = $2::uuid AND setup.id = $3::uuid
      FOR UPDATE OF setup, staff, role`,
    [tenant.orgId, tenant.storeId, input.credential_setup_ref],
  );
  const row = selected.rows[0];
  const valid =
    row !== undefined &&
    row.created_by_staff_id === actorStaffId &&
    (row.purpose === "create" || row.purpose === "reset") &&
    (row.activate_role === "admin" || row.activate_role === "staff") &&
    (!row.activate_privacy_admin || row.activate_role === "admin") &&
    row.status === "pending" &&
    Number(row.expires_at_epoch) > input.now &&
    row.target_permission_version === row.permission_version &&
    !row.staff_active &&
    !row.role_active &&
    row.password_hash === PENDING_PASSWORD_HASH &&
    row.pin_hash === null &&
    row.role === row.activate_role &&
    !row.privacy_admin &&
    (await hasActiveAdmin(client, tenant, actorStaffId));
  if (!valid || row === undefined) return Object.freeze({ ok: false as const });

  const nextVersion = row.permission_version + 1;
  const staffUpdate = await client.query(
    `UPDATE staffs SET password_hash = $4, pin_hash = $5, is_active = true,
                       permission_version = permission_version + 1, updated_at = to_timestamp($6)
      WHERE org_id = $1::uuid AND id = $2::uuid AND permission_version = $3 AND NOT is_active`,
    [
      tenant.orgId,
      row.staff_id,
      row.permission_version,
      input.password_hash,
      input.pin_hash,
      input.now,
    ],
  );
  const roleUpdate = await client.query(
    `UPDATE staff_store_roles SET role = $4, is_privacy_admin = $5, is_active = true,
                                  updated_at = to_timestamp($6)
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND staff_id = $3::uuid AND NOT is_active`,
    [
      tenant.orgId,
      tenant.storeId,
      row.staff_id,
      row.activate_role,
      row.activate_privacy_admin,
      input.now,
    ],
  );
  const setupUpdate = await client.query(
    `UPDATE staff_credential_setups SET status = 'consumed', consumed_at = to_timestamp($4)
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid AND status = 'pending'`,
    [tenant.orgId, tenant.storeId, input.credential_setup_ref, input.now],
  );
  if (staffUpdate.rowCount !== 1 || roleUpdate.rowCount !== 1 || setupUpdate.rowCount !== 1) {
    throw new Error("Staff credential setup CAS failed");
  }
  await writeAudit(client, {
    id: randomUUID(),
    orgId: tenant.orgId,
    storeId: tenant.storeId,
    staffId: actorStaffId,
    via: "ui",
    command: "staff.credentials.complete",
    idempotencyKey: null,
    dryRun: false,
    entity: "staff_credentials",
    entityId: row.staff_id,
    beforeJson: JSON.stringify({ status: "pending", permission_version: row.permission_version }),
    afterJson: JSON.stringify({ status: "active", permission_version: nextVersion }),
    ip: null,
    deviceId: input.device_id,
    at: new Date(input.now * 1_000),
  });
  return Object.freeze({
    ok: true as const,
    result: Object.freeze({
      target_staff_id: row.staff_id,
      permission_version: nextVersion,
      status: "active" as const,
    }),
  });
}

export function createSqlStaffCredentialStore(
  client: SqlClient,
  tenant: TenantContext,
): StaffCredentialStore {
  return Object.freeze({
    create: (actor, input, issue) => createStaff(client, tenant, actor, input, issue),
    reset: (actor, input, issue) => resetStaff(client, tenant, actor, input, issue),
    complete: (actor, input) => completeSetup(client, tenant, actor, input),
  });
}

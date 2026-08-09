import {
  asRecord,
  requireInteger,
  requireString,
  requireThat,
  requireUuid,
} from "./adr36-web-core.mjs";

/**
 * Injectable API expected by `createStaffCredentialJourney`:
 *
 * - `query(session, "staff.access.list", {})` -> `{ staff: StaffAccessRow[] }`.
 * - `stepUp(session, command, args, approverStaffId, approverPin)` for the R5
 *   `staff.create`, `staff.credentials.reset`, and `staff.access.set` commands.
 * - `completeStaffCredentials(session, input)` -> the credential-completion response.
 * - `login(principal, "staff")` -> an authenticated staff session.
 * - `expectStaffFailure(session)` and `expectRefreshFailure(session)` -> resolve only when
 *   the bearer and refresh authentication paths, respectively, are rejected.
 * - `expectLoginFailure(principal)` -> resolves only when password login is rejected.
 *
 * Every expectation method must fail closed. The API must not include remote bodies,
 * cookies, tokens, passwords, or PINs in thrown errors.
 */
export function requireStaffJourneyApi(api) {
  const required = [
    "query",
    "stepUp",
    "completeStaffCredentials",
    "login",
    "expectStaffFailure",
    "expectRefreshFailure",
    "expectLoginFailure",
  ];
  requireThat(typeof api === "object" && api !== null, "STAFF_API_INVALID");
  for (const method of required) {
    requireThat(typeof api[method] === "function", "STAFF_API_INVALID");
  }
}

export function requireStaffSession(value, code) {
  const session = asRecord(value, code);
  requireUuid(session.staffId, code);
  return session;
}

export function staffSyntheticIdentity(run) {
  const record = asRecord(run, "STAFF_RUN_INVALID");
  const runId = requireString(record.runId, "STAFF_RUN_INVALID");
  const label = requireString(record.label, "STAFF_RUN_INVALID");
  const note = requireString(record.note, "STAFF_RUN_INVALID");
  const suffix = runId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  const username = `uat_staff_${suffix}`.slice(0, 128);
  const displayName = `${label} Staff`.slice(0, 128).trim();
  const reason = `${note} staff credential lifecycle`.slice(0, 256).trim();
  requireThat(/^[\x21-\x7e]{1,128}$/u.test(username), "STAFF_IDENTITY_INVALID");
  requireThat(displayName.length > 0 && reason.length > 0, "STAFF_IDENTITY_INVALID");
  return Object.freeze({ username, displayName, reason });
}

export function staffAccessRow(value) {
  const row = asRecord(value, "STAFF_DIRECTORY_INVALID");
  const role = requireString(row.role, "STAFF_DIRECTORY_INVALID");
  requireThat(role === "admin" || role === "staff", "STAFF_DIRECTORY_INVALID");
  requireThat(
    typeof row.privacy_admin === "boolean" && typeof row.is_active === "boolean",
    "STAFF_DIRECTORY_INVALID",
  );
  const permissionVersion = requireInteger(row.permission_version, "STAFF_DIRECTORY_INVALID");
  requireThat(permissionVersion > 0, "STAFF_DIRECTORY_INVALID");
  return Object.freeze({
    staffId: requireUuid(row.staff_id, "STAFF_DIRECTORY_INVALID"),
    username: requireString(row.username, "STAFF_DIRECTORY_INVALID"),
    displayName: requireString(row.display_name, "STAFF_DIRECTORY_INVALID"),
    role,
    privacyAdmin: row.privacy_admin,
    isActive: row.is_active,
    permissionVersion,
  });
}

export function staffSetupResult(value, targetStaffId = null) {
  const setup = asRecord(value, "STAFF_SETUP_INVALID");
  const result = Object.freeze({
    setupRef: requireUuid(setup.credential_setup_ref, "STAFF_SETUP_INVALID"),
    targetStaffId: requireUuid(setup.target_staff_id, "STAFF_SETUP_INVALID"),
    expiresAt: requireInteger(setup.expires_at, "STAFF_SETUP_INVALID"),
  });
  requireThat(setup.status === "pending" && result.expiresAt > 0, "STAFF_SETUP_INVALID");
  requireThat(
    targetStaffId === null || result.targetStaffId === targetStaffId,
    "STAFF_TARGET_INVALID",
  );
  return result;
}

export function staffCompletionResult(value, targetStaffId) {
  const completed = asRecord(value, "STAFF_COMPLETION_INVALID");
  const permissionVersion = requireInteger(
    completed.permission_version,
    "STAFF_COMPLETION_INVALID",
  );
  requireThat(
    completed.status === "active" &&
      completed.target_staff_id === targetStaffId &&
      permissionVersion > 0,
    "STAFF_COMPLETION_INVALID",
  );
  return Object.freeze({ targetStaffId, permissionVersion });
}

export function staffAccessChangeResult(value, targetStaffId, expectedActive) {
  const result = asRecord(value, "STAFF_ACCESS_RESULT_INVALID");
  const row = staffAccessRow(result.staff);
  requireThat(
    row.staffId === targetStaffId &&
      row.role === "staff" &&
      row.privacyAdmin === false &&
      row.isActive === expectedActive,
    "STAFF_ACCESS_RESULT_INVALID",
  );
  return row;
}

import { fail } from "./companion-contract.mjs";

export const OMIT_PORTABLE_TABLE_DATA = new Set([
  "ai_provider_keys",
  "notification_provider_settings",
  "payment_channel_settings",
  "miniapp_settings",
  "miniapp_profile_authority",
]);

function increment(raw) {
  if (typeof raw !== "string" || !/^[0-9]+$/u.test(raw)) fail("PORTABLE_AUTHORITY_INVALID");
  const next = BigInt(raw) + 1n;
  if (next > 2_147_483_647n) fail("PORTABLE_AUTHORITY_INVALID");
  return String(next);
}

/** Rebind execution authority while retaining business and audit history. */
export function resetPortableAuthority(table, values, timestamp) {
  const row = Object.fromEntries(
    table.columns.map((column, index) => [column.name, values[index]]),
  );
  const times = [timestamp, row.created_at, row.updated_at, row.issued_at].filter(
    (v) => v !== undefined && v !== null,
  );
  if (times.some((v) => !Number.isFinite(Date.parse(v)))) fail("PORTABLE_AUTHORITY_INVALID");
  const now = new Date(Math.max(...times.map((v) => Date.parse(v)))).toISOString();
  const epoch = String(Math.floor(Date.parse(now) / 1000));
  let patch = {};
  if (
    ["sessions", "refresh_families", "refresh_tokens", "customer_portal_sessions"].includes(
      table.name,
    )
  )
    patch = { status: "revoked", revoked_at: now };
  if (table.name === "sessions")
    patch = { ...patch, session_version: increment(row.session_version) };
  if (table.name === "edge_devices") patch = { status: "revoked", revoked_at: now };
  if (table.name === "offline_grants") patch = { revoked_at: now };
  if (table.name === "primary_leases") patch = { released_at: now };
  if (table.name === "primary_lease_heads")
    patch = {
      current_epoch: increment(row.current_epoch),
      current_lease_id: null,
      current_device_id: null,
      current_not_after: null,
      updated_at: now,
    };
  if (table.name === "edge_authority_challenges") patch = { consumed_at: now };
  if (table.name === "pin_challenges" && row.status === "open") patch = { status: "expired" };
  if (table.name === "step_up_proofs" && row.status === "active")
    patch = { status: "consumed", consumed_at_epoch: epoch };
  if (table.name === "staff_credential_setups" && row.status === "pending")
    patch = { status: "expired" };
  if (table.name === "ai_pending_actions" && row.status === "pending")
    patch = { status: "expired" };
  if (table.name === "ai_approval_requests" && ["pending", "approved"].includes(row.status))
    patch = {
      status: "expired",
      decided_by_staff_id: null,
      decided_by_permission_version: null,
      decided_at_epoch: null,
      decision_reason: null,
      consumed_at_epoch: null,
    };
  if (table.name === "v1_import_requests") patch = { consumed_at: now };
  if (table.name === "store_export_requests" && row.consumed_at === null)
    patch = { revoked_at: row.revoked_at ?? now };
  if (
    table.name === "notification_deliveries" &&
    ["queued", "sending", "retry_wait", "accepted"].includes(row.status)
  )
    patch = {
      status: "manual_required",
      next_attempt_at: null,
      claimed_at: null,
      lease_until: null,
      lease_token: null,
      worker_id: null,
      recipient_hmac: null,
      message_sha256: null,
      last_error_code: "RESTORE_REQUIRES_RECONCILIATION",
      provider_outcome_pending: "false",
      updated_at: now,
    };
  if (table.name === "ai_safety_policies") patch = { enabled: "false" };
  if (
    table.name === "ai_provider_keys" &&
    ["pending_verification", "active", "invalid"].includes(row.status)
  )
    patch = {
      status: "revoked",
      revoked_at: now,
      updated_at: now,
      row_version: increment(row.row_version),
    };
  if (table.name === "notification_provider_settings") patch = { enabled: "false" };
  // Schemas 77/78 predate dispatch and this revocation column. Their binding
  // and session are independently revoked; preserve that older history.
  if (table.name === "miniapp_subscriptions" && Object.hasOwn(row, "revoked_at"))
    patch = { revoked_at: row.revoked_at ?? now };
  if (table.name === "miniapp_notification_settings")
    patch = { enabled: "false", version: increment(row.version), updated_at: now };
  if (
    table.name === "miniapp_notification_outbox" &&
    ["queued", "sending", "unknown"].includes(row.state)
  )
    patch = { state: "needs_review", error_code: "RESTORED_NO_REDISPATCH", checked_at: now };
  if (
    ["remote_assistance_sessions", "miniapp_bindings", "miniapp_sessions"].includes(table.name) &&
    row.status === "active"
  )
    patch = { status: "revoked", revoked_at: now };
  if (table.name === "payment_channel_intents" && !["paid", "closed"].includes(row.state))
    patch = { state: "needs_review", checkout_json: null, error_code: "MIGRATED_QUERY_REQUIRED" };
  if (table.name === "payment_channel_refunds" && !["refunded", "failed"].includes(row.state))
    patch = { state: "needs_review", error_code: "MIGRATED_QUERY_REQUIRED" };
  if (table.name === "ai_sessions" && ["open", "running"].includes(row.status))
    patch = { status: "cancelled", closed_at: now, updated_at: now };
  if (table.name === "ai_turns" && ["queued", "running"].includes(row.status))
    patch = { status: "cancelled", error_code: "AI_ABORTED", completed_at: now };
  if (table.name === "automation_policies" && ["active", "quota_paused"].includes(row.status))
    patch = {
      status: "paused",
      next_run_at: null,
      active_run_id: null,
      lease_token: null,
      lease_until: null,
      updated_at: now,
    };
  // Declared columns remain the authority: a migration removing a reset column
  // must cause a review rather than silently carrying live grants to another PC.
  for (const key of Object.keys(patch))
    if (!Object.hasOwn(row, key)) fail("PORTABLE_AUTHORITY_SCHEMA_INVALID");
  return table.columns.map((column) =>
    Object.hasOwn(patch, column.name) ? patch[column.name] : row[column.name],
  );
}

import Foundation

struct RuntimeDatabaseCopyTable: Equatable {
  let name: String
  let columns: String

  var header: String { "COPY public.\(name) (\(columns)) FROM stdin;" }
  var imported: Bool { name != "laundry_schema_migrations" }
  var stagingName: String { "restore_\(name)" }
  var stagingHeader: String { "COPY \(stagingName) (\(columns)) FROM stdin;" }
}

enum RuntimeDatabaseImportSchema {
  // Frozen to migration head 0045_store_commissioning_staff_credentials.sql.
  static let tables: [RuntimeDatabaseCopyTable] = [
    .init(
      name: "ai_pending_actions",
      columns:
        "nonce, org_id, store_id, command, command_version, args_json, authority_json, authority_present, args_hash, entity_versions_json, creator_staff_id, idempotency_key, created_at_epoch, expires_at_epoch, status, effective_risk, policy_outcome, requires_other_approver, consumed_by_staff_id, consumed_at_epoch"
    ),
    .init(
      name: "audit_log",
      columns:
        "id, org_id, store_id, staff_id, via, command, idempotency_key, dry_run, entity, entity_id, before_json, after_json, ip, device_id, at"
    ),
    .init(
      name: "catalog_items",
      columns:
        "id, org_id, store_id, code, name, service_code, category_code, unit_price_cents, mnemonic, is_active, sort_order, created_at, updated_at"
    ),
    .init(
      name: "command_idempotency",
      columns:
        "org_id, store_id, command, idempotency_key, request_hash, status, result_json, completed_at"
    ),
    .init(
      name: "customer_privacy_events",
      columns:
        "id, org_id, origin_store_id, customer_id, staff_id, action, reason, affected_order_count, created_at"
    ),
    .init(
      name: "customers",
      columns:
        "id, org_id, phone, name, note, created_at, updated_at, merged_into_id, merged_at, anonymized_at, anonymized_by_staff_id"
    ),
    .init(
      name: "edge_authority_challenges",
      columns:
        "id, org_id, store_id, staff_id, session_id, session_version, permission_version, device_id, device_public_key_spki, device_public_key_fingerprint, challenge_sha256, request_nonce, request_primary, pairing_code_hash, pairing_code_required, expected_primary_epoch, actor_role, authentication_method, issued_at, expires_at, consumed_at"
    ),
    .init(
      name: "edge_devices",
      columns:
        "org_id, store_id, device_id, public_key_spki, public_key_fingerprint, status, paired_by_staff_id, paired_at, last_seen_at, revoked_at"
    ),
    .init(
      name: "edge_replay_records",
      columns:
        "id, org_id, store_id, reported_queue_id, accepted_queue_id, grant_id, lease_id, original_staff_id, replayed_by_staff_id, device_id, primary_epoch, reported_per_lease_seq, accepted_per_lease_seq, envelope_sha256, command, idempotency_key, decision, reason, result_json, recorded_at, authorization_kind, reported_per_grant_seq, accepted_per_grant_seq"
    ),
    .init(
      name: "garment_incidents",
      columns:
        "id, org_id, store_id, order_id, garment_id, kind, note, compensation_cents, staff_id, created_at"
    ),
    .init(
      name: "garment_photos",
      columns:
        "id, org_id, store_id, garment_id, order_id, kind, storage_key, content_type, byte_size, taken_at, created_by_staff_id, content_sha256"
    ),
    .init(
      name: "garment_rack_log",
      columns:
        "id, org_id, store_id, order_id, garment_id, barcode, rack_zone, rack_slot, staff_id, at"),
    .init(
      name: "garment_status_log",
      columns:
        "id, org_id, store_id, order_id, garment_id, from_status, to_status, reason, staff_id, at"),
    .init(
      name: "garments",
      columns:
        "id, org_id, store_id, order_id, order_line_id, seq, barcode, service_code, category_code, unit_price_cents, color, brand, status, rack_zone, rack_slot, racked_at, racked_by_staff_id"
    ),
    .init(name: "laundry_schema_migrations", columns: "filename, checksum, applied_at"),
    .init(
      name: "local_bootstrap_metadata",
      columns:
        "singleton, org_id, store_id, admin_staff_id, profile_hash, demo_only, created_at, approver_staff_id, commissioned_at, feature_profile_version"
    ),
    .init(
      name: "member_accounts",
      columns:
        "id, org_id, customer_id, status, opened_at, opened_store_id, status_version, status_changed_at, status_reason, status_changed_by_staff_id, status_changed_store_id"
    ),
    .init(
      name: "member_bonus_rules",
      columns:
        "id, org_id, min_topup_cents, bonus_cents, status, effective_from, updated_at, updated_by_staff_id, note"
    ),
    .init(
      name: "member_ledger",
      columns:
        "id, org_id, store_id, account_id, kind, principal_delta_cents, bonus_delta_cents, order_id, ref_ledger_id, staff_id, at, business_date, note, ledger_seq, tender, bonus_rule_id"
    ),
    .init(
      name: "notification_log",
      columns:
        "id, org_id, store_id, batch_id, order_id, customer_id, channel, status, \"grouping\", message_sha256, export_sha256, cost_cents, created_by_staff_id, created_at"
    ),
    .init(
      name: "offline_grant_replay_state",
      columns: "org_id, store_id, grant_id, last_seq, updated_at"),
    .init(
      name: "offline_grants",
      columns:
        "id, org_id, store_id, staff_id, device_id, request_nonce, permission_version, allowed_commands, protocol_version, signature, issued_at, not_after, revoked_at"
    ),
    .init(
      name: "order_lines",
      columns:
        "id, org_id, store_id, order_id, line_index, service_code, category_code, unit_price_cents, qty, line_total_cents, color, brand"
    ),
    .init(
      name: "orders",
      columns:
        "id, org_id, store_id, ticket_no, status, customer_phone, customer_name, note, subtotal_cents, payable_cents, paid_cents, balance_cents, created_at, updated_at, created_by_staff_id, original_cents, discount_cents, addon_cents, urgent_cents, freight_cents, business_date, pickup_code, customer_id"
    ),
    .init(name: "orgs", columns: "id, code, name, created_at, updated_at, demo_only"),
    .init(
      name: "payments",
      columns:
        "id, org_id, store_id, order_id, method, amount_cents, kind, ref_payment_id, staff_id, at, note, business_date, ledger_seq"
    ),
    .init(
      name: "pin_challenges",
      columns:
        "id, org_id, store_id, device_id, session_id, session_version, purpose, target_staff_id, approver_staff_id, pending_action_ref, nonce, attempts, max_attempts, status, issued_at, expires_at, consumed_at, args_hash, entity_versions, idempotency_key"
    ),
    .init(
      name: "pin_lockouts",
      columns:
        "id, org_id, store_id, staff_id, device_id, locked_until, failed_attempts, updated_at"),
    .init(
      name: "primary_lease_heads",
      columns:
        "org_id, store_id, current_epoch, current_lease_id, current_device_id, current_not_after, updated_at"
    ),
    .init(
      name: "primary_lease_replay_state",
      columns: "org_id, store_id, lease_id, last_seq, updated_at"),
    .init(
      name: "primary_leases",
      columns:
        "id, grant_id, org_id, store_id, device_id, primary_epoch, protocol_version, signature, issued_at, ttl_ms, max_clock_skew_ms, not_after, released_at"
    ),
    .init(
      name: "print_device_receipt_heads",
      columns: "org_id, store_id, device_id, last_seq, updated_at"),
    .init(
      name: "print_jobs",
      columns:
        "id, org_id, store_id, order_id, ticket_no, kind, status, error, payload_bytes, created_at, updated_at, attempt_count, claimed_at, lease_until, worker_id, artifact_path, artifact_sha256, artifact_bytes, completed_at, snapshot_json, snapshot_sha256, snapshot_purged_at, source_job_id, dispatch_device_id, dispatch_staff_id, ticket_nonce, capability_json, dispatch_issued_at, dispatch_expires_at, receipt_seq, receipt_result, cups_job_id, receipt_at, receipt_json, receipt_envelope_sha256, settled_at"
    ),
    .init(
      name: "refresh_families",
      columns: "id, session_id, org_id, store_id, status, created_at, revoked_at"),
    .init(
      name: "refresh_tokens",
      columns:
        "id, family_id, session_id, org_id, store_id, token_hash, status, replacement_token_id, expires_at, created_at, rotated_at, revoked_at"
    ),
    .init(
      name: "sessions",
      columns:
        "id, org_id, store_id, staff_id, device_id, session_version, permission_version, authentication_method, status, created_at, revoked_at, last_seen_at"
    ),
    .init(
      name: "settings", columns: "id, org_id, key, value_json, updated_at, updated_by_staff_id"),
    .init(
      name: "shift_closings",
      columns:
        "id, org_id, store_id, business_date, closed_by_staff_id, note, order_count, payable_cents, paid_cents, payment_cents, signature_name, closed_at, opening_float_cents, counted_cash_cents, retained_float_cents, expected_cash_cents, cash_difference_cents, period_started_at, period_ended_at"
    ),
    .init(
      name: "staff_credential_setups",
      columns:
        "id, org_id, store_id, staff_id, created_by_staff_id, purpose, activate_role, activate_privacy_admin, target_permission_version, status, expires_at, consumed_at, created_at"
    ),
    .init(
      name: "staff_store_roles",
      columns:
        "id, org_id, store_id, staff_id, role, is_active, created_at, updated_at, is_privacy_admin"),
    .init(
      name: "staffs",
      columns:
        "id, org_id, username, password_hash, pin_hash, display_name, is_active, permission_version, created_at, updated_at, last_login_at"
    ),
    .init(
      name: "step_up_proofs",
      columns:
        "proof_id, org_id, store_id, pending_action_ref, args_hash, entity_versions_json, idempotency_key, requester_staff_id, approver_staff_id, session_id, session_version, issued_at_epoch, expires_at_epoch, status, consumed_at_epoch"
    ),
    .init(
      name: "store_features",
      columns:
        "id, org_id, store_id, fulfillment, membership, shift_closing, delivery, marketing, ai, updated_at"
    ),
    .init(name: "stores", columns: "id, org_id, code, name, timezone, created_at, updated_at"),
    .init(name: "ticket_counters", columns: "org_id, store_id, day_key, last_seq"),
  ]

  static let loadOrder = [
    "orgs", "stores", "staffs", "customers", "staff_store_roles", "settings",
    "store_features", "sessions", "refresh_families", "refresh_tokens", "pin_challenges",
    "pin_lockouts", "catalog_items", "edge_devices", "edge_authority_challenges",
    "offline_grants", "primary_lease_heads", "primary_leases", "primary_lease_replay_state",
    "offline_grant_replay_state", "edge_replay_records", "orders", "order_lines", "garments",
    "ticket_counters", "payments", "print_jobs", "print_device_receipt_heads",
    "shift_closings", "garment_photos", "local_bootstrap_metadata", "command_idempotency",
    "garment_status_log", "garment_incidents", "garment_rack_log", "customer_privacy_events",
    "member_accounts", "member_bonus_rules", "member_ledger", "notification_log", "audit_log",
    "ai_pending_actions", "step_up_proofs", "staff_credential_setups",
  ]

  static let sequences = ["member_ledger_seq_seq", "payments_ledger_seq_seq"]
  static let rlsTables = tables.map(\.name).filter {
    !["orgs", "local_bootstrap_metadata", "laundry_schema_migrations"].contains($0)
  }
}

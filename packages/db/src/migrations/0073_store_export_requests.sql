-- ADR-81: short-lived approval for one audited, tenant-scoped business export.
CREATE TABLE public.store_export_requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  session_version integer NOT NULL CHECK (session_version > 0),
  permission_version integer NOT NULL CHECK (permission_version > 0),
  policy_sha256 text NOT NULL CHECK (policy_sha256 ~ '^[0-9a-f]{64}$'),
  approval_signature text NOT NULL CHECK (approval_signature ~ '^[A-Za-z0-9+/]{86}==$'),
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  manifest_sha256 text CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT store_export_requests_expiry_chk CHECK
    (expires_at > approved_at AND expires_at <= approved_at + interval '10 minutes'),
  CONSTRAINT store_export_requests_receipt_chk CHECK
    ((consumed_at IS NULL) = (manifest_sha256 IS NULL)),
  CONSTRAINT store_export_requests_store_fk FOREIGN KEY (org_id,store_id) REFERENCES stores(org_id,id),
  CONSTRAINT store_export_requests_actor_fk FOREIGN KEY (org_id,actor_id) REFERENCES staffs(org_id,id),
  CONSTRAINT store_export_requests_session_fk FOREIGN KEY (org_id,store_id,session_id) REFERENCES sessions(org_id,store_id,id)
);
ALTER TABLE public.store_export_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_export_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY store_export_requests_scope ON public.store_export_requests FOR ALL TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id',true),'')::uuid
    AND store_id = NULLIF(current_setting('app.store_id',true),'')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id',true),'')::uuid
    AND store_id = NULLIF(current_setting('app.store_id',true),'')::uuid);
CREATE POLICY store_export_requests_maintenance ON public.store_export_requests FOR ALL TO laundry_owner
  USING (true) WITH CHECK (true);
-- A valid signature is not a reusable capability: its committed receipt cannot
-- be cleared or replaced, even by an app SQL caller with column UPDATE grants.
CREATE FUNCTION public.guard_store_export_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL AND
    (NEW.consumed_at IS DISTINCT FROM OLD.consumed_at OR
     NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256)
  THEN RAISE EXCEPTION 'store export receipt is immutable'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_store_export_receipt() FROM PUBLIC;
CREATE TRIGGER store_export_receipt_guard BEFORE UPDATE ON public.store_export_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_store_export_receipt();
GRANT SELECT,INSERT ON public.store_export_requests TO laundry_app;
GRANT UPDATE(consumed_at,manifest_sha256) ON public.store_export_requests TO laundry_app;
CREATE INDEX store_export_requests_actor_idx ON public.store_export_requests(org_id,actor_id);
CREATE INDEX store_export_requests_session_idx ON public.store_export_requests(org_id,store_id,session_id);

-- Only the offline maintenance process may switch to this read-only role.
-- No application login inherits it; a database row or a GUC cannot unlock reads.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='laundry_store_exporter'
    AND NOT (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls))
  THEN RAISE EXCEPTION 'RUNTIME_EXPORT_ROLE_INVALID'; END IF;
  IF pg_has_role('laundry_app','laundry_store_exporter','MEMBER') THEN
    RAISE EXCEPTION 'application must not be a member of export reader';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO laundry_store_exporter;

-- Frozen ADR-81 table/column allowlist, matching store-export-policy.ts.
-- Column grants prevent credentials from being selected even by the reader.
GRANT SELECT ("id","org_id","store_id","policy_id","tool","decision","outcome","args_sha256","object_count","amount_cents","error_code","actor_staff_id","started_at","completed_at") ON public."ai_action_log" TO laundry_store_exporter;
CREATE POLICY ai_action_log_export_reader ON public."ai_action_log" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","staff_id","ai_session_id","turn_id","sequence","role","content","content_sha256","created_at") ON public."ai_messages" TO laundry_store_exporter;
CREATE POLICY ai_messages_export_reader ON public."ai_messages" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("provider_code","model_id","display_name","adapter_family","supports_streaming","supports_tools","supports_vision","max_input_tokens","max_output_tokens","status","registry_version","source_url","verified_at","created_at","updated_at") ON public."ai_model_registry" TO laundry_store_exporter;
CREATE POLICY ai_model_registry_export_reader ON public."ai_model_registry" FOR SELECT TO laundry_store_exporter USING (true);
GRANT SELECT ("id","org_id","store_id","staff_id","ai_session_id","turn_id","event_type","reason_code","content_sha256","created_at") ON public."ai_safety_events" TO laundry_store_exporter;
CREATE POLICY ai_safety_events_export_reader ON public."ai_safety_events" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("org_id","enabled","monthly_limit_micros","input_micros_per_million","output_micros_per_million","circuit_failure_threshold","circuit_open_seconds","updated_at","updated_by","provider_code","model_id","config_version") ON public."ai_safety_policies" TO laundry_store_exporter;
CREATE POLICY ai_safety_policies_export_reader ON public."ai_safety_policies" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","staff_id","status","next_event_cursor","created_at","updated_at","closed_at") ON public."ai_sessions" TO laundry_store_exporter;
CREATE POLICY ai_sessions_export_reader ON public."ai_sessions" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","staff_id","ai_session_id","turn_id","cursor","event_type","text_delta","tool_name","tool_step","tool_outcome","finish_reason","error_code","input_tokens","output_tokens","created_at") ON public."ai_stream_events" TO laundry_store_exporter;
CREATE POLICY ai_stream_events_export_reader ON public."ai_stream_events" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","staff_id","ai_session_id","turn_id","step","tool_name","request_sha256","result_sha256","outcome","duration_ms","created_at","result_count","source_count","filter_count") ON public."ai_tool_attempts" TO laundry_store_exporter;
CREATE POLICY ai_tool_attempts_export_reader ON public."ai_tool_attempts" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","staff_id","ai_session_id","idempotency_key","prompt_sha256","prompt_chars","max_output_tokens","status","output_bytes","event_count","tool_steps","error_code","created_at","started_at","completed_at","input_redactions") ON public."ai_turns" TO laundry_store_exporter;
CREATE POLICY ai_turns_export_reader ON public."ai_turns" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","staff_id","ai_session_id","turn_id","input_tokens","output_tokens","output_bytes","event_count","tool_steps","created_at","estimated_cost_micros","input_redactions","output_redactions") ON public."ai_usage" TO laundry_store_exporter;
CREATE POLICY ai_usage_export_reader ON public."ai_usage" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("org_id","store_id","usage_date","input_tokens","output_tokens","estimated_cost_micros","turn_count","updated_at") ON public."ai_usage_daily" TO laundry_store_exporter;
CREATE POLICY ai_usage_daily_export_reader ON public."ai_usage_daily" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","staff_id","via","command","idempotency_key","dry_run","entity","entity_id","before_json","after_json","ip","device_id","at") ON public."audit_log" TO laundry_store_exporter;
CREATE POLICY audit_log_export_reader ON public."audit_log" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","name","tool","tool_version","object_filter_json","schedule_json","limits_json","status","row_version","valid_from","valid_until","approved_by_staff_id","approved_at","next_run_at","last_run_at","last_outcome","consecutive_failures","created_by_staff_id","created_at","updated_by_staff_id","updated_at") ON public."automation_policies" TO laundry_store_exporter;
CREATE POLICY automation_policies_export_reader ON public."automation_policies" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("org_id","store_id","policy_id","business_date","run_count","amount_cents","updated_at") ON public."automation_policy_usage_daily" TO laundry_store_exporter;
CREATE POLICY automation_policy_usage_daily_export_reader ON public."automation_policy_usage_daily" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("org_id","store_id","batch_id","order_id","garment_id","state","qc_status","added_by_staff_id","added_by_device_id","added_at","updated_by_staff_id","updated_by_device_id","updated_at") ON public."batch_garments" TO laundry_store_exporter;
CREATE POLICY batch_garments_export_reader ON public."batch_garments" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","campaign_id","campaign_version","audience_rule_sha256","audience_digest","recipient_count","created_by_staff_id","created_at") ON public."campaign_audience_snapshots" TO laundry_store_exporter;
CREATE POLICY campaign_audience_snapshots_export_reader ON public."campaign_audience_snapshots" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","campaign_id","kind","source_id","amount_cents","staff_id","at") ON public."campaign_budget_ledger" TO laundry_store_exporter;
CREATE POLICY campaign_budget_ledger_export_reader ON public."campaign_budget_ledger" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","campaign_id","campaign_version","audience_snapshot_id","audience_digest","coupon_definition_id","coupon_version","coupon_code","coupon_name","coupon_discount_cents","coupon_min_order_cents","coupon_valid_days","audience_recipient_count","eligible_recipient_count","granted_count","budget_committed_cents","reason","created_by_staff_id","created_at") ON public."campaign_coupon_batches" TO laundry_store_exporter;
CREATE POLICY campaign_coupon_batches_export_reader ON public."campaign_coupon_batches" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","batch_id","campaign_id","audience_snapshot_id","coupon_grant_id","account_id","created_at") ON public."campaign_coupon_grants" TO laundry_store_exporter;
CREATE POLICY campaign_coupon_grants_export_reader ON public."campaign_coupon_grants" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","code","name","status","starts_at","ends_at","audience_rule","audience_rule_sha256","recipient_limit","budget_limit_cents","version","created_by_staff_id","created_at","updated_by_staff_id","updated_at") ON public."campaigns" TO laundry_store_exporter;
CREATE POLICY campaigns_export_reader ON public."campaigns" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","code","name","service_code","category_code","unit_price_cents","mnemonic","is_active","sort_order","created_at","updated_at","version") ON public."catalog_items" TO laundry_store_exporter;
CREATE POLICY catalog_items_export_reader ON public."catalog_items" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","account_id","definition_id","code","name","discount_cents","min_order_cents","granted_on","expires_on","granted_at","granted_store_id","granted_by_staff_id","reason") ON public."coupon_grants" TO laundry_store_exporter;
CREATE POLICY coupon_grants_export_reader ON public."coupon_grants" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","redemption_id","grant_id","order_id","staff_id","at","reason") ON public."coupon_redemption_reversals" TO laundry_store_exporter;
CREATE POLICY coupon_redemption_reversals_export_reader ON public."coupon_redemption_reversals" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","grant_id","account_id","order_id","discount_cents","staff_id","at") ON public."coupon_redemptions" TO laundry_store_exporter;
CREATE POLICY coupon_redemptions_export_reader ON public."coupon_redemptions" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","code","name","discount_cents","min_order_cents","valid_days","status","version","updated_at","updated_by_staff_id","note") ON public."coupons" TO laundry_store_exporter;
CREATE POLICY coupons_export_reader ON public."coupons" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","customer_id","profile_version","label","recipient","contact_phone","address_body","is_default","retired_at","pii_purged_at","created_at","updated_at","portal_managed") ON public."customer_addresses" TO laundry_store_exporter;
CREATE POLICY customer_addresses_export_reader ON public."customer_addresses" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","customer_id","profile_version","kind","raw_value","normalized_value","retired_at","pii_purged_at","created_at","updated_at") ON public."customer_identifiers" TO laundry_store_exporter;
CREATE POLICY customer_identifiers_export_reader ON public."customer_identifiers" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","customer_id","session_id","operation","resource_id","at","address_count","preference","profile_version") ON public."customer_portal_access_log" TO laundry_store_exporter;
CREATE POLICY customer_portal_access_log_export_reader ON public."customer_portal_access_log" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("org_id","customer_id","version","preferred_contact","updated_at") ON public."customer_portal_preferences" TO laundry_store_exporter;
CREATE POLICY customer_portal_preferences_export_reader ON public."customer_portal_preferences" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","origin_store_id","customer_id","staff_id","action","reason","affected_order_count","created_at") ON public."customer_privacy_events" TO laundry_store_exporter;
CREATE POLICY customer_privacy_events_export_reader ON public."customer_privacy_events" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("org_id","customer_id","version","gender","preferred_contact","service_note","skip_ticket_print","skip_label_print","skip_rack_assignment","discount_bps","origin_store_id","updated_by_staff_id","created_at","updated_at") ON public."customer_profiles" TO laundry_store_exporter;
CREATE POLICY customer_profiles_export_reader ON public."customer_profiles" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","phone","name","note","created_at","updated_at","merged_into_id","merged_at","anonymized_at","anonymized_by_staff_id","version") ON public."customers" TO laundry_store_exporter;
CREATE POLICY customers_export_reader ON public."customers" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","customer_id","address_id","direction","service_area_code","scheduled_start_at","scheduled_end_at","fee_cents","status","version","policy_version","cancellation_reason","cancelled_at","created_at","updated_at","created_by_staff_id","updated_by_staff_id","cancelled_by_staff_id") ON public."delivery_appointments" TO laundry_store_exporter;
CREATE POLICY delivery_appointments_export_reader ON public."delivery_appointments" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("org_id","store_id","delivery_evidence_id","attachment_id","linked_at","linked_by_staff_id") ON public."delivery_evidence_attachment_links" TO laundry_store_exporter;
CREATE POLICY delivery_evidence_attachment_links_export_reader ON public."delivery_evidence_attachment_links" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","delivery_order_id","delivery_task_id","leg","delivery_task_version","assignee_staff_id","kind","storage_key","content_type","content_sha256","byte_size","captured_at","expires_at","created_at","created_by_staff_id") ON public."delivery_evidence_attachments" TO laundry_store_exporter;
CREATE POLICY delivery_evidence_attachments_export_reader ON public."delivery_evidence_attachments" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","delivery_order_id","delivery_task_id","leg","delivery_task_version","assignee_staff_id","event_kind","outcome","exception_reason","captured_at","latitude_e7","longitude_e7","accuracy_mm","gps_captured_at","recorded_at","recorded_by_staff_id") ON public."delivery_evidence_events" TO laundry_store_exporter;
CREATE POLICY delivery_evidence_events_export_reader ON public."delivery_evidence_events" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","laundry_order_id","customer_id","collection_method","return_method","pickup_appointment_id","return_appointment_id","pickup_fee_cents","return_fee_cents","total_fee_cents","status","version","cancellation_reason","completed_at","cancelled_at","created_at","updated_at","created_by_staff_id","updated_by_staff_id") ON public."delivery_orders" TO laundry_store_exporter;
CREATE POLICY delivery_orders_export_reader ON public."delivery_orders" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("org_id","store_id","accepting_appointments","minimum_lead_minutes","maximum_advance_days","slot_minutes","max_appointments_per_slot","service_areas_json","weekly_windows_json","version","updated_at","updated_by_staff_id") ON public."delivery_policies" TO laundry_store_exporter;
CREATE POLICY delivery_policies_export_reader ON public."delivery_policies" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","delivery_order_id","leg","assignee_staff_id","assigned_by_staff_id","predecessor_task_id","source","status","version","resolution_reason","accepted_at","rejected_at","transferred_at","taken_over_at","completed_at","cancelled_at","created_at","updated_at","created_by_staff_id","updated_by_staff_id") ON public."delivery_tasks" TO laundry_store_exporter;
CREATE POLICY delivery_tasks_export_reader ON public."delivery_tasks" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","reported_queue_id","accepted_queue_id","grant_id","lease_id","original_staff_id","replayed_by_staff_id","device_id","primary_epoch","reported_per_lease_seq","accepted_per_lease_seq","envelope_sha256","command","idempotency_key","decision","reason","result_json","recorded_at","authorization_kind","reported_per_grant_seq","accepted_per_grant_seq","privacy_subject_customer_id","pii_purged_at") ON public."edge_replay_records" TO laundry_store_exporter;
CREATE POLICY edge_replay_records_export_reader ON public."edge_replay_records" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","order_id","garment_id","kind","note","compensation_cents","staff_id","created_at") ON public."garment_incidents" TO laundry_store_exporter;
CREATE POLICY garment_incidents_export_reader ON public."garment_incidents" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","garment_id","order_id","kind","storage_key","content_type","byte_size","taken_at","created_by_staff_id","content_sha256") ON public."garment_photos" TO laundry_store_exporter;
CREATE POLICY garment_photos_export_reader ON public."garment_photos" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","batch_id","order_id","garment_id","inspection_no","outcome","reason_code","staff_id","device_id","inspected_at") ON public."garment_qc_log" TO laundry_store_exporter;
CREATE POLICY garment_qc_log_export_reader ON public."garment_qc_log" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","order_id","garment_id","barcode","rack_zone","rack_slot","staff_id","at") ON public."garment_rack_log" TO laundry_store_exporter;
CREATE POLICY garment_rack_log_export_reader ON public."garment_rack_log" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","order_id","garment_id","from_status","to_status","reason","staff_id","at") ON public."garment_status_log" TO laundry_store_exporter;
CREATE POLICY garment_status_log_export_reader ON public."garment_status_log" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","order_id","order_line_id","seq","barcode","service_code","category_code","unit_price_cents","color","brand","status","rack_zone","rack_slot","racked_at","racked_by_staff_id","defects","accessories","note","customer_pii_purged_at","custody_state","active_production_batch_id") ON public."garments" TO laundry_store_exporter;
CREATE POLICY garments_export_reader ON public."garments" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","voucher_id","order_id","order_original_cents","order_payable_before_cents","applied_discount_cents","reason","redeemed_by_staff_id","redeemed_at") ON public."group_buy_redemptions" TO laundry_store_exporter;
CREATE POLICY group_buy_redemptions_export_reader ON public."group_buy_redemptions" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","provider","external_order_ref","code_digest","code_last4","label","face_value_cents","expires_at","reason","registered_by_staff_id","registered_at") ON public."group_buy_vouchers" TO laundry_store_exporter;
CREATE POLICY group_buy_vouchers_export_reader ON public."group_buy_vouchers" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","customer_id","status","opened_at","opened_store_id","status_version","status_changed_at","status_reason","status_changed_by_staff_id","status_changed_store_id","customer_pii_purged_at") ON public."member_accounts" TO laundry_store_exporter;
CREATE POLICY member_accounts_export_reader ON public."member_accounts" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","min_topup_cents","bonus_cents","status","effective_from","updated_at","updated_by_staff_id","note") ON public."member_bonus_rules" TO laundry_store_exporter;
CREATE POLICY member_bonus_rules_export_reader ON public."member_bonus_rules" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","account_id","kind","principal_delta_cents","bonus_delta_cents","order_id","ref_ledger_id","staff_id","at","business_date","note","ledger_seq","tender","bonus_rule_id") ON public."member_ledger" TO laundry_store_exporter;
CREATE POLICY member_ledger_export_reader ON public."member_ledger" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("org_id","account_id","tier_id","tier_code","tier_name","tier_level","valid_until","version","updated_at","updated_store_id","updated_by_staff_id","reason","tier_definition_version","tier_discount_bps") ON public."member_memberships" TO laundry_store_exporter;
CREATE POLICY member_memberships_export_reader ON public."member_memberships" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","unit_cents","points_per_unit","valid_days","status","version","updated_at","updated_by_staff_id","note") ON public."member_points_policies" TO laundry_store_exporter;
CREATE POLICY member_points_policies_export_reader ON public."member_points_policies" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","code","name","total_uses","valid_days","status","version","updated_at","updated_by_staff_id","note") ON public."member_punch_types" TO laundry_store_exporter;
CREATE POLICY member_punch_types_export_reader ON public."member_punch_types" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","code","name","level","status","version","updated_at","updated_by_staff_id","note","discount_bps") ON public."member_tiers" TO laundry_store_exporter;
CREATE POLICY member_tiers_export_reader ON public."member_tiers" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","batch_id","order_id","customer_id","status","message_sha256","attempt_count","next_attempt_at","claimed_at","last_error_code","provider_ref_sha256","cost_cents","reserved_cost_cents","provider_outcome_pending","accepted_at","delivered_at","created_at","updated_at","receipt_checked_at") ON public."notification_deliveries" TO laundry_store_exporter;
CREATE POLICY notification_deliveries_export_reader ON public."notification_deliveries" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","delivery_id","attempt_no","outcome","error_code","provider_ref_sha256","cost_cents","started_at","completed_at") ON public."notification_delivery_attempts" TO laundry_store_exporter;
CREATE POLICY notification_delivery_attempts_export_reader ON public."notification_delivery_attempts" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","provider_code","assurance","channel","template_id","template_code","template_version","min_age_days","unpaid_only","garment_statuses","recipient_count","estimated_cost_cents","max_cost_cents","created_by_staff_id","created_at") ON public."notification_delivery_batches" TO laundry_store_exporter;
CREATE POLICY notification_delivery_batches_export_reader ON public."notification_delivery_batches" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","delivery_id","provider_code","receipt_sha256","status","observed_at","recorded_at") ON public."notification_delivery_receipts" TO laundry_store_exporter;
CREATE POLICY notification_delivery_receipts_export_reader ON public."notification_delivery_receipts" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","batch_id","order_id","customer_id","channel","status","grouping","message_sha256","export_sha256","cost_cents","created_by_staff_id","created_at") ON public."notification_log" TO laundry_store_exporter;
CREATE POLICY notification_log_export_reader ON public."notification_log" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("org_id","store_id","version","enabled","provider","sign_name","template_code","unit_cost_cents","max_batch_cost_cents","updated_at","updated_by") ON public."notification_provider_settings" TO laundry_store_exporter;
CREATE POLICY notification_provider_settings_export_reader ON public."notification_provider_settings" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","code","version","channel","body","status","created_at") ON public."notification_templates" TO laundry_store_exporter;
CREATE POLICY notification_templates_export_reader ON public."notification_templates" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","order_id","line_index","service_code","category_code","unit_price_cents","qty","line_total_cents","color","brand","garment_details_json") ON public."order_lines" TO laundry_store_exporter;
CREATE POLICY order_lines_export_reader ON public."order_lines" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","ticket_no","status","customer_phone","customer_name","note","subtotal_cents","payable_cents","paid_cents","balance_cents","created_at","updated_at","created_by_staff_id","original_cents","discount_cents","addon_cents","urgent_cents","freight_cents","business_date","pickup_code","customer_id","pricing_policy_version","urgent_selected","freight_selected","customer_profile_version","discount_source","discount_bps","membership_version","tier_id","tier_definition_version","tier_code","tier_name","tier_level","tier_discount_bps","skip_ticket_print","skip_label_print","skip_rack_assignment","customer_pii_purged_at") ON public."orders" TO laundry_store_exporter;
CREATE POLICY orders_export_reader ON public."orders" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","code","name","created_at","updated_at","demo_only") ON public."orgs" TO laundry_store_exporter;
CREATE POLICY orgs_export_reader ON public."orgs" FOR SELECT TO laundry_store_exporter USING (id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","order_id","method","amount_cents","kind","ref_payment_id","staff_id","at","note","business_date","ledger_seq") ON public."payments" TO laundry_store_exporter;
CREATE POLICY payments_export_reader ON public."payments" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","redeem_ledger_id","earn_ledger_id","points") ON public."points_allocations" TO laundry_store_exporter;
CREATE POLICY points_allocations_export_reader ON public."points_allocations" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","account_id","kind","points_delta","order_id","policy_id","source_paid_cents","policy_unit_cents","policy_points_per_unit","expires_on","staff_id","at","note") ON public."points_ledger" TO laundry_store_exporter;
CREATE POLICY points_ledger_export_reader ON public."points_ledger" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","order_id","ticket_no","kind","status","error","created_at","updated_at","attempt_count","claimed_at","artifact_sha256","artifact_bytes","completed_at","snapshot_json","snapshot_sha256","snapshot_purged_at","printer_kind","source_job_id","dispatch_device_id","dispatch_staff_id","dispatch_issued_at","dispatch_expires_at","receipt_seq","receipt_result","cups_job_id","receipt_at","receipt_json","receipt_envelope_sha256","settled_at","idempotency_key") ON public."print_jobs" TO laundry_store_exporter;
CREATE POLICY print_jobs_export_reader ON public."print_jobs" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","factory_code","status","version","expected_garment_count","exception_garment_count","created_by_staff_id","created_by_device_id","created_at","updated_by_staff_id","updated_by_device_id","updated_at","completed_at","cancel_reason_code") ON public."production_batches" TO laundry_store_exporter;
CREATE POLICY production_batches_export_reader ON public."production_batches" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","batch_id","attempt_id","checkpoint","garment_id","barcode","outcome","recorded_at") ON public."production_handoff_attempt_items" TO laundry_store_exporter;
CREATE POLICY production_handoff_attempt_items_export_reader ON public."production_handoff_attempt_items" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","batch_id","batch_version","checkpoint","attempt_no","outcome","expected_count","scanned_count","matched_count","missing_count","unexpected_count","staff_id","device_id","recorded_at") ON public."production_handoff_attempts" TO laundry_store_exporter;
CREATE POLICY production_handoff_attempts_export_reader ON public."production_handoff_attempts" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","batch_id","checkpoint","attempt_id","outcome","matched_count","missing_count","unexpected_count","staff_id","device_id","completed_at") ON public."production_handoff_checkpoints" TO laundry_store_exporter;
CREATE POLICY production_handoff_checkpoints_export_reader ON public."production_handoff_checkpoints" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","batch_id","checkpoint","attempt_id","resolution_code","staff_id","device_id","resolved_at") ON public."production_handoff_discrepancy_resolutions" TO laundry_store_exporter;
CREATE POLICY production_handoff_discrepancy_resolutions_export_reader ON public."production_handoff_discrepancy_resolutions" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","card_id","account_id","uses","staff_id","at","reason") ON public."punch_card_ledger" TO laundry_store_exporter;
CREATE POLICY punch_card_ledger_export_reader ON public."punch_card_ledger" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","account_id","definition_id","code","name","total_uses","issued_on","expires_on","issued_at","issued_store_id","issued_by_staff_id","reason") ON public."punch_cards" TO laundry_store_exporter;
CREATE POLICY punch_cards_export_reader ON public."punch_cards" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","campaign_id","campaign_version","referrer_customer_id","referrer_account_id","referred_customer_id","referred_account_id","qualifying_order_id","coupon_definition_id","coupon_version","coupon_code","coupon_name","coupon_discount_cents","coupon_min_order_cents","coupon_valid_days","coupon_grant_id","reward_cents","budget_remaining_before_cents","reason","created_by_staff_id","created_at") ON public."referral_rewards" TO laundry_store_exporter;
CREATE POLICY referral_rewards_export_reader ON public."referral_rewards" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","key","value_json","updated_at","updated_by_staff_id") ON public."settings" TO laundry_store_exporter;
CREATE POLICY settings_export_reader ON public."settings" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","business_date","closed_by_staff_id","note","order_count","payable_cents","paid_cents","payment_cents","signature_name","closed_at","opening_float_cents","counted_cash_cents","retained_float_cents","expected_cash_cents","cash_difference_cents","period_started_at","period_ended_at") ON public."shift_closings" TO laundry_store_exporter;
CREATE POLICY shift_closings_export_reader ON public."shift_closings" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","username","display_name","is_active","created_at","updated_at","last_login_at") ON public."staffs" TO laundry_store_exporter;
CREATE POLICY staffs_export_reader ON public."staffs" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","fulfillment","membership","shift_closing","delivery","marketing","ai","updated_at","customer_portal") ON public."store_features" TO laundry_store_exporter;
CREATE POLICY store_features_export_reader ON public."store_features" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("org_id","store_id","urgent_cents","freight_cents","addons_json","version","updated_at","updated_by_staff_id") ON public."store_pricing_policies" TO laundry_store_exporter;
CREATE POLICY store_pricing_policies_export_reader ON public."store_pricing_policies" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","code","name","timezone","created_at","updated_at","profile_version") ON public."stores" TO laundry_store_exporter;
CREATE POLICY stores_export_reader ON public."stores" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","source_sha256","plan_sha256","mapping_version","backup_point_id","totals","actor_id","created_at") ON public."v1_import_batches" TO laundry_store_exporter;
CREATE POLICY v1_import_batches_export_reader ON public."v1_import_batches" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT ("id","org_id","store_id","batch_id","entity_type","entity_id","customer_id","metadata") ON public."v1_import_legacy_records" TO laundry_store_exporter;
CREATE POLICY v1_import_legacy_records_export_reader ON public."v1_import_legacy_records" FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);

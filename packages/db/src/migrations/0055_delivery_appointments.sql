-- ADR-47 customer delivery appointment capacity ledger.
--
-- Expand-only: appointments retain opaque customer/address references but copy
-- no recipient name, phone, street address, GPS coordinate or free-form note.

CREATE TABLE IF NOT EXISTS public.delivery_appointments (
  id uuid NOT NULL,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  address_id uuid NOT NULL,
  direction text NOT NULL,
  service_area_code text NOT NULL,
  scheduled_start_at timestamptz NOT NULL,
  scheduled_end_at timestamptz NOT NULL,
  fee_cents integer NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  version integer NOT NULL DEFAULT 1,
  policy_version integer NOT NULL,
  cancellation_reason text,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_by_staff_id uuid NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  cancelled_by_staff_id uuid,
  CONSTRAINT delivery_appointments_pkey PRIMARY KEY (id),
  CONSTRAINT delivery_appointments_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT delivery_appointments_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT delivery_appointments_customer_fk
    FOREIGN KEY (org_id, customer_id) REFERENCES public.customers (org_id, id),
  CONSTRAINT delivery_appointments_address_fk
    FOREIGN KEY (org_id, address_id)
    REFERENCES public.customer_addresses (org_id, id),
  CONSTRAINT delivery_appointments_created_staff_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT delivery_appointments_updated_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT delivery_appointments_cancelled_staff_fk
    FOREIGN KEY (org_id, cancelled_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT delivery_appointments_direction_chk CHECK (direction IN ('pickup', 'return')),
  CONSTRAINT delivery_appointments_area_code_chk
    CHECK (service_area_code ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  CONSTRAINT delivery_appointments_time_chk CHECK (scheduled_end_at > scheduled_start_at),
  CONSTRAINT delivery_appointments_fee_chk CHECK (fee_cents >= 0),
  CONSTRAINT delivery_appointments_status_chk CHECK (status IN ('scheduled', 'cancelled')),
  CONSTRAINT delivery_appointments_version_chk CHECK (version > 0),
  CONSTRAINT delivery_appointments_policy_version_chk CHECK (policy_version > 0),
  CONSTRAINT delivery_appointments_updated_chk CHECK (updated_at >= created_at),
  CONSTRAINT delivery_appointments_cancellation_reason_chk CHECK (
    cancellation_reason IS NULL OR cancellation_reason IN (
      'customer_request', 'store_request', 'unreachable', 'duplicate', 'other'
    )
  ),
  CONSTRAINT delivery_appointments_cancellation_state_chk CHECK (
    (
      status = 'scheduled'
      AND cancellation_reason IS NULL
      AND cancelled_at IS NULL
      AND cancelled_by_staff_id IS NULL
    )
    OR
    (
      status = 'cancelled'
      AND cancellation_reason IS NOT NULL
      AND cancelled_at IS NOT NULL
      AND cancelled_by_staff_id IS NOT NULL
    )
  )
);

CREATE OR REPLACE FUNCTION public.guard_delivery_appointment_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  db_now timestamptz := statement_timestamp();
  actor_id uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'scheduled' OR NEW.version <> 1
       OR NEW.cancellation_reason IS NOT NULL OR NEW.cancelled_at IS NOT NULL
       OR NEW.cancelled_by_staff_id IS NOT NULL THEN
      RAISE check_violation USING MESSAGE = 'delivery appointment must start scheduled';
    END IF;
    IF NEW.updated_by_staff_id IS DISTINCT FROM NEW.created_by_staff_id THEN
      RAISE check_violation USING MESSAGE = 'delivery appointment initial actors must match';
    END IF;
    IF session_user = 'laundry_app' AND (
      actor_id IS NULL
      OR NEW.created_by_staff_id IS DISTINCT FROM actor_id
    ) THEN
      RAISE insufficient_privilege USING MESSAGE = 'delivery appointment actor mismatch';
    END IF;
    NEW.created_at := db_now;
    NEW.updated_at := db_now;
  ELSE
    IF OLD.status = 'cancelled' THEN
      RAISE insufficient_privilege USING MESSAGE = 'cancelled delivery appointment is immutable';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.org_id IS DISTINCT FROM OLD.org_id
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.address_id IS DISTINCT FROM OLD.address_id
       OR NEW.direction IS DISTINCT FROM OLD.direction
       OR NEW.service_area_code IS DISTINCT FROM OLD.service_area_code
       OR NEW.created_by_staff_id IS DISTINCT FROM OLD.created_by_staff_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE insufficient_privilege USING MESSAGE = 'delivery appointment identity is immutable';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE check_violation USING MESSAGE = 'delivery appointment version must advance by one';
    END IF;
    IF db_now < OLD.updated_at THEN
      RAISE check_violation USING MESSAGE = 'delivery appointment time must be monotonic';
    END IF;
    IF session_user = 'laundry_app' AND (
      actor_id IS NULL
      OR NEW.updated_by_staff_id IS DISTINCT FROM actor_id
    ) THEN
      RAISE insufficient_privilege USING MESSAGE = 'delivery appointment actor mismatch';
    END IF;
    IF NEW.status = 'scheduled' THEN
      IF NEW.cancellation_reason IS NOT NULL OR NEW.cancelled_at IS NOT NULL
         OR NEW.cancelled_by_staff_id IS NOT NULL THEN
        RAISE check_violation USING MESSAGE = 'scheduled appointment cannot carry cancellation';
      END IF;
    ELSIF NEW.status = 'cancelled' THEN
      IF NEW.scheduled_start_at IS DISTINCT FROM OLD.scheduled_start_at
         OR NEW.scheduled_end_at IS DISTINCT FROM OLD.scheduled_end_at
         OR NEW.fee_cents IS DISTINCT FROM OLD.fee_cents
         OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
         OR NEW.cancellation_reason IS NULL
         OR NEW.cancelled_by_staff_id IS NULL
         OR NEW.cancelled_by_staff_id IS DISTINCT FROM NEW.updated_by_staff_id THEN
        RAISE check_violation USING MESSAGE = 'invalid delivery appointment cancellation';
      END IF;
      NEW.cancelled_at := db_now;
    ELSE
      RAISE check_violation USING MESSAGE = 'illegal delivery appointment transition';
    END IF;
    NEW.updated_at := db_now;
  END IF;

  IF NEW.status = 'scheduled' THEN
    PERFORM 1
      FROM customers requested
      JOIN customers root
        ON root.org_id = requested.org_id
       AND root.id = customer_canonical_root(requested.id)
      JOIN customer_canonical_group(requested.id) canonical ON true
      JOIN customers owner
        ON owner.org_id = requested.org_id
       AND owner.id = canonical.group_customer_id
      JOIN customer_addresses address_row
        ON address_row.org_id = owner.org_id
       AND address_row.customer_id = owner.id
     WHERE requested.org_id = NEW.org_id AND requested.id = NEW.customer_id
       AND root.merged_into_id IS NULL AND root.anonymized_at IS NULL
       AND address_row.id = NEW.address_id
       AND address_row.retired_at IS NULL AND address_row.pii_purged_at IS NULL
     FOR SHARE OF requested, root, owner, address_row;
    IF NOT FOUND THEN
      RAISE foreign_key_violation USING MESSAGE = 'delivery appointment address unavailable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'delivery_appointment_write_guard_trg'
       AND tgrelid = 'public.delivery_appointments'::regclass
  ) THEN
    CREATE TRIGGER delivery_appointment_write_guard_trg
      BEFORE INSERT OR UPDATE ON public.delivery_appointments
      FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_appointment_write();
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS delivery_appointments_slot_capacity_idx
  ON public.delivery_appointments (org_id, store_id, scheduled_start_at, id)
  WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS delivery_appointments_customer_worklist_idx
  ON public.delivery_appointments (org_id, store_id, customer_id, scheduled_start_at DESC, id);

CREATE INDEX IF NOT EXISTS delivery_appointments_store_worklist_idx
  ON public.delivery_appointments (org_id, store_id, scheduled_start_at DESC, id);

CREATE UNIQUE INDEX IF NOT EXISTS delivery_appointments_customer_slot_uidx
  ON public.delivery_appointments (
    org_id, store_id, customer_id, direction, scheduled_start_at
  )
  WHERE status = 'scheduled';

ALTER TABLE public.delivery_appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_appointments FORCE ROW LEVEL SECURITY;

CREATE POLICY delivery_appointments_store_scope ON public.delivery_appointments
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );

CREATE POLICY delivery_appointments_maintenance ON public.delivery_appointments
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON TABLE public.delivery_appointments TO laundry_app;
REVOKE DELETE, TRUNCATE ON TABLE public.delivery_appointments FROM laundry_app;
REVOKE ALL ON FUNCTION public.guard_delivery_appointment_write() FROM PUBLIC;

-- R3 first-hop retry with the same command idempotency key reuses one frozen card.
CREATE UNIQUE INDEX IF NOT EXISTS ai_pending_delivery_appointment_idempotency_uidx
  ON public.ai_pending_actions (org_id, store_id, command, idempotency_key)
  WHERE command IN (
    'delivery.appointment.create',
    'delivery.appointment.reschedule',
    'delivery.appointment.cancel'
  );

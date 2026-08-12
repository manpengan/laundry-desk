-- ADR-48 authoritative delivery order and logistics lifecycle.
--
-- Delivery orders bind existing laundry orders and immutable appointment
-- references. Tasks, drivers, routes, GPS, photos and signatures remain out of
-- scope; completion is gated by the existing garment/order authority.

CREATE TABLE IF NOT EXISTS public.delivery_orders (
  id uuid NOT NULL,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  laundry_order_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  collection_method text NOT NULL,
  return_method text NOT NULL,
  pickup_appointment_id uuid,
  return_appointment_id uuid,
  pickup_fee_cents integer NOT NULL DEFAULT 0,
  return_fee_cents integer NOT NULL DEFAULT 0,
  total_fee_cents integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  cancellation_reason text,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_by_staff_id uuid NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  CONSTRAINT delivery_orders_pkey PRIMARY KEY (id),
  CONSTRAINT delivery_orders_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT delivery_orders_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT delivery_orders_laundry_order_fk
    FOREIGN KEY (org_id, store_id, laundry_order_id)
    REFERENCES public.orders (org_id, store_id, id),
  CONSTRAINT delivery_orders_customer_fk
    FOREIGN KEY (org_id, customer_id) REFERENCES public.customers (org_id, id),
  CONSTRAINT delivery_orders_pickup_appointment_fk
    FOREIGN KEY (org_id, store_id, pickup_appointment_id)
    REFERENCES public.delivery_appointments (org_id, store_id, id),
  CONSTRAINT delivery_orders_return_appointment_fk
    FOREIGN KEY (org_id, store_id, return_appointment_id)
    REFERENCES public.delivery_appointments (org_id, store_id, id),
  CONSTRAINT delivery_orders_created_staff_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT delivery_orders_updated_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT delivery_orders_collection_method_chk
    CHECK (collection_method IN ('pickup', 'store_dropoff')),
  CONSTRAINT delivery_orders_return_method_chk
    CHECK (return_method IN ('delivery', 'self_pickup')),
  CONSTRAINT delivery_orders_route_shape_chk CHECK (
    (collection_method = 'pickup') = (pickup_appointment_id IS NOT NULL)
    AND (return_method = 'delivery') = (return_appointment_id IS NOT NULL)
    AND NOT (collection_method = 'store_dropoff' AND return_method = 'self_pickup')
  ),
  CONSTRAINT delivery_orders_fee_chk CHECK (
    pickup_fee_cents >= 0 AND return_fee_cents >= 0
    AND total_fee_cents = pickup_fee_cents + return_fee_cents
  ),
  CONSTRAINT delivery_orders_status_chk CHECK (status IN (
    'pickup_scheduled', 'pickup_in_progress', 'picked_up', 'at_store',
    'return_scheduled', 'return_in_progress', 'self_pickup_ready',
    'completed', 'cancelled'
  )),
  CONSTRAINT delivery_orders_version_chk CHECK (version > 0),
  CONSTRAINT delivery_orders_time_chk CHECK (
    updated_at >= created_at
    AND (completed_at IS NULL OR completed_at >= created_at)
    AND (cancelled_at IS NULL OR cancelled_at >= created_at)
  ),
  CONSTRAINT delivery_orders_terminal_shape_chk CHECK (
    (
      status = 'completed' AND completed_at IS NOT NULL
      AND cancelled_at IS NULL AND cancellation_reason IS NULL
    ) OR (
      status = 'cancelled' AND cancelled_at IS NOT NULL
      AND cancellation_reason IS NOT NULL AND completed_at IS NULL
    ) OR (
      status NOT IN ('completed', 'cancelled')
      AND completed_at IS NULL AND cancelled_at IS NULL AND cancellation_reason IS NULL
    )
  ),
  CONSTRAINT delivery_orders_cancellation_reason_chk CHECK (
    cancellation_reason IS NULL OR cancellation_reason IN (
      'customer_request', 'store_request', 'appointment_cancelled', 'duplicate', 'other'
    )
  )
);

CREATE OR REPLACE FUNCTION public.delivery_order_transition_allowed(
  current_status text,
  target_status text,
  return_mode text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE current_status
    WHEN 'pickup_scheduled' THEN target_status IN ('pickup_in_progress', 'cancelled')
    WHEN 'pickup_in_progress' THEN target_status IN ('picked_up', 'cancelled')
    WHEN 'picked_up' THEN target_status = 'at_store'
    WHEN 'at_store' THEN target_status = 'cancelled' OR (
      return_mode = 'delivery' AND target_status = 'return_scheduled'
    ) OR (
      return_mode = 'self_pickup' AND target_status = 'self_pickup_ready'
    )
    WHEN 'return_scheduled' THEN target_status IN ('return_in_progress', 'cancelled')
    WHEN 'return_in_progress' THEN target_status = 'completed'
    WHEN 'self_pickup_ready' THEN target_status = 'completed'
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION public.guard_delivery_order_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  db_now timestamptz := statement_timestamp();
  actor_id uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  canonical_customer_id uuid;
  linked_order_status text;
  pickup_fee integer := 0;
  return_fee integer := 0;
  garment_count integer;
  invalid_garment_count integer;
  fulfillment_enabled boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF session_user = 'laundry_app' AND (
      actor_id IS NULL OR NEW.created_by_staff_id IS DISTINCT FROM actor_id
      OR NEW.updated_by_staff_id IS DISTINCT FROM actor_id
    ) THEN
      RAISE insufficient_privilege USING MESSAGE = 'delivery order actor mismatch';
    END IF;
    PERFORM 1 FROM store_features
     WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND delivery = true
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE check_violation USING MESSAGE = 'delivery feature is disabled';
    END IF;
    SELECT root.id, order_row.status
      INTO canonical_customer_id, linked_order_status
      FROM orders order_row
      JOIN customers requested
        ON requested.org_id = order_row.org_id AND requested.id = order_row.customer_id
      JOIN customers root
        ON root.org_id = requested.org_id
       AND root.id = customer_canonical_root(requested.id)
     WHERE order_row.org_id = NEW.org_id AND order_row.store_id = NEW.store_id
       AND order_row.id = NEW.laundry_order_id
       AND root.merged_into_id IS NULL AND root.anonymized_at IS NULL
     FOR SHARE OF order_row, requested, root;
    IF canonical_customer_id IS NULL THEN
      RAISE foreign_key_violation USING MESSAGE = 'delivery laundry order customer unavailable';
    END IF;
    IF (NEW.collection_method = 'pickup' AND linked_order_status <> 'draft')
       OR (NEW.collection_method = 'store_dropoff' AND linked_order_status <> 'open') THEN
      RAISE check_violation USING MESSAGE = 'delivery collection method conflicts with laundry order';
    END IF;
    IF NEW.collection_method = 'pickup' THEN
      SELECT appointment.fee_cents INTO pickup_fee
        FROM delivery_appointments appointment
        JOIN customer_canonical_group(appointment.customer_id) canonical ON true
        JOIN customer_addresses address_row
          ON address_row.org_id = appointment.org_id
         AND address_row.customer_id = canonical.group_customer_id
         AND address_row.id = appointment.address_id
       WHERE appointment.org_id = NEW.org_id AND appointment.store_id = NEW.store_id
         AND appointment.id = NEW.pickup_appointment_id
         AND appointment.status = 'scheduled' AND appointment.direction = 'pickup'
         AND customer_canonical_root(appointment.customer_id) = canonical_customer_id
         AND address_row.retired_at IS NULL AND address_row.pii_purged_at IS NULL
       FOR SHARE OF appointment, address_row;
      IF NOT FOUND THEN
        RAISE foreign_key_violation USING MESSAGE = 'pickup appointment unavailable';
      END IF;
    END IF;
    IF NEW.return_method = 'delivery' THEN
      SELECT appointment.fee_cents INTO return_fee
        FROM delivery_appointments appointment
        JOIN customer_canonical_group(appointment.customer_id) canonical ON true
        JOIN customer_addresses address_row
          ON address_row.org_id = appointment.org_id
         AND address_row.customer_id = canonical.group_customer_id
         AND address_row.id = appointment.address_id
       WHERE appointment.org_id = NEW.org_id AND appointment.store_id = NEW.store_id
         AND appointment.id = NEW.return_appointment_id
         AND appointment.status = 'scheduled' AND appointment.direction = 'return'
         AND customer_canonical_root(appointment.customer_id) = canonical_customer_id
         AND address_row.retired_at IS NULL AND address_row.pii_purged_at IS NULL
       FOR SHARE OF appointment, address_row;
      IF NOT FOUND THEN
        RAISE foreign_key_violation USING MESSAGE = 'return appointment unavailable';
      END IF;
    END IF;
    IF pickup_fee::bigint + return_fee::bigint > 2147483647 THEN
      RAISE numeric_value_out_of_range USING MESSAGE = 'delivery fee total exceeds integer cents';
    END IF;
    NEW.customer_id := canonical_customer_id;
    NEW.pickup_fee_cents := pickup_fee;
    NEW.return_fee_cents := return_fee;
    NEW.total_fee_cents := pickup_fee + return_fee;
    NEW.status := CASE NEW.collection_method
      WHEN 'pickup' THEN 'pickup_scheduled' ELSE 'at_store' END;
    NEW.version := 1;
    NEW.cancellation_reason := NULL;
    NEW.completed_at := NULL;
    NEW.cancelled_at := NULL;
    NEW.created_at := db_now;
    NEW.updated_at := db_now;
  ELSE
    IF OLD.status IN ('completed', 'cancelled') THEN
      RAISE insufficient_privilege USING MESSAGE = 'terminal delivery order is immutable';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.laundry_order_id IS DISTINCT FROM OLD.laundry_order_id
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.collection_method IS DISTINCT FROM OLD.collection_method
       OR NEW.return_method IS DISTINCT FROM OLD.return_method
       OR NEW.pickup_appointment_id IS DISTINCT FROM OLD.pickup_appointment_id
       OR NEW.return_appointment_id IS DISTINCT FROM OLD.return_appointment_id
       OR NEW.pickup_fee_cents IS DISTINCT FROM OLD.pickup_fee_cents
       OR NEW.return_fee_cents IS DISTINCT FROM OLD.return_fee_cents
       OR NEW.total_fee_cents IS DISTINCT FROM OLD.total_fee_cents
       OR NEW.created_by_staff_id IS DISTINCT FROM OLD.created_by_staff_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE insufficient_privilege USING MESSAGE = 'delivery order identity is immutable';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE check_violation USING MESSAGE = 'delivery order version must advance by one';
    END IF;
    IF NOT delivery_order_transition_allowed(OLD.status, NEW.status, OLD.return_method) THEN
      RAISE check_violation USING MESSAGE = 'illegal delivery order transition';
    END IF;
    IF db_now < OLD.updated_at THEN
      RAISE check_violation USING MESSAGE = 'delivery order time must be monotonic';
    END IF;
    IF session_user = 'laundry_app' AND (
      actor_id IS NULL OR NEW.updated_by_staff_id IS DISTINCT FROM actor_id
    ) THEN
      RAISE insufficient_privilege USING MESSAGE = 'delivery order actor mismatch';
    END IF;

    IF OLD.status = 'at_store' AND NEW.status IN ('return_scheduled', 'self_pickup_ready') THEN
      SELECT features.fulfillment INTO fulfillment_enabled
        FROM store_features features
       WHERE features.org_id = OLD.org_id AND features.store_id = OLD.store_id
       FOR SHARE;
      SELECT count(*)::integer,
             count(*) FILTER (WHERE
               garment.active_production_batch_id IS NOT NULL
               OR NOT (
                 (garment.status = 'lost' AND garment.custody_state = 'exception')
                 OR (
                   garment.custody_state = 'store' AND (
                     (NEW.status = 'self_pickup_ready' AND (
                       garment.status = 'racked'
                       OR (NOT COALESCE(fulfillment_enabled, true) AND garment.status = 'received')
                     ))
                     OR (NEW.status = 'return_scheduled' AND (
                       garment.status IN ('ready', 'racked')
                       OR (NOT COALESCE(fulfillment_enabled, true) AND garment.status = 'received')
                     ))
                   )
                 )
               )
             )::integer
        INTO garment_count, invalid_garment_count
        FROM garments garment
       WHERE garment.org_id = OLD.org_id AND garment.store_id = OLD.store_id
         AND garment.order_id = OLD.laundry_order_id;
      SELECT status INTO linked_order_status FROM orders
       WHERE org_id = OLD.org_id AND store_id = OLD.store_id AND id = OLD.laundry_order_id
       FOR SHARE;
      IF linked_order_status <> 'open' OR garment_count = 0 OR invalid_garment_count <> 0 THEN
        RAISE check_violation USING MESSAGE = 'laundry order is not ready for return';
      END IF;
    END IF;

    IF NEW.status = 'completed' THEN
      SELECT count(*)::integer,
             count(*) FILTER (WHERE garment.status NOT IN (
               CASE WHEN OLD.return_method = 'delivery' THEN 'delivered' ELSE 'picked_up' END,
               'lost'
             ))::integer
        INTO garment_count, invalid_garment_count
        FROM garments garment
       WHERE garment.org_id = OLD.org_id AND garment.store_id = OLD.store_id
         AND garment.order_id = OLD.laundry_order_id;
      PERFORM 1 FROM orders
       WHERE org_id = OLD.org_id AND store_id = OLD.store_id AND id = OLD.laundry_order_id
         AND status = 'closed' AND balance_cents = 0
       FOR SHARE;
      IF NOT FOUND OR garment_count = 0 OR invalid_garment_count <> 0 THEN
        RAISE check_violation USING MESSAGE = 'laundry order is not terminal for delivery';
      END IF;
      NEW.completed_at := db_now;
      NEW.cancelled_at := NULL;
      NEW.cancellation_reason := NULL;
    ELSIF NEW.status = 'cancelled' THEN
      IF NEW.cancellation_reason IS NULL THEN
        RAISE check_violation USING MESSAGE = 'delivery cancellation reason required';
      END IF;
      NEW.cancelled_at := db_now;
      NEW.completed_at := NULL;
    ELSE
      IF NEW.cancellation_reason IS NOT NULL THEN
        RAISE check_violation USING MESSAGE = 'active delivery order cannot carry cancellation';
      END IF;
      NEW.cancelled_at := NULL;
      NEW.completed_at := NULL;
    END IF;
    NEW.updated_at := db_now;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_bound_delivery_appointment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM delivery_orders delivery_order
     WHERE delivery_order.org_id = OLD.org_id AND delivery_order.store_id = OLD.store_id
       AND (
         delivery_order.pickup_appointment_id = OLD.id
         OR delivery_order.return_appointment_id = OLD.id
       )
  ) THEN
    RAISE insufficient_privilege USING MESSAGE = 'bound delivery appointment is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'delivery_order_write_guard_trg'
       AND tgrelid = 'public.delivery_orders'::regclass
  ) THEN
    CREATE TRIGGER delivery_order_write_guard_trg
      BEFORE INSERT OR UPDATE ON public.delivery_orders
      FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_order_write();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'bound_delivery_appointment_guard_trg'
       AND tgrelid = 'public.delivery_appointments'::regclass
  ) THEN
    CREATE TRIGGER bound_delivery_appointment_guard_trg
      BEFORE UPDATE ON public.delivery_appointments
      FOR EACH ROW EXECUTE FUNCTION public.guard_bound_delivery_appointment();
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS delivery_orders_active_laundry_order_uidx
  ON public.delivery_orders (org_id, store_id, laundry_order_id)
  WHERE status NOT IN ('completed', 'cancelled');
CREATE UNIQUE INDEX IF NOT EXISTS delivery_orders_pickup_appointment_uidx
  ON public.delivery_orders (org_id, store_id, pickup_appointment_id)
  WHERE pickup_appointment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS delivery_orders_return_appointment_uidx
  ON public.delivery_orders (org_id, store_id, return_appointment_id)
  WHERE return_appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS delivery_orders_store_worklist_idx
  ON public.delivery_orders (org_id, store_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS delivery_orders_customer_worklist_idx
  ON public.delivery_orders (org_id, store_id, customer_id, updated_at DESC, id);

ALTER TABLE public.delivery_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_orders_store_scope ON public.delivery_orders
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
CREATE POLICY delivery_orders_maintenance ON public.delivery_orders
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON TABLE public.delivery_orders TO laundry_app;
REVOKE DELETE, TRUNCATE ON TABLE public.delivery_orders FROM laundry_app;
REVOKE ALL ON FUNCTION public.delivery_order_transition_allowed(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_delivery_order_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_bound_delivery_appointment() FROM PUBLIC;

CREATE UNIQUE INDEX IF NOT EXISTS ai_pending_delivery_order_idempotency_uidx
  ON public.ai_pending_actions (org_id, store_id, command, idempotency_key)
  WHERE command IN ('delivery.order.create', 'delivery.order.transition');

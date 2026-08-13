-- ADR-49 authoritative delivery-task assignment and custody succession.
-- No route, GPS, photo, signature or mobile-provider payload is stored here.

CREATE TABLE IF NOT EXISTS public.delivery_tasks (
  id uuid NOT NULL,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  delivery_order_id uuid NOT NULL,
  leg text NOT NULL,
  assignee_staff_id uuid NOT NULL,
  assigned_by_staff_id uuid NOT NULL,
  predecessor_task_id uuid,
  source text NOT NULL,
  status text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  resolution_reason text,
  accepted_at timestamptz,
  rejected_at timestamptz,
  transferred_at timestamptz,
  taken_over_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_by_staff_id uuid NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  CONSTRAINT delivery_tasks_pkey PRIMARY KEY (id),
  CONSTRAINT delivery_tasks_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT delivery_tasks_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT delivery_tasks_order_fk
    FOREIGN KEY (org_id, store_id, delivery_order_id)
    REFERENCES public.delivery_orders (org_id, store_id, id),
  CONSTRAINT delivery_tasks_assignee_role_fk
    FOREIGN KEY (org_id, store_id, assignee_staff_id)
    REFERENCES public.staff_store_roles (org_id, store_id, staff_id),
  CONSTRAINT delivery_tasks_assigned_by_staff_fk
    FOREIGN KEY (org_id, assigned_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT delivery_tasks_predecessor_fk
    FOREIGN KEY (org_id, store_id, predecessor_task_id)
    REFERENCES public.delivery_tasks (org_id, store_id, id),
  CONSTRAINT delivery_tasks_created_staff_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT delivery_tasks_updated_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT delivery_tasks_leg_chk CHECK (leg IN ('pickup', 'return')),
  CONSTRAINT delivery_tasks_source_chk CHECK (source IN ('assignment', 'transfer', 'takeover')),
  CONSTRAINT delivery_tasks_status_chk CHECK (status IN (
    'offered', 'accepted', 'rejected', 'transferred', 'taken_over', 'completed', 'cancelled'
  )),
  CONSTRAINT delivery_tasks_version_chk CHECK (version > 0),
  CONSTRAINT delivery_tasks_reason_chk CHECK (
    resolution_reason IS NULL OR resolution_reason IN (
      'unavailable', 'capacity', 'shift_end', 'route_conflict', 'emergency', 'other'
    )
  ),
  CONSTRAINT delivery_tasks_time_chk CHECK (
    updated_at >= created_at
    AND (accepted_at IS NULL OR accepted_at >= created_at)
    AND (rejected_at IS NULL OR rejected_at >= created_at)
    AND (transferred_at IS NULL OR transferred_at >= created_at)
    AND (taken_over_at IS NULL OR taken_over_at >= created_at)
    AND (completed_at IS NULL OR completed_at >= created_at)
    AND (cancelled_at IS NULL OR cancelled_at >= created_at)
  ),
  CONSTRAINT delivery_tasks_state_shape_chk CHECK (
    (status = 'offered' AND accepted_at IS NULL AND rejected_at IS NULL
      AND transferred_at IS NULL AND taken_over_at IS NULL AND completed_at IS NULL
      AND cancelled_at IS NULL AND resolution_reason IS NULL)
    OR (status = 'accepted' AND accepted_at IS NOT NULL AND rejected_at IS NULL
      AND transferred_at IS NULL AND taken_over_at IS NULL AND completed_at IS NULL
      AND cancelled_at IS NULL AND resolution_reason IS NULL)
    OR (status = 'rejected' AND accepted_at IS NULL AND rejected_at IS NOT NULL
      AND transferred_at IS NULL AND taken_over_at IS NULL AND completed_at IS NULL
      AND cancelled_at IS NULL AND resolution_reason IS NOT NULL)
    OR (status = 'transferred' AND rejected_at IS NULL AND transferred_at IS NOT NULL
      AND taken_over_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL
      AND resolution_reason IS NOT NULL)
    OR (status = 'taken_over' AND rejected_at IS NULL AND transferred_at IS NULL
      AND taken_over_at IS NOT NULL AND completed_at IS NULL AND cancelled_at IS NULL
      AND resolution_reason IS NOT NULL)
    OR (status = 'completed' AND accepted_at IS NOT NULL AND rejected_at IS NULL
      AND transferred_at IS NULL AND taken_over_at IS NULL AND completed_at IS NOT NULL
      AND cancelled_at IS NULL AND resolution_reason IS NULL)
    OR (status = 'cancelled' AND rejected_at IS NULL AND transferred_at IS NULL
      AND taken_over_at IS NULL AND completed_at IS NULL AND cancelled_at IS NOT NULL
      AND resolution_reason IS NULL)
  )
);

CREATE OR REPLACE FUNCTION public.delivery_task_transition_allowed(
  current_status text,
  target_status text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE current_status
    WHEN 'offered' THEN target_status IN (
      'accepted', 'rejected', 'transferred', 'taken_over', 'cancelled'
    )
    WHEN 'accepted' THEN target_status IN ('transferred', 'taken_over', 'completed', 'cancelled')
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION public.guard_delivery_task_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  db_now timestamptz := statement_timestamp();
  actor_id uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  order_collection text;
  order_return text;
  order_status text;
  predecessor_status text;
  predecessor_order uuid;
  predecessor_leg text;
  predecessor_assignee uuid;
  assignee_is_active boolean := false;
  actor_is_active_admin boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF session_user = 'laundry_app' AND (
      actor_id IS NULL OR NEW.assigned_by_staff_id IS DISTINCT FROM actor_id
      OR NEW.created_by_staff_id IS DISTINCT FROM actor_id
      OR NEW.updated_by_staff_id IS DISTINCT FROM actor_id
    ) THEN
      RAISE insufficient_privilege USING MESSAGE = 'delivery task actor mismatch';
    END IF;

    SELECT collection_method, return_method, status
      INTO order_collection, order_return, order_status
      FROM delivery_orders
     WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND id = NEW.delivery_order_id
     FOR SHARE;
    IF NOT FOUND OR (NEW.leg = 'pickup' AND (
      order_collection <> 'pickup'
      OR order_status NOT IN ('pickup_scheduled', 'pickup_in_progress')
    )) OR (NEW.leg = 'return' AND (
      order_return <> 'delivery'
      OR order_status NOT IN ('return_scheduled', 'return_in_progress')
    )) THEN
      RAISE check_violation USING MESSAGE = 'delivery task leg is not assignable';
    END IF;

    IF NEW.predecessor_task_id IS NOT NULL THEN
      SELECT status, delivery_order_id, leg, assignee_staff_id
        INTO predecessor_status, predecessor_order, predecessor_leg, predecessor_assignee
        FROM delivery_tasks
       WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND id = NEW.predecessor_task_id
       FOR SHARE;
      IF NOT FOUND OR predecessor_order IS DISTINCT FROM NEW.delivery_order_id
         OR predecessor_leg IS DISTINCT FROM NEW.leg THEN
        RAISE foreign_key_violation USING MESSAGE = 'delivery task predecessor mismatch';
      END IF;
    END IF;

    IF NEW.source = 'assignment' AND NEW.predecessor_task_id IS NULL
       AND order_status NOT IN ('pickup_scheduled', 'return_scheduled') THEN
      RAISE check_violation USING MESSAGE = 'initial delivery task requires scheduled leg';
    END IF;
    IF NEW.source = 'assignment' AND NEW.predecessor_task_id IS NULL AND EXISTS (
      SELECT 1 FROM delivery_tasks candidate
       WHERE candidate.org_id = NEW.org_id AND candidate.store_id = NEW.store_id
         AND candidate.delivery_order_id = NEW.delivery_order_id AND candidate.leg = NEW.leg
         AND candidate.status IN ('rejected', 'cancelled')
         AND NOT EXISTS (
           SELECT 1 FROM delivery_tasks successor
            WHERE successor.org_id = candidate.org_id
              AND successor.store_id = candidate.store_id
              AND successor.predecessor_task_id = candidate.id
         )
    ) THEN
      RAISE check_violation USING MESSAGE = 'delivery task reusable predecessor required';
    END IF;

    -- Global lock order is delivery_order, delivery_task, then staff rows. Lock both
    -- staff identities in UUID order before validating their current authority.
    PERFORM role_row.staff_id
      FROM staff_store_roles role_row
      JOIN staffs staff_row
        ON staff_row.org_id = role_row.org_id AND staff_row.id = role_row.staff_id
     WHERE role_row.org_id = NEW.org_id AND role_row.store_id = NEW.store_id
       AND role_row.staff_id IN (actor_id, NEW.assignee_staff_id)
     ORDER BY role_row.staff_id
     FOR SHARE OF role_row, staff_row;
    SELECT
      COALESCE(bool_or(
        role_row.staff_id = NEW.assignee_staff_id
        AND role_row.is_active AND staff_row.is_active
      ), false),
      COALESCE(bool_or(
        role_row.staff_id = actor_id AND role_row.role = 'admin'
        AND role_row.is_active AND staff_row.is_active
      ), false)
      INTO assignee_is_active, actor_is_active_admin
      FROM staff_store_roles role_row
      JOIN staffs staff_row
        ON staff_row.org_id = role_row.org_id AND staff_row.id = role_row.staff_id
     WHERE role_row.org_id = NEW.org_id AND role_row.store_id = NEW.store_id
       AND role_row.staff_id IN (actor_id, NEW.assignee_staff_id);
    IF NOT assignee_is_active THEN
      RAISE foreign_key_violation USING MESSAGE = 'delivery task assignee is not active';
    END IF;
    IF session_user = 'laundry_app' AND NOT actor_is_active_admin THEN
      RAISE insufficient_privilege USING MESSAGE = 'delivery task assignment requires active admin';
    END IF;

    IF (NEW.source = 'assignment' AND (
      NEW.status <> 'offered'
      OR (NEW.predecessor_task_id IS NOT NULL AND predecessor_status NOT IN ('rejected', 'cancelled'))
    )) OR (NEW.source = 'transfer' AND (
      NEW.predecessor_task_id IS NULL OR
      NEW.status <> 'offered' OR predecessor_status <> 'transferred'
      OR NEW.assignee_staff_id IS NOT DISTINCT FROM predecessor_assignee
    )) OR (NEW.source = 'takeover' AND (
      NEW.predecessor_task_id IS NULL OR
      NEW.status <> 'accepted' OR predecessor_status <> 'taken_over'
      OR NEW.assignee_staff_id IS DISTINCT FROM actor_id
      OR NEW.assignee_staff_id IS NOT DISTINCT FROM predecessor_assignee
    )) THEN
      RAISE check_violation USING MESSAGE = 'delivery task successor shape invalid';
    END IF;

    NEW.version := 1;
    NEW.resolution_reason := NULL;
    NEW.accepted_at := CASE WHEN NEW.status = 'accepted' THEN db_now ELSE NULL END;
    NEW.rejected_at := NULL;
    NEW.transferred_at := NULL;
    NEW.taken_over_at := NULL;
    NEW.completed_at := NULL;
    NEW.cancelled_at := NULL;
    NEW.created_at := db_now;
    NEW.updated_at := db_now;
  ELSE
    IF OLD.status NOT IN ('offered', 'accepted') THEN
      RAISE insufficient_privilege USING MESSAGE = 'terminal delivery task is immutable';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.delivery_order_id IS DISTINCT FROM OLD.delivery_order_id
       OR NEW.leg IS DISTINCT FROM OLD.leg
       OR NEW.assignee_staff_id IS DISTINCT FROM OLD.assignee_staff_id
       OR NEW.assigned_by_staff_id IS DISTINCT FROM OLD.assigned_by_staff_id
       OR NEW.predecessor_task_id IS DISTINCT FROM OLD.predecessor_task_id
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.created_by_staff_id IS DISTINCT FROM OLD.created_by_staff_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE insufficient_privilege USING MESSAGE = 'delivery task identity is immutable';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE check_violation USING MESSAGE = 'delivery task version must advance by one';
    END IF;
    IF NOT delivery_task_transition_allowed(OLD.status, NEW.status) THEN
      RAISE check_violation USING MESSAGE = 'illegal delivery task transition';
    END IF;
    IF db_now < OLD.updated_at THEN
      RAISE check_violation USING MESSAGE = 'delivery task time must be monotonic';
    END IF;
    IF session_user = 'laundry_app' AND (
      actor_id IS NULL OR NEW.updated_by_staff_id IS DISTINCT FROM actor_id
    ) THEN
      RAISE insufficient_privilege USING MESSAGE = 'delivery task actor mismatch';
    END IF;
    IF NEW.status IN ('accepted', 'rejected', 'completed')
       AND actor_id IS DISTINCT FROM OLD.assignee_staff_id THEN
      RAISE insufficient_privilege USING MESSAGE = 'delivery task requires current assignee';
    END IF;
    IF NEW.status IN ('transferred', 'taken_over') THEN
      IF NEW.status = 'taken_over' AND actor_id IS NOT DISTINCT FROM OLD.assignee_staff_id THEN
        RAISE insufficient_privilege USING MESSAGE = 'delivery task takeover must change assignee';
      END IF;
      PERFORM 1
        FROM staff_store_roles role_row
        JOIN staffs staff_row
          ON staff_row.org_id = role_row.org_id AND staff_row.id = role_row.staff_id
       WHERE role_row.org_id = OLD.org_id AND role_row.store_id = OLD.store_id
         AND role_row.staff_id = actor_id AND role_row.role = 'admin'
         AND role_row.is_active AND staff_row.is_active
       FOR SHARE OF role_row, staff_row;
      IF NOT FOUND THEN
        RAISE insufficient_privilege USING MESSAGE = 'delivery task reassignment requires active admin';
      END IF;
    END IF;

    NEW.accepted_at := CASE
      WHEN NEW.status = 'accepted' THEN db_now ELSE OLD.accepted_at END;
    NEW.rejected_at := CASE WHEN NEW.status = 'rejected' THEN db_now ELSE NULL END;
    NEW.transferred_at := CASE WHEN NEW.status = 'transferred' THEN db_now ELSE NULL END;
    NEW.taken_over_at := CASE WHEN NEW.status = 'taken_over' THEN db_now ELSE NULL END;
    NEW.completed_at := CASE WHEN NEW.status = 'completed' THEN db_now ELSE NULL END;
    NEW.cancelled_at := CASE WHEN NEW.status = 'cancelled' THEN db_now ELSE NULL END;
    NEW.resolution_reason := CASE
      WHEN NEW.status IN ('rejected', 'transferred', 'taken_over') THEN NEW.resolution_reason
      ELSE NULL END;
    IF NEW.status IN ('rejected', 'transferred', 'taken_over')
       AND NEW.resolution_reason IS NULL THEN
      RAISE check_violation USING MESSAGE = 'delivery task resolution reason required';
    END IF;
    NEW.updated_at := db_now;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_delivery_order_task_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  required_leg text;
BEGIN
  required_leg := CASE
    WHEN OLD.status = 'pickup_scheduled' AND NEW.status = 'pickup_in_progress' THEN 'pickup'
    WHEN OLD.status = 'pickup_in_progress' AND NEW.status = 'picked_up' THEN 'pickup'
    WHEN OLD.status = 'return_scheduled' AND NEW.status = 'return_in_progress' THEN 'return'
    WHEN OLD.status = 'return_in_progress' AND NEW.status = 'completed' THEN 'return'
    ELSE NULL
  END;
  IF required_leg IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM delivery_tasks task
   WHERE task.org_id = OLD.org_id AND task.store_id = OLD.store_id
     AND task.delivery_order_id = OLD.id AND task.leg = required_leg
     AND task.status = 'accepted' AND task.assignee_staff_id = actor_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE check_violation USING MESSAGE = 'delivery order requires accepted assignee task';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_delivery_task_from_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
BEGIN
  IF NEW.status = 'picked_up' AND OLD.status = 'pickup_in_progress' THEN
    UPDATE delivery_tasks SET status = 'completed', version = version + 1,
      updated_by_staff_id = actor_id
     WHERE org_id = NEW.org_id AND store_id = NEW.store_id
       AND delivery_order_id = NEW.id AND leg = 'pickup' AND status = 'accepted';
  ELSIF NEW.status = 'completed' AND OLD.status = 'return_in_progress'
        AND NEW.return_method = 'delivery' THEN
    UPDATE delivery_tasks SET status = 'completed', version = version + 1,
      updated_by_staff_id = actor_id
     WHERE org_id = NEW.org_id AND store_id = NEW.store_id
       AND delivery_order_id = NEW.id AND leg = 'return' AND status = 'accepted';
  ELSIF NEW.status = 'cancelled' THEN
    UPDATE delivery_tasks SET status = 'cancelled', version = version + 1,
      updated_by_staff_id = actor_id
     WHERE org_id = NEW.org_id AND store_id = NEW.store_id
       AND delivery_order_id = NEW.id AND status IN ('offered', 'accepted');
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_delivery_task_commit_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  order_status text;
BEGIN
  IF NEW.status IN ('transferred', 'taken_over') THEN
    PERFORM 1 FROM delivery_tasks successor
     WHERE successor.org_id = NEW.org_id AND successor.store_id = NEW.store_id
       AND successor.delivery_order_id = NEW.delivery_order_id AND successor.leg = NEW.leg
       AND successor.predecessor_task_id = NEW.id
       AND successor.source = CASE WHEN NEW.status = 'transferred' THEN 'transfer' ELSE 'takeover' END
       AND successor.status = CASE WHEN NEW.status = 'transferred' THEN 'offered' ELSE 'accepted' END;
    IF NOT FOUND THEN
      RAISE check_violation USING MESSAGE = 'terminal reassignment requires successor task';
    END IF;
  ELSIF NEW.status IN ('completed', 'cancelled') THEN
    SELECT status INTO order_status FROM delivery_orders
     WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND id = NEW.delivery_order_id;
    IF NOT FOUND OR (NEW.status = 'cancelled' AND order_status <> 'cancelled')
       OR (NEW.status = 'completed' AND NEW.leg = 'pickup' AND order_status <> 'picked_up')
       OR (NEW.status = 'completed' AND NEW.leg = 'return' AND order_status <> 'completed') THEN
      RAISE check_violation USING MESSAGE = 'terminal task must follow delivery order truth';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'delivery_task_commit_integrity_trg'
       AND tgrelid = 'public.delivery_tasks'::regclass
  ) THEN
    CREATE CONSTRAINT TRIGGER delivery_task_commit_integrity_trg
      AFTER INSERT OR UPDATE ON public.delivery_tasks
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_task_commit_integrity();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'delivery_task_write_guard_trg'
       AND tgrelid = 'public.delivery_tasks'::regclass
  ) THEN
    CREATE TRIGGER delivery_task_write_guard_trg
      BEFORE INSERT OR UPDATE ON public.delivery_tasks
      FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_task_write();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'delivery_order_task_authority_guard_trg'
       AND tgrelid = 'public.delivery_orders'::regclass
  ) THEN
    CREATE TRIGGER delivery_order_task_authority_guard_trg
      BEFORE UPDATE ON public.delivery_orders
      FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_order_task_authority();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'delivery_order_task_sync_trg'
       AND tgrelid = 'public.delivery_orders'::regclass
  ) THEN
    CREATE TRIGGER delivery_order_task_sync_trg
      AFTER UPDATE ON public.delivery_orders
      FOR EACH ROW EXECUTE FUNCTION public.sync_delivery_task_from_order();
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS delivery_tasks_active_leg_uidx
  ON public.delivery_tasks (org_id, store_id, delivery_order_id, leg)
  WHERE status IN ('offered', 'accepted');
CREATE UNIQUE INDEX IF NOT EXISTS delivery_tasks_predecessor_uidx
  ON public.delivery_tasks (org_id, store_id, predecessor_task_id)
  WHERE predecessor_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS delivery_tasks_store_worklist_idx
  ON public.delivery_tasks (org_id, store_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS delivery_tasks_assignee_worklist_idx
  ON public.delivery_tasks (org_id, store_id, assignee_staff_id, status, updated_at DESC, id);

ALTER TABLE public.delivery_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_tasks_store_scope ON public.delivery_tasks
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
CREATE POLICY delivery_tasks_maintenance ON public.delivery_tasks
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON TABLE public.delivery_tasks TO laundry_app;
REVOKE DELETE, TRUNCATE ON TABLE public.delivery_tasks FROM laundry_app;
REVOKE ALL ON FUNCTION public.delivery_task_transition_allowed(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_delivery_task_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_delivery_order_task_authority() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_delivery_task_from_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_delivery_task_commit_integrity() FROM PUBLIC;

CREATE UNIQUE INDEX IF NOT EXISTS ai_pending_delivery_task_idempotency_uidx
  ON public.ai_pending_actions (org_id, store_id, command, idempotency_key)
  WHERE command IN (
    'delivery.task.assign', 'delivery.task.respond',
    'delivery.task.transfer', 'delivery.task.takeover'
  );

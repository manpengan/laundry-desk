-- ADR-89: explicit one-hour, outbound-only diagnostic assistance.
CREATE TABLE public.remote_assistance_sessions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  session_version integer NOT NULL CHECK (session_version > 0),
  permission_version integer NOT NULL CHECK (permission_version > 0),
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  status text NOT NULL CHECK (status IN ('active','revoked','expired','interrupted')),
  CHECK (expires_at > approved_at AND expires_at <= approved_at + interval '1 hour'),
  CHECK ((status='active') = (revoked_at IS NULL)),
  UNIQUE(org_id,store_id,id),
  FOREIGN KEY (org_id,store_id) REFERENCES stores(org_id,id),
  FOREIGN KEY (org_id,actor_id) REFERENCES staffs(org_id,id),
  FOREIGN KEY (org_id,store_id,session_id) REFERENCES sessions(org_id,store_id,id)
);
CREATE TABLE public.remote_assistance_commands (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  assistance_id uuid NOT NULL,
  command text NOT NULL CHECK (command IN ('runtime.health','runtime.version','maintenance.summary')),
  operator_sha256 text NOT NULL CHECK (operator_sha256 ~ '^[a-f0-9]{64}$'),
  result_sha256 text NOT NULL CHECK (result_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  delivered_at timestamptz,
  FOREIGN KEY (org_id,store_id,assistance_id) REFERENCES remote_assistance_sessions(org_id,store_id,id)
);
ALTER TABLE public.remote_assistance_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remote_assistance_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.remote_assistance_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remote_assistance_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY remote_assistance_sessions_scope ON public.remote_assistance_sessions
  USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid)
  WITH CHECK (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
CREATE POLICY remote_assistance_commands_scope ON public.remote_assistance_commands
  USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid)
  WITH CHECK (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
CREATE FUNCTION public.guard_remote_assistance_terminal() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.status <> 'active' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
  THEN RAISE EXCEPTION 'remote assistance revocation is permanent'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_remote_assistance_terminal() FROM PUBLIC;
CREATE TRIGGER remote_assistance_terminal BEFORE UPDATE ON public.remote_assistance_sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_remote_assistance_terminal();
GRANT SELECT,INSERT ON public.remote_assistance_sessions,public.remote_assistance_commands TO laundry_app;
GRANT UPDATE(status,revoked_at) ON public.remote_assistance_sessions TO laundry_app;
GRANT UPDATE(delivered_at) ON public.remote_assistance_commands TO laundry_app;
CREATE INDEX remote_assistance_sessions_actor_idx ON public.remote_assistance_sessions(org_id,actor_id);
CREATE INDEX remote_assistance_sessions_auth_idx ON public.remote_assistance_sessions(org_id,store_id,session_id);
CREATE INDEX remote_assistance_commands_session_idx ON public.remote_assistance_commands(org_id,store_id,assistance_id);

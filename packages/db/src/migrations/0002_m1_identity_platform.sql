-- Expand-only M1 identity/platform tables (UUID PKs, integer cents reserved for later money tables).
-- Matrix: orgs (global), stores/staffs/settings (org), staff_store_roles/store_features/audit_log (store).
-- Session tables support A5; not in A3 matrix.

CREATE TABLE IF NOT EXISTS orgs (
  id uuid PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS orgs_code_uidx ON orgs (code);

CREATE TABLE IF NOT EXISTS stores (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id),
  code text NOT NULL,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS stores_org_id_uidx ON stores (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS stores_org_code_uidx ON stores (org_id, code);

CREATE TABLE IF NOT EXISTS staffs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id),
  username text NOT NULL,
  password_hash text NOT NULL,
  pin_hash text,
  display_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  permission_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_login_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS staffs_org_id_uidx ON staffs (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS staffs_org_username_uidx ON staffs (org_id, username);

CREATE TABLE IF NOT EXISTS staff_store_roles (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT staff_store_roles_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT staff_store_roles_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_store_roles_tenant_id_uidx
  ON staff_store_roles (org_id, store_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS staff_store_roles_staff_uidx
  ON staff_store_roles (org_id, store_id, staff_id);

CREATE TABLE IF NOT EXISTS settings (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id),
  key text NOT NULL,
  value_json text NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by_staff_id uuid,
  CONSTRAINT settings_updated_by_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES staffs (org_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS settings_org_id_uidx ON settings (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS settings_org_key_uidx ON settings (org_id, key);

CREATE TABLE IF NOT EXISTS store_features (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  fulfillment boolean NOT NULL DEFAULT false,
  membership boolean NOT NULL DEFAULT false,
  shift_closing boolean NOT NULL DEFAULT false,
  delivery boolean NOT NULL DEFAULT false,
  marketing boolean NOT NULL DEFAULT false,
  ai boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  CONSTRAINT store_features_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS store_features_tenant_id_uidx
  ON store_features (org_id, store_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS store_features_store_uidx
  ON store_features (org_id, store_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid,
  via text NOT NULL,
  command text NOT NULL,
  idempotency_key text,
  dry_run boolean NOT NULL DEFAULT false,
  entity text,
  entity_id text,
  before_json text,
  after_json text,
  ip text,
  device_id uuid,
  at timestamptz NOT NULL,
  CONSTRAINT audit_log_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT audit_log_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS audit_log_tenant_id_uidx
  ON audit_log (org_id, store_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_store_at_id_uidx
  ON audit_log (org_id, store_id, at, id);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  device_id uuid NOT NULL,
  session_version integer NOT NULL DEFAULT 1,
  permission_version integer NOT NULL DEFAULT 1,
  authentication_method text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  CONSTRAINT sessions_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT sessions_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT sessions_status_chk CHECK (status IN ('active', 'revoked')),
  CONSTRAINT sessions_auth_method_chk
    CHECK (authentication_method IN ('password', 'pin', 'refresh'))
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_tenant_id_uidx
  ON sessions (org_id, store_id, id);

CREATE TABLE IF NOT EXISTS refresh_families (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id),
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT refresh_families_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT refresh_families_status_chk CHECK (status IN ('active', 'revoked'))
);

CREATE UNIQUE INDEX IF NOT EXISTS refresh_families_tenant_id_uidx
  ON refresh_families (org_id, store_id, id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES refresh_families (id),
  session_id uuid NOT NULL REFERENCES sessions (id),
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  token_hash text NOT NULL,
  status text NOT NULL,
  replacement_token_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  rotated_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT refresh_tokens_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT refresh_tokens_status_chk
    CHECK (status IN ('active', 'rotated', 'revoked'))
);

CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_tenant_id_uidx
  ON refresh_tokens (org_id, store_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_hash_uidx ON refresh_tokens (token_hash);

CREATE TABLE IF NOT EXISTS pin_challenges (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  device_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions (id),
  session_version integer NOT NULL,
  purpose text NOT NULL,
  target_staff_id uuid,
  approver_staff_id uuid,
  pending_action_ref text,
  nonce text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  status text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT pin_challenges_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT pin_challenges_purpose_chk
    CHECK (purpose IN ('quick_switch', 'step_up')),
  CONSTRAINT pin_challenges_status_chk
    CHECK (status IN ('open', 'consumed', 'expired', 'exhausted'))
);

CREATE UNIQUE INDEX IF NOT EXISTS pin_challenges_tenant_id_uidx
  ON pin_challenges (org_id, store_id, id);

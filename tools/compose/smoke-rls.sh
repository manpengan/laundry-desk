#!/usr/bin/env bash
# Minimal RLS isolation smoke against formal packages/db M1 tables.
# LOCAL ONLY — not invoked by CI. Run after migrate-v2.sh.
#
# Protocol (frozen A3 / ADR-02; do not invent predicates):
#   - GUC: app.org_id / app.store_id as UUID strings
#   - Role: laundry_app (NOBYPASSRLS)
#   - Predicate: NULLIF(current_setting(...), '')::uuid  (see 0003_rls_and_grants.sql)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-laundry-postgres-spike}"

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-8543}"
PGDATABASE="${PGDATABASE:-laundry_v2}"
LAUNDRY_APP_USER="${LAUNDRY_APP_USER:-laundry_app}"
LAUNDRY_APP_PASSWORD="${LAUNDRY_APP_PASSWORD:-app_secure_password}"

DEFAULT_APP_URL="postgresql://${LAUNDRY_APP_USER}:${LAUNDRY_APP_PASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}"
APP_DATABASE_URL="${LAUNDRY_APP_DATABASE_URL:-${APP_DATABASE_URL:-${DEFAULT_APP_URL}}}"

# Fixed smoke UUIDs (not production data)
ORG_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ORG_B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
STORE_A="11111111-1111-4111-8111-111111111111"
STORE_B="22222222-2222-4222-8222-222222222222"
STAFF_A="33333333-3333-4333-8333-333333333333"
ROLE_A="44444444-4444-4444-8444-444444444444"
NOW_TS="2026-07-21T00:00:00Z"

die() {
  echo "❌ [smoke-rls] $*" >&2
  exit 1
}

log() {
  echo "=== [smoke-rls] $* ==="
}

pass() {
  echo "✔ [PASS] $*"
}

container_running() {
  docker inspect -f '{{.State.Running}}' "${POSTGRES_CONTAINER}" 2>/dev/null | grep -qx true
}

# Run SQL as laundry_app; print stdout. ON_ERROR_STOP so failures exit non-zero.
psql_app() {
  if command -v psql >/dev/null 2>&1; then
    psql "${APP_DATABASE_URL}" -v ON_ERROR_STOP=1 -X -q -At "$@"
    return
  fi
  if container_running; then
    docker exec -i \
      -e PGPASSWORD="${LAUNDRY_APP_PASSWORD}" \
      "${POSTGRES_CONTAINER}" \
      psql -U "${LAUNDRY_APP_USER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 -X -q -At "$@"
    return
  fi
  die "need host psql or running container '${POSTGRES_CONTAINER}'. Start compose + migrate-v2 first."
}

psql_app_file() {
  # stdin SQL
  if command -v psql >/dev/null 2>&1; then
    psql "${APP_DATABASE_URL}" -v ON_ERROR_STOP=1 -X -q -At
    return
  fi
  if container_running; then
    docker exec -i \
      -e PGPASSWORD="${LAUNDRY_APP_PASSWORD}" \
      "${POSTGRES_CONTAINER}" \
      psql -U "${LAUNDRY_APP_USER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 -X -q -At
    return
  fi
  die "need host psql or running container '${POSTGRES_CONTAINER}'"
}

require_formal_tables() {
  log "Checking formal M1 tables exist (run migrate-v2.sh first)"
  local missing
  missing="$(
    psql_app <<'SQL'
SELECT string_agg(name, ',')
FROM (
  SELECT unnest(ARRAY[
    'orgs','stores','staffs','staff_store_roles',
    'settings','store_features','audit_log','sessions'
  ]) AS name
) t
WHERE to_regclass('public.' || name) IS NULL;
SQL
  )"
  if [[ -n "${missing}" && "${missing}" != "" ]]; then
    die "formal tables missing: ${missing}. Run ./tools/compose/migrate-v2.sh first."
  fi
  pass "formal identity/platform tables present"
}

seed_and_assert() {
  log "Insert org/store/staff under Tenant A GUC; assert isolation"

  # orgs is global (no tenant RLS). Cleanup prior smoke rows by known ids.
  psql_app_file <<SQL
-- Remove prior smoke rows (best-effort under each tenant GUC + global orgs)
BEGIN;
SET LOCAL app.org_id = '${ORG_A}';
SET LOCAL app.store_id = '${STORE_A}';
DELETE FROM staff_store_roles WHERE id = '${ROLE_A}'::uuid;
DELETE FROM staffs WHERE id = '${STAFF_A}'::uuid;
DELETE FROM stores WHERE id = '${STORE_A}'::uuid;
COMMIT;

BEGIN;
SET LOCAL app.org_id = '${ORG_B}';
SET LOCAL app.store_id = '${STORE_B}';
DELETE FROM stores WHERE id = '${STORE_B}'::uuid;
COMMIT;

DELETE FROM orgs WHERE id IN ('${ORG_A}'::uuid, '${ORG_B}'::uuid);

INSERT INTO orgs (id, code, name, created_at, updated_at)
VALUES
  ('${ORG_A}'::uuid, 'smoke_org_a', 'Smoke Org A', '${NOW_TS}'::timestamptz, '${NOW_TS}'::timestamptz),
  ('${ORG_B}'::uuid, 'smoke_org_b', 'Smoke Org B', '${NOW_TS}'::timestamptz, '${NOW_TS}'::timestamptz);

BEGIN;
SET LOCAL app.org_id = '${ORG_A}';
INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
VALUES (
  '${STORE_A}'::uuid, '${ORG_A}'::uuid, 'smoke_store_a', 'Smoke Store A',
  'Asia/Shanghai', '${NOW_TS}'::timestamptz, '${NOW_TS}'::timestamptz
);
INSERT INTO staffs (
  id, org_id, username, password_hash, display_name, is_active,
  permission_version, created_at, updated_at
) VALUES (
  '${STAFF_A}'::uuid, '${ORG_A}'::uuid, 'smoke_staff_a', 'not-a-real-hash',
  'Smoke Staff A', true, 1, '${NOW_TS}'::timestamptz, '${NOW_TS}'::timestamptz
);
COMMIT;

BEGIN;
SET LOCAL app.org_id = '${ORG_A}';
SET LOCAL app.store_id = '${STORE_A}';
INSERT INTO staff_store_roles (
  id, org_id, store_id, staff_id, role, is_active, created_at, updated_at
) VALUES (
  '${ROLE_A}'::uuid, '${ORG_A}'::uuid, '${STORE_A}'::uuid, '${STAFF_A}'::uuid,
  'admin', true, '${NOW_TS}'::timestamptz, '${NOW_TS}'::timestamptz
);
COMMIT;

BEGIN;
SET LOCAL app.org_id = '${ORG_B}';
INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
VALUES (
  '${STORE_B}'::uuid, '${ORG_B}'::uuid, 'smoke_store_b', 'Smoke Store B',
  'Asia/Shanghai', '${NOW_TS}'::timestamptz, '${NOW_TS}'::timestamptz
);
COMMIT;
SQL

  local count_no_guc count_a count_b count_role_a count_role_b

  count_no_guc="$(
    psql_app_file <<'SQL'
SELECT count(*)::text FROM staffs;
SQL
  )"
  [[ "${count_no_guc}" == "0" ]] || die "default-closed failed: staffs count=${count_no_guc} (expected 0 without GUC)"
  pass "default-closed: staffs returns 0 rows without GUC"

  count_a="$(
    psql_app_file <<SQL
BEGIN;
SET LOCAL app.org_id = '${ORG_A}';
SELECT count(*)::text FROM staffs WHERE id = '${STAFF_A}'::uuid;
COMMIT;
SQL
  )"
  [[ "${count_a}" == "1" ]] || die "tenant A visibility failed: count=${count_a} (expected 1)"
  pass "tenant A GUC sees own staff row"

  count_b="$(
    psql_app_file <<SQL
BEGIN;
SET LOCAL app.org_id = '${ORG_B}';
SELECT count(*)::text FROM staffs WHERE id = '${STAFF_A}'::uuid;
COMMIT;
SQL
  )"
  [[ "${count_b}" == "0" ]] || die "tenant isolation failed: org B saw org A staff (count=${count_b})"
  pass "tenant B GUC cannot see org A staff"

  count_role_a="$(
    psql_app_file <<SQL
BEGIN;
SET LOCAL app.org_id = '${ORG_A}';
SET LOCAL app.store_id = '${STORE_A}';
SELECT count(*)::text FROM staff_store_roles WHERE id = '${ROLE_A}'::uuid;
COMMIT;
SQL
  )"
  [[ "${count_role_a}" == "1" ]] || die "store-scope visibility failed: count=${count_role_a}"
  pass "store-scope GUC sees own staff_store_roles row"

  count_role_b="$(
    psql_app_file <<SQL
BEGIN;
SET LOCAL app.org_id = '${ORG_B}';
SET LOCAL app.store_id = '${STORE_B}';
SELECT count(*)::text FROM staff_store_roles WHERE id = '${ROLE_A}'::uuid;
COMMIT;
SQL
  )"
  [[ "${count_role_b}" == "0" ]] || die "store isolation failed: store B saw store A role (count=${count_role_b})"
  pass "store B GUC cannot see store A staff_store_roles"
}

log "Formal packages/db RLS smoke (laundry_app + SET LOCAL GUC)"
require_formal_tables
seed_and_assert
log "OK — RLS isolation smoke passed"

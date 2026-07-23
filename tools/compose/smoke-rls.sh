#!/usr/bin/env bash
# Real PostgreSQL RLS smoke. Uses laundry_app only; superuser is never used for
# the assertions so a passing result cannot be a BYPASSRLS false positive.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-laundry-postgres-v2}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-8543}"
PGDATABASE="${PGDATABASE:-laundry_v2}"
LAUNDRY_APP_USER="${LAUNDRY_APP_USER:-laundry_app}"
LAUNDRY_APP_PASSWORD="${LAUNDRY_APP_PASSWORD:-app_secure_password}"
APP_DATABASE_URL="${DATABASE_URL:-postgresql://${LAUNDRY_APP_USER}:${LAUNDRY_APP_PASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}}"

ORG_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
STAFF_A="11111111-1111-4111-8111-111111111101"
ORG_B="cccccccc-cccc-4ccc-8ccc-cccccccccccc"
STORE_B="dddddddd-dddd-4ddd-8ddd-dddddddddddd"
STAFF_B="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

die() {
  echo "❌ [smoke-rls] $*" >&2
  exit 1
}

pass() {
  echo "✔ [smoke-rls] $*"
}

container_running() {
  docker inspect -f '{{.State.Running}}' "${POSTGRES_CONTAINER}" 2>/dev/null | grep -qx true
}

psql_app() {
  if command -v psql >/dev/null 2>&1; then
    psql "${APP_DATABASE_URL}" -v ON_ERROR_STOP=1 -X -q -At "$@"
    return
  fi
  if container_running; then
    docker exec -i -e PGPASSWORD="${LAUNDRY_APP_PASSWORD}" "${POSTGRES_CONTAINER}" \
      psql -U "${LAUNDRY_APP_USER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 -X -q -At "$@"
    return
  fi
  die "need host psql or running container '${POSTGRES_CONTAINER}'"
}

require_tables() {
  local expected=(
    laundry_schema_migrations orgs stores staffs staff_store_roles settings store_features audit_log
    sessions refresh_families refresh_tokens pin_challenges pin_lockouts orders order_lines garments
    ticket_counters catalog_items payments print_jobs customers shift_closings garment_photos
  )
  local table
  for table in "${expected[@]}"; do
    local found
    found="$(psql_app -c "SELECT to_regclass('public.${table}')::text")"
    [[ "${found}" == "${table}" ]] || die "missing formal table: ${table}"
  done
  pass "all formal migrations (0001–0014) are present"
}

assert_default_closed() {
  local no_guc empty_guc
  no_guc="$(psql_app -c 'SELECT count(*)::text FROM staffs')"
  [[ "${no_guc}" == '0' ]] || die "unset GUC exposed ${no_guc} staff rows"

  empty_guc="$(psql_app <<'SQL'
BEGIN;
SELECT set_config('app.org_id', '', true);
SELECT set_config('app.store_id', '', true);
SELECT count(*)::text FROM staffs;
COMMIT;
SQL
  )"
  empty_guc="$(printf '%s\n' "${empty_guc}" | tail -n 1)"
  [[ "${empty_guc}" == '0' ]] || die "empty GUC exposed ${empty_guc} staff rows"
  pass "unset and empty GUCs default closed"
}

seed_second_tenant() {
  psql_app <<SQL
BEGIN;
SET LOCAL app.org_id = '${ORG_B}';
DELETE FROM staff_store_roles WHERE store_id = '${STORE_B}'::uuid;
DELETE FROM staffs WHERE id = '${STAFF_B}'::uuid;
DELETE FROM stores WHERE id = '${STORE_B}'::uuid;
COMMIT;

INSERT INTO orgs (id, code, name, created_at, updated_at)
VALUES ('${ORG_B}'::uuid, 'rls-smoke-b', 'RLS Smoke B', now(), now())
ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, updated_at = EXCLUDED.updated_at;

BEGIN;
SET LOCAL app.org_id = '${ORG_B}';
INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
VALUES ('${STORE_B}'::uuid, '${ORG_B}'::uuid, 'rls-b', 'RLS Smoke B', 'Asia/Shanghai', now(), now())
ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, updated_at = EXCLUDED.updated_at;
INSERT INTO staffs (id, org_id, username, password_hash, display_name, is_active, permission_version, created_at, updated_at)
VALUES ('${STAFF_B}'::uuid, '${ORG_B}'::uuid, 'rls-smoke-b', 'not-a-real-hash', 'RLS Smoke B', true, 1, now(), now())
ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at;
COMMIT;
SQL
}

assert_tenant_isolation() {
  local own other
  own="$(psql_app <<SQL
BEGIN;
SET LOCAL app.org_id = '${ORG_A}';
SELECT count(*)::text FROM staffs WHERE id = '${STAFF_A}'::uuid;
COMMIT;
SQL
  )"
  own="$(printf '%s\n' "${own}" | tail -n 1)"
  [[ "${own}" == '1' ]] || die "tenant A cannot see its own seeded staff"

  other="$(psql_app <<SQL
BEGIN;
SET LOCAL app.org_id = '${ORG_B}';
SELECT count(*)::text FROM staffs WHERE id = '${STAFF_A}'::uuid;
COMMIT;
SQL
  )"
  other="$(printf '%s\n' "${other}" | tail -n 1)"
  [[ "${other}" == '0' ]] || die "tenant B observed tenant A row"
  pass "tenant A/B isolation holds under laundry_app"
}

assert_no_bypass() {
  local output
  if output="$(psql_app <<'SQL' 2>&1
SET row_security = off;
SELECT count(*) FROM staffs;
SQL
  )"; then
    die "laundry_app disabled row_security: ${output}"
  fi
  printf '%s\n' "${output}" | grep -Eq 'row-level security|query would be affected' \
    || die "unexpected row_security failure: ${output}"
  pass "laundry_app cannot disable or bypass RLS"
}

main() {
  cd "${SCRIPT_DIR}"
  require_tables
  assert_default_closed
  seed_second_tenant
  assert_tenant_isolation
  assert_no_bypass
  pass "real PostgreSQL RLS smoke passed"
}

main "$@"

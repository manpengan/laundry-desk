#!/usr/bin/env bash
# Real PostgreSQL RLS smoke. A superuser creates the second global organization,
# while every isolation and permission assertion runs as laundry_app so a passing
# result cannot be a BYPASSRLS false positive.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${LAUNDRY_COMPOSE_FILE:-${SCRIPT_DIR}/docker-compose.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-laundry-desk}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-8543}"
PGDATABASE="${PGDATABASE:-laundry_v2}"
LAUNDRY_APP_USER="${LAUNDRY_APP_USER:-laundry_app}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"

die() {
  echo "❌ [smoke-rls] $*" >&2
  exit 1
}

pass() {
  echo "✔ [smoke-rls] $*"
}

validate_local_target() {
  [[ "${COMPOSE_FILE}" == "${SCRIPT_DIR}/docker-compose.yml" ]] ||
    die "compose file must be the local lifecycle definition"
  [[ ${#COMPOSE_PROJECT_NAME} -le 63 ]] &&
    [[ "${COMPOSE_PROJECT_NAME}" =~ ^laundry-[a-z0-9]([a-z0-9_-]*[a-z0-9])?$ ]] ||
    die "invalid local Compose project"
  [[ "${PGHOST}" == "127.0.0.1" ]] || die "PGHOST must be local loopback"
  [[ -z "${PGHOSTADDR-}" ]] || die "PGHOSTADDR must not override local loopback"
  [[ -z "${PGSERVICE-}" ]] || die "PGSERVICE must not override the local connection"
  [[ -z "${PGSERVICEFILE-}" ]] || die "PGSERVICEFILE must not override the local connection"
  [[ "${PGPORT}" == "8543" ]] || die "PGPORT must be the local published port"
  [[ "${PGDATABASE}" == "laundry_v2" ]] || die "PGDATABASE must be the local database"
  [[ "${LAUNDRY_APP_USER}" == "laundry_app" ]] || die "application role must be local"
  [[ "${POSTGRES_USER}" == "postgres" ]] || die "administrator role must be local"
}

validate_local_target

APP_PASSWORD_VALUE="${LAUNDRY_APP_PASSWORD-}"
ADMIN_PASSWORD_VALUE="${POSTGRES_PASSWORD-}"
CONFIG_PASSWORDS=""
export -n APP_PASSWORD_VALUE ADMIN_PASSWORD_VALUE CONFIG_PASSWORDS 2>/dev/null || true
unset \
  LAUNDRY_APP_PASSWORD \
  POSTGRES_PASSWORD \
  DATABASE_URL \
  DATABASE_ADMIN_URL \
  SUPERUSER_DATABASE_URL \
  LAUNDRY_PG_APP_URL \
  PGPASSWORD \
  PGPASSFILE \
  PGHOSTADDR \
  PGSERVICE \
  PGSERVICEFILE \
  LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD \
  LAUNDRY_BOOTSTRAP_ADMIN_PIN \
  LAUNDRY_ACCESS_TOKEN_SECRET \
  LAUNDRY_CSRF_PROOF_SECRET

if [[ -z "${APP_PASSWORD_VALUE}" && -z "${ADMIN_PASSWORD_VALUE}" ]]; then
  CONFIG_PASSWORDS="$(
    node --input-type=module - "${SCRIPT_DIR}/../local/config.mjs" <<'NODE'
import { pathToFileURL } from "node:url";

const modulePath = process.argv.at(-1);
const { loadLocalConfig } = await import(pathToFileURL(modulePath).href);
const config = await loadLocalConfig({ env: process.env });
process.stdout.write(`${config.postgresAppPassword}\n${config.postgresSuperuserPassword}`);
NODE
  )" || {
    echo "❌ [smoke-rls] generated local database config is required" >&2
    exit 1
  }
  if [[ "${CONFIG_PASSWORDS}" != *$'\n'* ]]; then
    echo "❌ [smoke-rls] generated local database config is invalid" >&2
    exit 1
  fi
  APP_PASSWORD_VALUE="${CONFIG_PASSWORDS%%$'\n'*}"
  ADMIN_PASSWORD_VALUE="${CONFIG_PASSWORDS#*$'\n'}"
  unset CONFIG_PASSWORDS
elif [[ -z "${APP_PASSWORD_VALUE}" || -z "${ADMIN_PASSWORD_VALUE}" ]]; then
  echo "❌ [smoke-rls] both app and superuser database passwords are required" >&2
  exit 1
fi

ORG_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
STAFF_A="11111111-1111-4111-8111-111111111103"
ORG_B="cccccccc-cccc-4ccc-8ccc-cccccccccccc"
STORE_B="dddddddd-dddd-4ddd-8ddd-dddddddddddd"
STAFF_B="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

compose_postgres_container() {
  docker compose -p "${COMPOSE_PROJECT_NAME}" -f "${COMPOSE_FILE}" ps -q postgres 2>/dev/null
}

container_running() {
  local container
  container="$(compose_postgres_container)"
  [[ -n "${container}" ]] &&
    docker inspect -f '{{.State.Running}}' "${container}" 2>/dev/null | grep -qx true
}

pgpass_escape() {
  local value
  export -n value 2>/dev/null || true
  value="$1"
  [[ "${value}" != *$'\n'* && "${value}" != *$'\r'* ]] ||
    die "PostgreSQL connection fields cannot contain line breaks"
  value="${value//\\/\\\\}"
  value="${value//:/\\:}"
  printf '%s' "${value}"
}

create_pgpass_file() {
  local host="$1"
  local port="$2"
  local user="$3"
  local password
  local escaped_host escaped_port escaped_database escaped_user escaped_password
  local passfile=""
  export -n password escaped_password 2>/dev/null || true
  password="$4"
  escaped_host="$(pgpass_escape "${host}")" || return 1
  escaped_port="$(pgpass_escape "${port}")" || return 1
  escaped_database="$(pgpass_escape "${PGDATABASE}")" || return 1
  escaped_user="$(pgpass_escape "${user}")" || return 1
  escaped_password="$(pgpass_escape "${password}")" || return 1
  passfile="$(mktemp "${TMPDIR:-/tmp}/laundry-smoke-pgpass.XXXXXX")"
  if ! chmod 600 "${passfile}" ||
    ! printf '%s:%s:%s:%s:%s\n' \
      "${escaped_host}" \
      "${escaped_port}" \
      "${escaped_database}" \
      "${escaped_user}" \
      "${escaped_password}" >"${passfile}"; then
    rm -f -- "${passfile}"
    return 1
  fi
  printf '%s\n' "${passfile}"
}

run_host_psql() (
  local user="$1"
  local password
  export -n password 2>/dev/null || true
  password="$2"
  shift 2
  local passfile=""
  passfile="$(create_pgpass_file "${PGHOST}" "${PGPORT}" "${user}" "${password}")" || exit 1
  cleanup_host_pgpass() {
    rm -f -- "${passfile}"
  }
  trap cleanup_host_pgpass EXIT
  PGPASSFILE="${passfile}" psql --no-password \
    -h "${PGHOST}" -p "${PGPORT}" -U "${user}" -d "${PGDATABASE}" "$@"
)

run_container_psql() (
  local container="$1"
  local user="$2"
  local password
  export -n password 2>/dev/null || true
  password="$3"
  shift 3
  local host_passfile="" container_passfile=""
  host_passfile="$(create_pgpass_file "127.0.0.1" "5432" "${user}" "${password}")" || exit 1
  container_passfile="/tmp/$(basename "${host_passfile}")"
  cleanup_container_pgpass() {
    docker exec "${container}" sh -c 'rm -f -- "$1"' sh "${container_passfile}" \
      >/dev/null 2>&1 || true
    rm -f -- "${host_passfile}"
  }
  trap cleanup_container_pgpass EXIT
  docker cp "${host_passfile}" "${container}:${container_passfile}" >/dev/null
  docker exec "${container}" chmod 600 "${container_passfile}"
  docker exec -i -e PGPASSFILE="${container_passfile}" "${container}" \
    psql --no-password -h 127.0.0.1 -p 5432 -U "${user}" -d "${PGDATABASE}" "$@"
)

psql_app() {
  if command -v psql >/dev/null 2>&1; then
    run_host_psql "${LAUNDRY_APP_USER}" "${APP_PASSWORD_VALUE}" \
      -v ON_ERROR_STOP=1 -X -q -At "$@"
    return
  fi
  if container_running; then
    local container
    container="$(compose_postgres_container)"
    run_container_psql "${container}" "${LAUNDRY_APP_USER}" "${APP_PASSWORD_VALUE}" \
      -v ON_ERROR_STOP=1 -X -q -At "$@"
    return
  fi
  die "need host psql or a running compose postgres service"
}

psql_admin() {
  if command -v psql >/dev/null 2>&1; then
    run_host_psql "${POSTGRES_USER}" "${ADMIN_PASSWORD_VALUE}" -v ON_ERROR_STOP=1 -X -q -At "$@"
    return
  fi
  if container_running; then
    local container
    container="$(compose_postgres_container)"
    run_container_psql "${container}" "${POSTGRES_USER}" "${ADMIN_PASSWORD_VALUE}" \
      -v ON_ERROR_STOP=1 -X -q -At "$@"
    return
  fi
  die "need host psql or a running compose postgres service"
}

require_tables() {
  local expected=(
    laundry_schema_migrations orgs stores staffs staff_store_roles settings store_features audit_log
    sessions refresh_families refresh_tokens pin_challenges pin_lockouts orders order_lines garments
    ticket_counters catalog_items payments print_jobs customers shift_closings garment_photos
    garment_status_log garment_incidents
  )
  local table
  for table in "${expected[@]}"; do
    local found
    found="$(psql_app -c "SELECT to_regclass('public.${table}')::text")"
    [[ "${found}" == "${table}" ]] || die "missing formal table: ${table}"
  done
  pass "all formal migrations (0001–0026) are present"
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
  psql_admin <<SQL
INSERT INTO orgs (id, code, name, created_at, updated_at)
VALUES ('${ORG_B}'::uuid, 'rls-smoke-b', 'RLS Smoke B', now(), now())
ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, updated_at = EXCLUDED.updated_at;
SQL

  psql_app <<SQL
BEGIN;
SET LOCAL app.org_id = '${ORG_B}';
DELETE FROM staff_store_roles WHERE store_id = '${STORE_B}'::uuid;
DELETE FROM staffs WHERE id = '${STAFF_B}'::uuid;
DELETE FROM stores WHERE id = '${STORE_B}'::uuid;
COMMIT;

BEGIN;
SET LOCAL app.org_id = '${ORG_B}';
INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
VALUES ('${STORE_B}'::uuid, '${ORG_B}'::uuid, 'rls-b', 'RLS Smoke B', 'Asia/Taipei', now(), now())
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

assert_org_writes_denied() {
  local output
  if output="$(psql_app -c "UPDATE orgs SET name = name WHERE id = '${ORG_A}'::uuid" 2>&1)"; then
    die "laundry_app retained UPDATE on global organizations"
  fi
  printf '%s\n' "${output}" | grep -Eq 'permission denied.*orgs' \
    || die "unexpected organization write failure: ${output}"

  if output="$(
    psql_app -c \
      "INSERT INTO orgs (id, code, name) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid, 'forbidden', 'Forbidden')" \
      2>&1
  )"; then
    die "laundry_app retained INSERT on global organizations"
  fi
  printf '%s\n' "${output}" | grep -Eq 'permission denied.*orgs' \
    || die "unexpected organization insert failure: ${output}"
  pass "laundry_app cannot insert or update global organizations"
}

assert_runtime_ddl_denied() {
  local output
  if output="$(psql_app -c "CREATE TEMPORARY TABLE forbidden_runtime_temp (id integer)" 2>&1)"; then
    die "laundry_app retained database TEMPORARY privilege"
  fi
  printf '%s\n' "${output}" | grep -Eq 'permission denied.*temporary.*database' \
    || die "unexpected database TEMPORARY failure: ${output}"

  if output="$(psql_app -c "CREATE SCHEMA forbidden_runtime_schema" 2>&1)"; then
    die "laundry_app retained database CREATE privilege"
  fi
  printf '%s\n' "${output}" | grep -Eq 'permission denied.*database' \
    || die "unexpected database CREATE failure: ${output}"

  if output="$(psql_app -c "CREATE TABLE public.forbidden_runtime_table (id integer)" 2>&1)"; then
    die "laundry_app retained public schema CREATE privilege"
  fi
  printf '%s\n' "${output}" | grep -Eq 'permission denied.*schema' \
    || die "unexpected public schema CREATE failure: ${output}"
  pass "laundry_app cannot create temporary, database, or public-schema objects"
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
  assert_org_writes_denied
  assert_runtime_ddl_denied
  assert_no_bypass
  pass "real PostgreSQL RLS smoke passed"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
